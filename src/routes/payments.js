import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import db from '../db.js';

// UPI config — set your UPI ID in environment
// MERCHANT_UPI_ID=yourupi@bank
// MERCHANT_NAME=GFuture

export default async function paymentRoutes(fastify) {
  // POST /api/payments/initiate — Create payment & generate UPI QR
  fastify.post('/initiate', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { orderId } = request.body;

    if (!orderId) {
      return reply.status(400).send({ message: 'Order ID is required' });
    }

    // Verify order belongs to user
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    // Check if payment already exists for this order
    const existing = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
    if (existing && existing.status === 'completed') {
      return reply.status(400).send({ message: 'Payment already completed for this order' });
    }

    // Use existing pending payment or create new
    const paymentId = existing?.id || uuidv4();

    if (!existing) {
      db.prepare(
        'INSERT INTO payments (id, order_id, amount, status) VALUES (?, ?, ?, ?)'
      ).run(paymentId, orderId, order.total, 'pending');
    }

    // Generate UPI payment link
    const merchantUPI = process.env.MERCHANT_UPI_ID || 'gfuture@upi';
    const merchantName = process.env.MERCHANT_NAME || 'GFuture';
    const amount = order.total.toFixed(2);
    const transactionNote = `GFuture-${orderId.substring(0, 8)}`;

    // UPI deep link format
    const upiLink = `upi://pay?pa=${encodeURIComponent(merchantUPI)}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${encodeURIComponent(transactionNote)}&tr=${paymentId}`;

    // Generate QR code as data URL
    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(upiLink, {
        width: 300,
        margin: 2,
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
      },
    };
  });

  // POST /api/payments/verify — Verify/confirm payment (manual or webhook)
  fastify.post('/verify', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { paymentId, transactionRef } = request.body;

    if (!paymentId) {
      return reply.status(400).send({ message: 'Payment ID is required' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      return reply.status(404).send({ message: 'Payment not found' });
    }

    // Mark payment as completed
    db.prepare(
      `UPDATE payments 
       SET status = 'completed', transaction_ref = ?, paid_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(transactionRef || `TXN-${Date.now()}`, paymentId);

    // Update order status to confirmed
    db.prepare(
      `UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`
    ).run(payment.order_id);

    const updatedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);

    return {
      payment: updatedPayment,
      message: 'Payment verified successfully',
    };
  });

  // GET /api/payments/:orderId — Get payment status for an order
  fastify.get('/:orderId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(request.params.orderId);
    if (!payment) {
      return reply.status(404).send({ message: 'No payment found for this order' });
    }

    // Auth check
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    return { payment };
  });
}
