import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import QRCode from 'qrcode';
import db from '../db.js';

// Initialize Razorpay instance (Test Mode keys are free)
const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';

let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
  razorpay = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret,
  });
}

// Helper: get full payment + order details for response
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

export default async function paymentRoutes(fastify) {

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
          amount: Math.round(order.total * 100),
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
    if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
      if (!razorpayKeySecret) {
        return reply.status(500).send({ message: 'Payment gateway not configured on server' });
      }

      // Validate razorpay_order_id matches what we stored
      if (payment.razorpay_order_id && payment.razorpay_order_id !== razorpay_order_id) {
        return reply.status(400).send({ message: 'Razorpay order ID mismatch' });
      }

      const expectedSignature = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(razorpay_signature, 'hex'))) {
        db.prepare(
          `UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
        ).run(paymentId);
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
  fastify.post('/webhook', async (request, reply) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || razorpayKeySecret;
    if (!webhookSecret) {
      return reply.status(500).send({ status: 'not_configured' });
    }

    const receivedSignature = request.headers['x-razorpay-signature'];
    if (!receivedSignature) {
      return reply.status(400).send({ status: 'missing_signature' });
    }

    let isValid = false;
    try {
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(request.body))
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
      return reply.status(400).send({ status: 'invalid_signature' });
    }

    const event = request.body?.event;
    const payload = request.body?.payload;

    if (!event || !payload) {
      return reply.status(400).send({ status: 'malformed_payload' });
    }

    if (event === 'payment.captured') {
      const rzpPayment = payload.payment?.entity;
      if (!rzpPayment?.order_id) return { status: 'ok' };

      const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(rzpPayment.order_id);
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
      if (!rzpPayment?.order_id) return { status: 'ok' };

      const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(rzpPayment.order_id);
      if (payment && payment.status === 'pending') {
        db.prepare(
          `UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
        ).run(payment.id);
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
