import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { sendToUser } from '../ws.js';

const PLATFORM_FEE_RATE = 0.0102; // 1.02% - default fallback

function getPlatformFeeRate() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'platform_fee_rate'").get();
    return row ? Number(row.value) / 100 : PLATFORM_FEE_RATE;
  } catch {
    return PLATFORM_FEE_RATE;
  }
}

function getExtraFees() {
  try {
    const rows = db.prepare("SELECT key, value, label FROM settings WHERE key LIKE 'extra_fee_%' OR key LIKE 'custom_fee_%'").all();
    const fees = [];
    // Group by label/amount pairs
    const labelRow = rows.find(r => r.key === 'extra_fee_label');
    const amountRow = rows.find(r => r.key === 'extra_fee_amount');
    if (labelRow && labelRow.value && amountRow && Number(amountRow.value) > 0) {
      fees.push({ label: labelRow.value, amount: Number(amountRow.value) });
    }
    // Custom fees
    for (const r of rows) {
      if (r.key.startsWith('custom_fee_') && !r.key.endsWith('_label')) {
        fees.push({ label: r.label, amount: Number(r.value) });
      }
    }
    return fees;
  } catch {
    return [];
  }
}

export default async function orderRoutes(fastify) {
  // POST /api/orders — place order (authenticated)
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { items, address, scheduled_date, scheduled_time, coupon_code } = request.body;
    const customerId = request.user.id;

    if (!items || items.length === 0) {
      return reply.status(400).send({ message: 'Order must have at least one item' });
    }

    // Calculate totals
    let subtotal = 0;
    const validItems = [];

    for (const item of items) {
      const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(item.serviceId);
      if (!service) {
        return reply.status(400).send({ message: `Service ${item.serviceId} not found or unavailable` });
      }
      const qty = item.quantity || 1;
      subtotal += service.price * qty;
      validItems.push({ service, quantity: qty });
    }

    // Validate and apply coupon
    let discountAmount = 0;
    let appliedCode = null;

    if (coupon_code) {
      const offer = db.prepare(`
        SELECT * FROM offers
        WHERE code = ? AND active = 1
          AND (valid_until IS NULL OR valid_until >= datetime('now'))
      `).get(coupon_code.toUpperCase());

      if (offer) {
        const userRole = request.user.role;
        if (offer.target === 'both' || offer.target === userRole) {
          if (offer.discount_percent > 0) {
            discountAmount = Math.round((subtotal * offer.discount_percent / 100) * 100) / 100;
          }
          if (offer.discount_flat > 0) {
            discountAmount += offer.discount_flat;
          }
          discountAmount = Math.min(discountAmount, subtotal);
          appliedCode = offer.code;
        }
      }
    }

    const discountedSubtotal = subtotal - discountAmount;
    const feeRate = getPlatformFeeRate();
    const platformFee = Math.round(discountedSubtotal * feeRate * 100) / 100;
    const extraFees = getExtraFees();
    const extraFeeTotal = extraFees.reduce((sum, f) => sum + f.amount, 0);
    const total = discountedSubtotal + platformFee + extraFeeTotal;
    const orderId = uuidv4();

    // Insert order
    db.prepare(`
      INSERT INTO orders (id, customer_id, status, subtotal, platform_fee, discount_amount, coupon_code, total, address, scheduled_date, scheduled_time)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, customerId, subtotal, platformFee, discountAmount, appliedCode, total, JSON.stringify(address), scheduled_date, scheduled_time);

    // Insert order items
    const insertItem = db.prepare('INSERT INTO order_items (order_id, service_id, quantity, price) VALUES (?, ?, ?, ?)');
    for (const vi of validItems) {
      insertItem.run(orderId, vi.service.id, vi.quantity, vi.service.price);
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const orderItems = db.prepare(`
      SELECT oi.*, s.name as service_name
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `).all(orderId);

    return reply.status(201).send({
      order: { ...order, address: JSON.parse(order.address || '{}'), items: orderItems },
    });
  });

  // GET /api/orders — list orders (authenticated)
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request) => {
    const userId = request.user.id;
    const role = request.user.role;

    let orders;
    if (role === 'admin') {
      orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    } else if (role === 'provider') {
      // Show orders that contain services by this provider
      orders = db.prepare(`
        SELECT DISTINCT o.*
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN services s ON oi.service_id = s.id
        WHERE s.provider_id = ?
        ORDER BY o.created_at DESC
      `).all(userId);
    } else {
      orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(userId);
    }

    // Attach items to each order
    const getItems = db.prepare(`
      SELECT oi.*, s.name as service_name, s.image, s.description
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `);

    const getMeeting = db.prepare(
      'SELECT * FROM meeting_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1'
    );

    const enriched = orders.map((o) => ({
      ...o,
      address: o.address ? JSON.parse(o.address) : {},
      items: getItems.all(o.id),
      meeting: getMeeting.get(o.id) || null,
    }));

    return { orders: enriched };
  });

  // GET /api/orders/:id — single order
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    // Check authorization
    const isProvider = db.prepare(`
      SELECT 1 FROM order_items oi
      JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ? AND s.provider_id = ?
    `).get(order.id, request.user.id);

    if (order.customer_id !== request.user.id && !isProvider && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    const items = db.prepare(`
      SELECT oi.*, s.name as service_name, s.image, s.description
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `).all(order.id);

    const meeting = db.prepare(
      'SELECT * FROM meeting_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1'
    ).get(order.id);

    return { order: { ...order, address: JSON.parse(order.address || '{}'), items, meeting: meeting || null } };
  });

  // PATCH /api/orders/:id/status — update order status (provider/admin)
  fastify.patch('/:id/status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { status } = request.body;
    const validStatuses = ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, request.params.id);

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    return { order: updated };
  });

  // ─── Meeting-link flow ──────────────────────────────────────

  // POST /api/orders/:id/meeting/request — customer requests a meeting
  fastify.post('/:id/meeting/request', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const orderId = request.params.id;
    const customerId = request.user.id;
    const { message } = request.body || {};

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return reply.status(404).send({ message: 'Order not found' });
    if (order.customer_id !== customerId) {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    // Find the provider for this order from order_items → services → provider_id
    const providerRow = db.prepare(`
      SELECT DISTINCT s.provider_id
      FROM order_items oi
      JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ? AND s.provider_id IS NOT NULL
      LIMIT 1
    `).get(orderId);

    if (!providerRow) {
      return reply.status(400).send({ message: 'No provider found for this order' });
    }

    const providerId = providerRow.provider_id;

    // Check if there's already an active meeting request
    const existing = db.prepare(
      "SELECT * FROM meeting_requests WHERE order_id = ? AND status IN ('requested', 'link_shared')"
    ).get(orderId);

    if (existing) {
      return reply.status(400).send({ message: 'Meeting already requested', meeting: existing });
    }

    db.prepare(`
      INSERT INTO meeting_requests (order_id, customer_id, provider_id, status, message)
      VALUES (?, ?, ?, 'requested', ?)
    `).run(orderId, customerId, providerId, message || null);

    db.prepare("UPDATE orders SET meeting_requested = 1, updated_at = datetime('now') WHERE id = ?")
      .run(orderId);

    const meeting = db.prepare(
      'SELECT * FROM meeting_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1'
    ).get(orderId);

    // Notify provider via WebSocket
    const customer = db.prepare('SELECT name FROM users WHERE id = ?').get(customerId);
    sendToUser(providerId, 'MEETING_REQUESTED', {
      orderId,
      meeting,
      customerName: customer?.name || 'Customer',
    });

    return reply.status(201).send({ meeting });
  });

  // POST /api/orders/:id/meeting/link — provider shares meeting link
  fastify.post('/:id/meeting/link', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const orderId = request.params.id;
    const providerId = request.user.id;
    const { meeting_link, meeting_time, meeting_date } = request.body;

    if (!meeting_link) {
      return reply.status(400).send({ message: 'Meeting link is required' });
    }

    const meeting = db.prepare(
      "SELECT * FROM meeting_requests WHERE order_id = ? AND provider_id = ? AND status = 'requested'"
    ).get(orderId, providerId);

    if (!meeting) {
      return reply.status(404).send({ message: 'No pending meeting request found' });
    }

    db.prepare(`
      UPDATE meeting_requests
      SET meeting_link = ?, meeting_time = ?, meeting_date = ?, status = 'link_shared', updated_at = datetime('now')
      WHERE id = ?
    `).run(meeting_link, meeting_time || null, meeting_date || null, meeting.id);

    const updated = db.prepare('SELECT * FROM meeting_requests WHERE id = ?').get(meeting.id);

    // Notify customer via WebSocket
    const provider = db.prepare('SELECT name FROM users WHERE id = ?').get(providerId);
    sendToUser(meeting.customer_id, 'MEETING_LINK_SHARED', {
      orderId,
      meeting: updated,
      providerName: provider?.name || 'Provider',
    });

    return { meeting: updated };
  });

  // GET /api/orders/:id/meeting — get meeting info for an order
  fastify.get('/:id/meeting', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const orderId = request.params.id;
    const userId = request.user.id;

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    // Allow customer, provider, or admin
    const isProvider = db.prepare(`
      SELECT 1 FROM order_items oi
      JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ? AND s.provider_id = ?
    `).get(orderId, userId);

    if (order.customer_id !== userId && !isProvider && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    const meeting = db.prepare(
      'SELECT * FROM meeting_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1'
    ).get(orderId);

    return { meeting: meeting || null };
  });
}
