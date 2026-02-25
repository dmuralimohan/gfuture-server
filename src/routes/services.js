import db from '../db.js';

export default async function serviceRoutes(fastify) {
  // GET /api/services — list all services (public)
  fastify.get('/', async (request) => {
    const { category, search, sort, page = 1, limit = 20, provider_id } = request.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE s.active = 1';
    const params = [];

    if (provider_id) {
      where += ' AND s.provider_id = ?';
      params.push(provider_id);
    }

    if (category) {
      where += ' AND s.category_id = ?';
      params.push(Number(category));
    }

    if (search) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    let orderBy = 'ORDER BY s.reviews DESC';
    if (sort === 'price-low') orderBy = 'ORDER BY s.price ASC';
    else if (sort === 'price-high') orderBy = 'ORDER BY s.price DESC';
    else if (sort === 'rating') orderBy = 'ORDER BY s.rating DESC';

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM services s ${where}`).get(...params);
    const services = db.prepare(`
      SELECT s.*, c.name as category_name
      FROM services s
      LEFT JOIN categories c ON s.category_id = c.id
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    // Parse JSON includes
    const parsed = services.map((s) => ({
      ...s,
      includes: s.includes ? JSON.parse(s.includes) : [],
    }));

    return {
      services: parsed,
      total: countRow.total,
      page: Number(page),
      totalPages: Math.ceil(countRow.total / limit),
    };
  });

  // GET /api/services/:id — single service detail (public)
  fastify.get('/:id', async (request, reply) => {
    const service = db.prepare(`
      SELECT s.*, c.name as category_name,
             u.name as provider_name, u.id as provider_user_id
      FROM services s
      LEFT JOIN categories c ON s.category_id = c.id
      LEFT JOIN users u ON s.provider_id = u.id
      WHERE s.id = ?
    `).get(request.params.id);

    if (!service) {
      return reply.status(404).send({ message: 'Service not found' });
    }

    service.includes = service.includes ? JSON.parse(service.includes) : [];
    return { service };
  });

  // POST /api/services — create service (provider only)
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'provider' && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Only providers can create services' });
    }

    const { name, category_id, price, description, duration, warranty, image, includes } = request.body;

    const result = db.prepare(`
      INSERT INTO services (name, category_id, provider_id, price, description, duration, warranty, image, includes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, category_id, request.user.id, price, description, duration, warranty, image, JSON.stringify(includes || []));

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
    return reply.status(201).send({ service });
  });

  // DELETE /api/services/:id — delete service (owner or admin)
  fastify.delete('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(request.params.id);
    if (!service) return reply.status(404).send({ message: 'Service not found' });

    if (service.provider_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    db.prepare('DELETE FROM services WHERE id = ?').run(request.params.id);
    return { message: 'Service deleted successfully' };
  });

  // PUT /api/services/:id — update service (owner or admin)
  fastify.put('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(request.params.id);
    if (!service) return reply.status(404).send({ message: 'Service not found' });

    if (service.provider_id !== request.user.id && request.user.role !== 'admin') {
      return reply.status(403).send({ message: 'Not authorized' });
    }

    const { name, price, description, duration, warranty, image, includes, active } = request.body;

    db.prepare(`
      UPDATE services SET
        name = COALESCE(?, name),
        price = COALESCE(?, price),
        description = COALESCE(?, description),
        duration = COALESCE(?, duration),
        warranty = COALESCE(?, warranty),
        image = COALESCE(?, image),
        includes = COALESCE(?, includes),
        active = COALESCE(?, active),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, price, description, duration, warranty, image, includes ? JSON.stringify(includes) : null, active, request.params.id);

    const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(request.params.id);
    return { service: updated };
  });
}

