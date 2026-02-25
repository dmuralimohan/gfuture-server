import db from '../db.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

function requireAdmin(fastify) {
  return async (request, reply) => {
    await fastify.authenticate(request, reply);
    if (request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Admin access required' });
    }
  };
}

export default async function adminRoutes(fastify) {
  const adminOnly = requireAdmin(fastify);

  // ─── Dashboard Stats ────────────────────────────────────────
  fastify.get('/stats', { preHandler: [adminOnly] }, async () => {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalCustomers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'customer'").get().count;
    const totalProviders = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'provider'").get().count;
    const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    const totalServices = db.prepare('SELECT COUNT(*) as count FROM services').get().count;

    const totalRevenue = db.prepare('SELECT COALESCE(SUM(total), 0) as sum FROM orders').get().sum;
    const totalPlatformFees = db.prepare('SELECT COALESCE(SUM(platform_fee), 0) as sum FROM orders').get().sum;

    const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'").get().count;
    const completedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'completed'").get().count;
    const cancelledOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'cancelled'").get().count;

    const recentOrders = db.prepare(`
      SELECT o.*, u.name as customer_name, u.email as customer_email
      FROM orders o
      LEFT JOIN users u ON o.customer_id = u.id
      ORDER BY o.created_at DESC LIMIT 5
    `).all();

    const recentUsers = db.prepare(`
      SELECT id, name, email, phone, role, created_at FROM users
      ORDER BY created_at DESC LIMIT 5
    `).all();

    return {
      totalUsers,
      totalCustomers,
      totalProviders,
      totalOrders,
      totalServices,
      totalRevenue,
      totalPlatformFees,
      pendingOrders,
      completedOrders,
      cancelledOrders,
      recentOrders,
      recentUsers,
    };
  });

  // ─── Daily Analytics ────────────────────────────────────────
  fastify.get('/analytics/daily', { preHandler: [adminOnly] }, async (request) => {
    const { days = 30 } = request.query;

    const dailyOrders = db.prepare(`
      SELECT DATE(created_at) as date,
             COUNT(*) as orders,
             COALESCE(SUM(total), 0) as revenue,
             COALESCE(SUM(platform_fee), 0) as platform_fees
      FROM orders
      WHERE created_at >= datetime('now', '-${Number(days)} days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all();

    const dailySignups = db.prepare(`
      SELECT DATE(created_at) as date,
             COUNT(*) as signups,
             SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END) as customers,
             SUM(CASE WHEN role = 'provider' THEN 1 ELSE 0 END) as providers
      FROM users
      WHERE created_at >= datetime('now', '-${Number(days)} days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all();

    return { dailyOrders, dailySignups };
  });

  // ─── Monthly Analytics ──────────────────────────────────────
  fastify.get('/analytics/monthly', { preHandler: [adminOnly] }, async (request) => {
    const { months = 12 } = request.query;

    const monthlyOrders = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month,
             COUNT(*) as orders,
             COALESCE(SUM(total), 0) as revenue,
             COALESCE(SUM(platform_fee), 0) as platform_fees
      FROM orders
      WHERE created_at >= datetime('now', '-${Number(months)} months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month ASC
    `).all();

    const monthlySignups = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month,
             COUNT(*) as signups,
             SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END) as customers,
             SUM(CASE WHEN role = 'provider' THEN 1 ELSE 0 END) as providers
      FROM users
      WHERE created_at >= datetime('now', '-${Number(months)} months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month ASC
    `).all();

    return { monthlyOrders, monthlySignups };
  });

  // ─── Users CRUD ─────────────────────────────────────────────

  // GET all users (with search, filter, pagination)
  fastify.get('/users', { preHandler: [adminOnly] }, async (request) => {
    const { role, search, page = 1, limit = 20 } = request.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params = [];

    if (role) {
      where += ' AND role = ?';
      params.push(role);
    }
    if (search) {
      where += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get(...params).count;
    const users = db.prepare(`
      SELECT id, name, email, phone, role, created_at, updated_at
      FROM users ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    // Enrich with order count and total spent
    const enriched = users.map((u) => {
      const orderStats = db.prepare(`
        SELECT COUNT(*) as order_count, COALESCE(SUM(total), 0) as total_spent
        FROM orders WHERE customer_id = ?
      `).get(u.id);
      return { ...u, order_count: orderStats.order_count, total_spent: orderStats.total_spent };
    });

    return { users: enriched, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
  });

  // GET single user
  fastify.get('/users/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const user = db.prepare('SELECT id, name, email, phone, role, created_at, updated_at FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.status(404).send({ message: 'User not found' });

    const orders = db.prepare(`
      SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(user.id);

    const services = db.prepare(`
      SELECT * FROM services WHERE provider_id = ?
    `).all(user.id);

    return { user, orders, services };
  });

  // POST create user
  fastify.post('/users', { preHandler: [adminOnly] }, async (request, reply) => {
    const { name, email, phone, password, role } = request.body;
    if (!name || !email || !phone || !password) {
      return reply.status(400).send({ message: 'Name, email, phone and password are required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return reply.status(409).send({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const validRoles = ['customer', 'provider', 'admin'];
    const userRole = validRoles.includes(role) ? role : 'customer';

    db.prepare('INSERT INTO users (id, name, email, phone, password, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, name, email, phone, hashedPassword, userRole);

    const user = db.prepare('SELECT id, name, email, phone, role, created_at FROM users WHERE id = ?').get(userId);
    return reply.status(201).send({ user });
  });

  // PUT update user
  fastify.put('/users/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const { name, email, phone, role, password } = request.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.status(404).send({ message: 'User not found' });

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 12);
    }

    db.prepare(`
      UPDATE users SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        role = COALESCE(?, role),
        password = COALESCE(?, password),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, email, phone, role, hashedPassword, request.params.id);

    const updated = db.prepare('SELECT id, name, email, phone, role, created_at, updated_at FROM users WHERE id = ?').get(request.params.id);
    return { user: updated };
  });

  // DELETE user
  fastify.delete('/users/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.status(404).send({ message: 'User not found' });
    if (user.role === 'admin') return reply.status(400).send({ message: 'Cannot delete admin users' });

    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(request.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(request.params.id);
    return { message: 'User deleted successfully' };
  });

  // ─── Services CRUD (admin) ─────────────────────────────────

  // GET all services (admin view - includes inactive)
  fastify.get('/services', { preHandler: [adminOnly] }, async (request) => {
    const { category, search, page = 1, limit = 20 } = request.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params = [];

    if (category) {
      where += ' AND s.category_id = ?';
      params.push(Number(category));
    }
    if (search) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM services s ${where}`).get(...params).count;
    const services = db.prepare(`
      SELECT s.*, c.name as category_name, u.name as provider_name
      FROM services s
      LEFT JOIN categories c ON s.category_id = c.id
      LEFT JOIN users u ON s.provider_id = u.id
      ${where}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    const parsed = services.map((s) => ({ ...s, includes: s.includes ? JSON.parse(s.includes) : [] }));
    return { services: parsed, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
  });

  // POST create service (admin)
  fastify.post('/services', { preHandler: [adminOnly] }, async (request, reply) => {
    const { name, category_id, provider_id, price, description, duration, warranty, image, includes } = request.body;
    if (!name || !category_id || !price) {
      return reply.status(400).send({ message: 'Name, category and price are required' });
    }

    const result = db.prepare(`
      INSERT INTO services (name, category_id, provider_id, price, description, duration, warranty, image, includes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, category_id, provider_id || null, price, description, duration, warranty, image, JSON.stringify(includes || []));

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
    return reply.status(201).send({ service });
  });

  // PUT update service (admin)
  fastify.put('/services/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(request.params.id);
    if (!service) return reply.status(404).send({ message: 'Service not found' });

    const { name, category_id, provider_id, price, description, duration, warranty, image, includes, active } = request.body;
    db.prepare(`
      UPDATE services SET
        name = COALESCE(?, name),
        category_id = COALESCE(?, category_id),
        provider_id = COALESCE(?, provider_id),
        price = COALESCE(?, price),
        description = COALESCE(?, description),
        duration = COALESCE(?, duration),
        warranty = COALESCE(?, warranty),
        image = COALESCE(?, image),
        includes = COALESCE(?, includes),
        active = COALESCE(?, active),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, category_id, provider_id, price, description, duration, warranty, image, includes ? JSON.stringify(includes) : null, active, request.params.id);

    const updated = db.prepare('SELECT s.*, c.name as category_name FROM services s LEFT JOIN categories c ON s.category_id = c.id WHERE s.id = ?').get(request.params.id);
    updated.includes = updated.includes ? JSON.parse(updated.includes) : [];
    return { service: updated };
  });

  // DELETE service (admin)
  fastify.delete('/services/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(request.params.id);
    if (!service) return reply.status(404).send({ message: 'Service not found' });

    // Check if service has orders
    const orderCount = db.prepare('SELECT COUNT(*) as count FROM order_items WHERE service_id = ?').get(request.params.id).count;
    if (orderCount > 0) {
      // Soft-delete: deactivate
      db.prepare("UPDATE services SET active = 0, updated_at = datetime('now') WHERE id = ?").run(request.params.id);
      return { message: 'Service deactivated (has existing orders)' };
    }

    db.prepare('DELETE FROM services WHERE id = ?').run(request.params.id);
    return { message: 'Service deleted successfully' };
  });

  // ─── Categories CRUD ────────────────────────────────────────

  // GET all categories
  fastify.get('/categories', { preHandler: [adminOnly] }, async () => {
    const categories = db.prepare(`
      SELECT c.*, COUNT(s.id) as service_count
      FROM categories c
      LEFT JOIN services s ON c.id = s.category_id
      GROUP BY c.id
      ORDER BY c.id
    `).all();
    return { categories };
  });

  // POST create category
  fastify.post('/categories', { preHandler: [adminOnly] }, async (request, reply) => {
    const { name, icon, image } = request.body;
    if (!name) return reply.status(400).send({ message: 'Category name is required' });

    const result = db.prepare('INSERT INTO categories (name, icon, image) VALUES (?, ?, ?)').run(name, icon, image);
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    return reply.status(201).send({ category });
  });

  // PUT update category
  fastify.put('/categories/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(request.params.id);
    if (!category) return reply.status(404).send({ message: 'Category not found' });

    const { name, icon, image } = request.body;
    db.prepare(`
      UPDATE categories SET name = COALESCE(?, name), icon = COALESCE(?, icon), image = COALESCE(?, image) WHERE id = ?
    `).run(name, icon, image, request.params.id);

    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(request.params.id);
    return { category: updated };
  });

  // DELETE category
  fastify.delete('/categories/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(request.params.id);
    if (!category) return reply.status(404).send({ message: 'Category not found' });

    const serviceCount = db.prepare('SELECT COUNT(*) as count FROM services WHERE category_id = ?').get(request.params.id).count;
    if (serviceCount > 0) {
      return reply.status(400).send({ message: `Cannot delete category with ${serviceCount} service(s). Remove services first.` });
    }

    db.prepare('DELETE FROM categories WHERE id = ?').run(request.params.id);
    return { message: 'Category deleted successfully' };
  });

  // ─── Orders Management ──────────────────────────────────────

  // GET all orders (admin - full data)
  fastify.get('/orders', { preHandler: [adminOnly] }, async (request) => {
    const { status, search, page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'desc' } = request.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      where += ' AND o.status = ?';
      params.push(status);
    }
    if (search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR o.id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Whitelist sortable columns
    const sortableColumns = {
      id: 'o.id',
      created_at: 'o.created_at',
      total: 'o.total',
      subtotal: 'o.subtotal',
      platform_fee: 'o.platform_fee',
      status: 'o.status',
      customer_name: 'u.name',
      item_count: '(SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = o.id)',
    };
    const orderCol = sortableColumns[sortBy] || 'o.created_at';
    const orderDir = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM orders o LEFT JOIN users u ON o.customer_id = u.id ${where}
    `).get(...params).count;

    const orders = db.prepare(`
      SELECT o.*, u.name as customer_name, u.email as customer_email, u.phone as customer_phone
      FROM orders o
      LEFT JOIN users u ON o.customer_id = u.id
      ${where}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

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

    return { orders: enriched, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
  });

  // PATCH order status
  fastify.patch('/orders/:id/status', { preHandler: [adminOnly] }, async (request, reply) => {
    const { status } = request.body;
    const validStatuses = ['pending', 'confirmed', 'in-progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, request.params.id);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    return { order: updated };
  });

  // DELETE order
  fastify.delete('/orders/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(request.params.id);
    if (!order) return reply.status(404).send({ message: 'Order not found' });

    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(request.params.id);
    db.prepare('DELETE FROM payments WHERE order_id = ?').run(request.params.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(request.params.id);
    return { message: 'Order deleted successfully' };
  });

  // ─── Payments Overview ──────────────────────────────────────
  fastify.get('/payments', { preHandler: [adminOnly] }, async (request) => {
    const { status, page = 1, limit = 20 } = request.query;
    const offset = (Number(page) - 1) * Number(limit);
    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      where += ' AND p.status = ?';
      params.push(status);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM payments p ${where}`).get(...params).count;
    const payments = db.prepare(`
      SELECT p.*, o.customer_id, u.name as customer_name
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN users u ON o.customer_id = u.id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    return { payments, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
  });

  // ─── Plans Management (Admin) ──────────────────────────────

  // GET all plans (admin view — include inactive)
  fastify.get('/plans', { preHandler: [adminOnly] }, async () => {
    const plans = db.prepare('SELECT * FROM plans ORDER BY sort_order ASC').all();
    const parsed = plans.map((p) => ({
      ...p,
      features: p.features ? JSON.parse(p.features) : [],
    }));

    // Subscriber counts
    const enriched = parsed.map((p) => {
      const subs = db.prepare("SELECT COUNT(*) as count FROM user_plans WHERE plan_id = ? AND status = 'active'").get(p.id);
      return { ...p, subscriber_count: subs.count };
    });

    return { plans: enriched };
  });

  // POST create plan
  fastify.post('/plans', { preHandler: [adminOnly] }, async (request, reply) => {
    const { name, price, description, target, features, recommended, cta, sort_order, active } = request.body;
    if (!name || price === undefined) return reply.status(400).send({ message: 'Name and price are required' });

    const result = db.prepare(`
      INSERT INTO plans (name, price, description, target, features, recommended, cta, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, price, description, target || 'both', JSON.stringify(features || []), recommended ? 1 : 0, cta || 'Choose Plan', sort_order || 0, active !== undefined ? (active ? 1 : 0) : 1);

    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(result.lastInsertRowid);
    plan.features = plan.features ? JSON.parse(plan.features) : [];
    return reply.status(201).send({ plan });
  });

  // PUT update plan
  fastify.put('/plans/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(request.params.id);
    if (!plan) return reply.status(404).send({ message: 'Plan not found' });

    const { name, price, description, target, features, recommended, cta, sort_order, active } = request.body;

    db.prepare(`
      UPDATE plans SET
        name = COALESCE(?, name),
        price = COALESCE(?, price),
        description = COALESCE(?, description),
        target = COALESCE(?, target),
        features = COALESCE(?, features),
        recommended = COALESCE(?, recommended),
        cta = COALESCE(?, cta),
        sort_order = COALESCE(?, sort_order),
        active = COALESCE(?, active),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, price, description, target, features ? JSON.stringify(features) : null, recommended !== undefined ? (recommended ? 1 : 0) : null, cta, sort_order, active !== undefined ? (active ? 1 : 0) : null, request.params.id);

    const updated = db.prepare('SELECT * FROM plans WHERE id = ?').get(request.params.id);
    updated.features = updated.features ? JSON.parse(updated.features) : [];
    return { plan: updated };
  });

  // DELETE plan
  fastify.delete('/plans/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(request.params.id);
    if (!plan) return reply.status(404).send({ message: 'Plan not found' });

    const subs = db.prepare("SELECT COUNT(*) as count FROM user_plans WHERE plan_id = ? AND status = 'active'").get(request.params.id).count;
    if (subs > 0) {
      db.prepare("UPDATE plans SET active = 0, updated_at = datetime('now') WHERE id = ?").run(request.params.id);
      return { message: `Plan deactivated (${subs} active subscribers)` };
    }

    db.prepare('DELETE FROM user_plans WHERE plan_id = ?').run(request.params.id);
    db.prepare('DELETE FROM plans WHERE id = ?').run(request.params.id);
    return { message: 'Plan deleted successfully' };
  });

  // GET plan subscribers
  fastify.get('/plans/:id/subscribers', { preHandler: [adminOnly] }, async (request) => {
    const subscribers = db.prepare(`
      SELECT up.*, u.name, u.email, u.role
      FROM user_plans up
      JOIN users u ON up.user_id = u.id
      WHERE up.plan_id = ? AND up.status = 'active'
      ORDER BY up.subscribed_at DESC
    `).all(request.params.id);
    return { subscribers };
  });

  // ─── Offers Management (Admin) ─────────────────────────────

  // GET all offers (admin — include inactive/expired)
  fastify.get('/offers', { preHandler: [adminOnly] }, async () => {
    const offers = db.prepare(`
      SELECT o.*, u.name as provider_name
      FROM offers o
      LEFT JOIN users u ON o.provider_id = u.id
      ORDER BY o.sort_order ASC, o.created_at DESC
    `).all();
    return { offers };
  });

  // POST create offer
  fastify.post('/offers', { preHandler: [adminOnly] }, async (request, reply) => {
    const { title, description, discount_percent, discount_flat, code, target, image, badge, valid_from, valid_until, active, sort_order } = request.body;
    if (!title) return reply.status(400).send({ message: 'Title is required' });

    const result = db.prepare(`
      INSERT INTO offers (provider_id, title, description, discount_percent, discount_flat, code, target, image, badge, valid_from, valid_until, active, sort_order)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, description || '', discount_percent || 0, discount_flat || 0,
      code || null, target || 'both', image || '', badge || '',
      valid_from || new Date().toISOString(), valid_until || null,
      active !== undefined ? (active ? 1 : 0) : 1, sort_order || 0
    );

    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(result.lastInsertRowid);
    return reply.status(201).send({ offer });
  });

  // PUT update offer
  fastify.put('/offers/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(request.params.id);
    if (!offer) return reply.status(404).send({ message: 'Offer not found' });

    const { title, description, discount_percent, discount_flat, code, target, image, badge, valid_from, valid_until, active, sort_order } = request.body;

    db.prepare(`
      UPDATE offers SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        discount_percent = COALESCE(?, discount_percent),
        discount_flat = COALESCE(?, discount_flat),
        code = COALESCE(?, code),
        target = COALESCE(?, target),
        image = COALESCE(?, image),
        badge = COALESCE(?, badge),
        valid_from = COALESCE(?, valid_from),
        valid_until = COALESCE(?, valid_until),
        active = COALESCE(?, active),
        sort_order = COALESCE(?, sort_order),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(title, description, discount_percent, discount_flat, code, target, image, badge, valid_from, valid_until, active !== undefined ? (active ? 1 : 0) : null, sort_order, request.params.id);

    const updated = db.prepare('SELECT * FROM offers WHERE id = ?').get(request.params.id);
    return { offer: updated };
  });

  // DELETE offer
  fastify.delete('/offers/:id', { preHandler: [adminOnly] }, async (request, reply) => {
    const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(request.params.id);
    if (!offer) return reply.status(404).send({ message: 'Offer not found' });
    db.prepare('DELETE FROM offers WHERE id = ?').run(request.params.id);
    return { message: 'Offer deleted successfully' };
  });
}
