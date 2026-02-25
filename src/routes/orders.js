import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

const PLATFORM_FEE_RATE = 0.0102; // 1.02%

export default async function orderRoutes(fastify) {
  // POST /api/orders — place order (authenticated)
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { items, address, scheduled_date, scheduled_time } = request.body;
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

    const platformFee = Math.round(subtotal * PLATFORM_FEE_RATE * 100) / 100;
    const total = subtotal + platformFee;
    const orderId = uuidv4();

    // Insert order
    db.prepare(`
      INSERT INTO orders (id, customer_id, status, subtotal, platform_fee, total, address, scheduled_date, scheduled_time)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(orderId, customerId, subtotal, platformFee, total, JSON.stringify(address), scheduled_date, scheduled_time);

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
      SELECT oi.*, s.name as service_name
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `);

    const enriched = orders.map((o) => ({
      ...o,
      address: o.address ? JSON.parse(o.address) : {},
      items: getItems.all(o.id),
    }));

    return { orders: enriched };
  });

  // GET /api/orders/:id — single order
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    // Check authorization
    if (order.customer_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    const items = db.prepare(`
      SELECT oi.*, s.name as service_name
      FROM order_items oi
      LEFT JOIN services s ON oi.service_id = s.id
      WHERE oi.order_id = ?
    `).all(order.id);

    return { order: { ...order, address: JSON.parse(order.address || '{}'), items } };
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
}
