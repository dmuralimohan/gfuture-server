import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import QRCode from 'qrcode';
import db from '../db.js';

// Initialize Razorpay instance (Test Mode keys are free)
// Dynamic import so server doesn't crash if razorpay package isn't installed
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const MIN_RAZORPAY_AMOUNT_PAISE = 100;

let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
  try {
    const { default: Razorpay } = await import('razorpay');
    razorpay = new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret,
    });
  } catch {
    console.warn('⚠️  razorpay package not installed — falling back to UPI QR mode. Run: npm install razorpay');
  }
}

function getPaymentDetails(paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
  const items = db.prepare(`
    SELECT oi.*, s.name as service_name, s.image
    FROM order_items oi
    LEFT JOIN services s ON oi.service_id = s.id
    WHERE oi.order_id = ?
  `).all(payment.order_id);
  const customer = order ? db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(order.customer_id) : null;
  return {
    ...payment,
    order: order ? { ...order, address: order.address ? JSON.parse(order.address) : {} } : null,
    items,
    customer,
  };
}

function createPaymentAlert({
  type,
  severity = 'medium',
  source = 'system',
  paymentId = null,
  orderId = null,
  message,
  metadata = null,
  fingerprint,
}) {
  const baseFingerprint = fingerprint || `${type}|${paymentId || ''}|${orderId || ''}|${message}`;
  const safeFingerprint = crypto.createHash('sha256').update(baseFingerprint).digest('hex');

  db.prepare(
    `INSERT OR IGNORE INTO payment_alerts
     (id, type, severity, source, payment_id, order_id, message, metadata, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    type,
    severity,
    source,
    paymentId,
    orderId,
    message,
    metadata ? JSON.stringify(metadata) : null,
    safeFingerprint
  );
}

export default async function paymentRoutes(fastify) {

  // ─── POST /api/payments/create-order ───
  // Standard Razorpay order creation endpoint for web/mobile clients.
  fastify.post('/create-order', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body || {};
    const amount = Number(body.amount);
    const currency = body.currency || 'INR';
    const receipt = body.receipt || `rcpt_${Date.now()}`;

    if (!Number.isFinite(amount) || amount < MIN_RAZORPAY_AMOUNT_PAISE) {
      return reply.status(400).send({ message: `Amount must be at least ${MIN_RAZORPAY_AMOUNT_PAISE} paise` });
    }

    if (!razorpay) {
      return reply.status(500).send({ message: 'Payment gateway not configured on server' });
    }

    try {
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(amount),
        currency,
        receipt,
      });

      return {
        order_id: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
      };
    } catch (err) {
      const statusCode = err?.statusCode || err?.status || err?.error?.status_code;
      if (statusCode === 401) {
        return reply.status(401).send({ message: 'Razorpay authentication failed' });
      }
      fastify.log.error('Razorpay create-order failed:', err);
      return reply.status(500).send({ message: 'Failed to create Razorpay order' });
    }
  });

  // ─── POST /api/payments/verify-payment ───
  fastify.post('/verify-payment', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body || {};
    const orderId = body.razorpay_order_id || body.order_id;
    const paymentId = body.razorpay_payment_id || body.payment_id;
    const signature = body.razorpay_signature || body.signature;

    if (!orderId || !paymentId || !signature) {
      return reply.status(400).send({ message: 'order_id, payment_id and razorpay_signature are required' });
    }

    if (!razorpayKeySecret) {
      return reply.status(500).send({ message: 'Payment gateway not configured on server' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const signaturesMatch =
      expectedSignature.length === signature.length
      && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

    if (!signaturesMatch) {
      return reply.status(400).send({ message: 'Signature mismatch' });
    }

    return { success: true, message: 'Payment signature verified successfully' };
  });

  // ─── POST /api/payments/initiate ───
  fastify.post('/initiate', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { orderId } = request.body;

    if (!orderId || typeof orderId !== 'string') {
      return reply.status(400).send({ message: 'Valid Order ID is required' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }
    if (order.status === 'cancelled') {
      return reply.status(400).send({ message: 'Cannot pay for a cancelled order' });
    }

    const existing = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
    if (existing && existing.status === 'completed') {
      return reply.status(400).send({ message: 'Payment already completed for this order' });
    }

    // Prevent paying if amount is zero or negative
    if (!order.total || order.total <= 0) {
      return reply.status(400).send({ message: 'Order total must be greater than zero' });
    }

    const paymentId = existing?.id || uuidv4();

    // Get order breakdown for response
    const items = db.prepare(`
      SELECT oi.*, s.name as service_name, s.image
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `).all(orderId);
    const customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(order.customer_id);

    const orderBreakdown = {
      subtotal: order.subtotal,
      discount_amount: order.discount_amount || 0,
      coupon_code: order.coupon_code || null,
      platform_fee: order.platform_fee,
      total: order.total,
      items: items.map(i => ({ name: i.service_name, qty: i.quantity, price: i.price, image: i.image })),
    };

    // ── Razorpay Mode ──
    if (razorpay) {
      try {
        const amountPaise = Math.round(Number(order.total || 0) * 100);
        if (amountPaise < MIN_RAZORPAY_AMOUNT_PAISE) {
          return reply.status(400).send({ message: `Order total must be at least ${MIN_RAZORPAY_AMOUNT_PAISE} paise` });
        }

        // Reuse existing pending Razorpay order
        if (existing?.razorpay_order_id && existing.status === 'pending') {
          return {
            payment: {
              id: existing.id,
              orderId,
              amount: order.total,
              status: 'pending',
              razorpayOrderId: existing.razorpay_order_id,
              razorpayKeyId,
              method: 'razorpay',
              breakdown: orderBreakdown,
              customerName: customer?.name || '',
              customerEmail: customer?.email || '',
              customerPhone: customer?.phone || '',
            },
          };
        }

        // Create Razorpay order
        const rzpOrder = await razorpay.orders.create({
          amount: amountPaise,
          currency: 'INR',
          receipt: `rcpt_${orderId.substring(0, 20)}`,
          payment_capture: 1, // auto-capture payments
          notes: {
            internalPaymentId: paymentId,
            orderId,
            customerName: customer?.name || '',
            itemsSummary: items.map(i => i.service_name).join(', ').substring(0, 200),
          },
        });

        if (!existing) {
          db.prepare(
            `INSERT INTO payments (id, order_id, amount, status, method, razorpay_order_id) 
             VALUES (?, ?, ?, 'pending', 'razorpay', ?)`
          ).run(paymentId, orderId, order.total, rzpOrder.id);
        } else {
          db.prepare(
            `UPDATE payments SET razorpay_order_id = ?, method = 'razorpay', status = 'pending', updated_at = datetime('now') WHERE id = ?`
          ).run(rzpOrder.id, paymentId);
        }

        return {
          payment: {
            id: paymentId,
            orderId,
            amount: order.total,
            status: 'pending',
            razorpayOrderId: rzpOrder.id,
            razorpayKeyId,
            method: 'razorpay',
            breakdown: orderBreakdown,
            customerName: customer?.name || '',
            customerEmail: customer?.email || '',
            customerPhone: customer?.phone || '',
          },
        };
      } catch (err) {
        fastify.log.error('Razorpay order creation failed:', err);
        return reply.status(500).send({ message: 'Failed to create payment order. Please try again.' });
      }
    }

    // ── Fallback: UPI QR ──
    if (!existing) {
      db.prepare(
        'INSERT INTO payments (id, order_id, amount, status, method) VALUES (?, ?, ?, ?, ?)'
      ).run(paymentId, orderId, order.total, 'pending', 'upi');
    }

    const merchantUPI = process.env.MERCHANT_UPI_ID || 'gfuture@upi';
    const merchantName = process.env.MERCHANT_NAME || 'GFuture';
    const amount = order.total.toFixed(2);
    const transactionNote = `GFuture-${orderId.substring(0, 8)}`;

    const upiLink = `upi://pay?pa=${encodeURIComponent(merchantUPI)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(transactionNote)}&tr=${paymentId}`;

    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(upiLink, {
        width: 300, margin: 2,
        color: { dark: '#0a1628', light: '#ffffff' },
        errorCorrectionLevel: 'H',
      });
    } catch (err) {
      fastify.log.error('QR generation failed:', err);
      return reply.status(500).send({ message: 'Failed to generate QR code' });
    }

    return {
      payment: {
        id: paymentId,
        orderId,
        amount: order.total,
        status: 'pending',
        upiLink,
        qrCode: qrDataUrl,
        merchantName,
        merchantUPI,
        method: 'upi',
        breakdown: orderBreakdown,
      },
    };
  });

  // ─── POST /api/payments/verify ───
  fastify.post('/verify', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature, transactionRef } = request.body;

    if (!paymentId || typeof paymentId !== 'string') {
      return reply.status(400).send({ message: 'Valid Payment ID is required' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return reply.status(404).send({ message: 'Payment not found' });
    }

    // Ownership check
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    if (!order) {
      return reply.status(404).send({ message: 'Associated order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    if (payment.status === 'completed') {
      const details = getPaymentDetails(paymentId);
      return { payment: details, message: 'Payment already verified' };
    }

    if (payment.status === 'failed') {
      return reply.status(400).send({ message: 'Payment has failed. Please initiate a new payment.' });
    }

    // ── Razorpay Verification ──
    if (payment.method === 'razorpay') {
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return reply.status(400).send({
          message: 'Razorpay verification payload required for this payment',
        });
      }

      if (!razorpayKeySecret) {
        return reply.status(500).send({ message: 'Payment gateway not configured on server' });
      }

      // Validate razorpay_order_id matches what we stored
      if (payment.razorpay_order_id && payment.razorpay_order_id !== razorpay_order_id) {
        createPaymentAlert({
          type: 'verify_order_id_mismatch',
          severity: 'high',
          source: 'verify',
          paymentId,
          orderId: payment.order_id,
          message: 'Razorpay order ID mismatch in verify request',
          metadata: {
            expected_razorpay_order_id: payment.razorpay_order_id,
            received_razorpay_order_id: razorpay_order_id,
          },
        });
        return reply.status(400).send({ message: 'Razorpay order ID mismatch' });
      }

      const expectedSignature = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      const signaturesMatch =
        expectedSignature.length === razorpay_signature.length
        && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpay_signature));

      if (!signaturesMatch) {
        db.prepare(
          `UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
        ).run(paymentId);
        createPaymentAlert({
          type: 'verify_signature_invalid',
          severity: 'high',
          source: 'verify',
          paymentId,
          orderId: payment.order_id,
          message: 'Invalid Razorpay signature during payment verify',
        });
        return reply.status(400).send({ message: 'Payment verification failed — invalid signature. Please contact support.' });
      }

      // Signature valid
      db.prepare(
        `UPDATE payments 
         SET status = 'completed', 
             razorpay_payment_id = ?, 
             razorpay_signature = ?,
             transaction_ref = ?,
             paid_at = datetime('now'), 
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(razorpay_payment_id, razorpay_signature, razorpay_payment_id, paymentId);

      db.prepare(
        `UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`
      ).run(payment.order_id);

      const details = getPaymentDetails(paymentId);
      return { payment: details, message: 'Payment verified successfully' };
    }

    if (payment.method !== 'upi') {
      return reply.status(400).send({
        message: `Unsupported manual verification method: ${payment.method || 'unknown'}`,
      });
    }

    // ── Manual UPI Verification ──
    const txnRef = transactionRef?.trim() || `TXN-${Date.now()}`;
    db.prepare(
      `UPDATE payments 
       SET status = 'completed', transaction_ref = ?, paid_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(txnRef, paymentId);

    db.prepare(
      `UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`
    ).run(payment.order_id);

    const details = getPaymentDetails(paymentId);
    return { payment: details, message: 'Payment verified successfully' };
  });

  // ─── POST /api/payments/webhook ───
  fastify.post('/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      createPaymentAlert({
        type: 'webhook_secret_missing',
        severity: 'critical',
        source: 'webhook',
        message: 'Webhook called but RAZORPAY_WEBHOOK_SECRET is missing on server',
      });
      return reply.status(500).send({ status: 'not_configured' });
    }

    const signatureHeader = request.headers['x-razorpay-signature'];
    const receivedSignature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!receivedSignature || typeof receivedSignature !== 'string') {
      createPaymentAlert({
        type: 'webhook_missing_signature',
        severity: 'high',
        source: 'webhook',
        message: 'Razorpay webhook missing signature header',
      });
      return reply.status(400).send({ status: 'missing_signature' });
    }

    let isValid = false;
    try {
      const rawPayload = request.rawBody || Buffer.from(JSON.stringify(request.body || {}));
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawPayload)
        .digest('hex');
      isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      fastify.log.warn('Invalid Razorpay webhook signature');
      createPaymentAlert({
        type: 'webhook_invalid_signature',
        severity: 'high',
        source: 'webhook',
        message: 'Invalid Razorpay webhook signature',
      });
      return reply.status(400).send({ status: 'invalid_signature' });
    }

    const event = request.body?.event;
    const payload = request.body?.payload;

    if (!event || !payload) {
      createPaymentAlert({
        type: 'webhook_malformed_payload',
        severity: 'high',
        source: 'webhook',
        message: 'Razorpay webhook payload missing event or payload object',
      });
      return reply.status(400).send({ status: 'malformed_payload' });
    }

    if (event === 'payment.captured') {
      const rzpPayment = payload.payment?.entity;
      if (!rzpPayment?.order_id) {
        createPaymentAlert({
          type: 'webhook_capture_missing_order_id',
          severity: 'high',
          source: 'webhook',
          message: 'payment.captured webhook missing Razorpay order_id',
          metadata: { event },
        });
        return { status: 'ok' };
      }

      const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(rzpPayment.order_id);
      if (!payment) {
        createPaymentAlert({
          type: 'webhook_orphan_capture',
          severity: 'high',
          source: 'webhook',
          message: 'payment.captured received for unknown Razorpay order',
          metadata: {
            razorpay_order_id: rzpPayment.order_id,
            razorpay_payment_id: rzpPayment.id,
          },
          fingerprint: `orphan_capture|${rzpPayment.order_id}|${rzpPayment.id || ''}`,
        });
        return { status: 'ok' };
      }

      const expectedAmountPaise = Math.round(Number(payment.amount || 0) * 100);
      const receivedAmountPaise = Number(rzpPayment.amount || 0);
      if (expectedAmountPaise !== receivedAmountPaise) {
        createPaymentAlert({
          type: 'payment_amount_mismatch',
          severity: 'high',
          source: 'webhook',
          paymentId: payment.id,
          orderId: payment.order_id,
          message: 'Captured amount does not match local payment amount',
          metadata: {
            expected_amount_paise: expectedAmountPaise,
            received_amount_paise: receivedAmountPaise,
            razorpay_order_id: rzpPayment.order_id,
            razorpay_payment_id: rzpPayment.id,
          },
          fingerprint: `amount_mismatch|${payment.id}|${rzpPayment.id || ''}|${expectedAmountPaise}|${receivedAmountPaise}`,
        });
      }

      if (payment && payment.status !== 'completed') {
        db.prepare(
          `UPDATE payments 
           SET status = 'completed', 
               razorpay_payment_id = ?,
               transaction_ref = ?,
               method = ?,
               paid_at = datetime('now'), 
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(rzpPayment.id, rzpPayment.id, rzpPayment.method || 'razorpay', payment.id);

        db.prepare(
          `UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`
        ).run(payment.order_id);

        fastify.log.info(`Webhook: Payment ${payment.id} confirmed via ${rzpPayment.method}`);
      }
    }

    if (event === 'payment.failed') {
      const rzpPayment = payload.payment?.entity;
      if (!rzpPayment?.order_id) {
        createPaymentAlert({
          type: 'webhook_failed_missing_order_id',
          severity: 'medium',
          source: 'webhook',
          message: 'payment.failed webhook missing Razorpay order_id',
          metadata: { event },
        });
        return { status: 'ok' };
      }

      const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(rzpPayment.order_id);
      if (payment && payment.status === 'pending') {
        db.prepare(
          `UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
        ).run(payment.id);
        createPaymentAlert({
          type: 'payment_failed_webhook',
          severity: 'medium',
          source: 'webhook',
          paymentId: payment.id,
          orderId: payment.order_id,
          message: 'Razorpay reported payment.failed for pending payment',
          metadata: {
            razorpay_order_id: rzpPayment.order_id,
            razorpay_payment_id: rzpPayment.id,
            error_code: rzpPayment.error_code,
            error_description: rzpPayment.error_description,
          },
          fingerprint: `payment_failed|${payment.id}|${rzpPayment.id || ''}`,
        });
        fastify.log.info(`Webhook: Payment ${payment.id} failed`);
      }
    }

    return { status: 'ok' };
  });

  // ─── GET /api/payments/status/:paymentId ───
  fastify.get('/status/:paymentId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(request.params.paymentId);
    if (!payment) {
      return reply.status(404).send({ message: 'Payment not found' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    return { payment };
  });

  // ─── GET /api/payments/receipt/:orderId ───
  // Full receipt data for printing
  fastify.get('/receipt/:orderId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
    const items = db.prepare(`
      SELECT oi.*, s.name as service_name, s.image
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `).all(order.id);
    const customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(order.customer_id);

    return {
      receipt: {
        order: {
          id: order.id,
          status: order.status,
          subtotal: order.subtotal,
          discount_amount: order.discount_amount || 0,
          coupon_code: order.coupon_code || null,
          platform_fee: order.platform_fee,
          total: order.total,
          address: order.address ? JSON.parse(order.address) : {},
          scheduled_date: order.scheduled_date,
          scheduled_time: order.scheduled_time,
          created_at: order.created_at,
        },
        payment: payment ? {
          id: payment.id,
          method: payment.method,
          status: payment.status,
          transaction_ref: payment.transaction_ref,
          razorpay_payment_id: payment.razorpay_payment_id,
          paid_at: payment.paid_at,
        } : null,
        items,
        customer: customer || {},
      },
    };
  });

  // ─── GET /api/payments/:orderId ───
  fastify.get('/:orderId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(request.params.orderId);
    if (!payment) {
      return reply.status(404).send({ message: 'No payment found for this order' });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    return { payment };
  });
}
