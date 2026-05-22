import db from '../db.js';

export default async function serviceRoutes(fastify) {
  const updateServiceReviewSummary = (serviceId) => {
    const agg = db.prepare(
      `SELECT COUNT(*) as totalReviews, ROUND(COALESCE(AVG(rating), 0), 1) as avgRating
       FROM service_reviews
       WHERE service_id = ?`
    ).get(serviceId);

    db.prepare(
      `UPDATE services
       SET rating = ?, reviews = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(agg.avgRating || 0, agg.totalReviews || 0, serviceId);
  };

  // GET /api/services — list all services (public)
  fastify.get('/', async (request, reply) => {
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

    const parsed = services.map((s) => ({
      ...s,
      includes: s.includes ? JSON.parse(s.includes) : [],
    }));

    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
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

  // GET /api/services/:id/reviews — list reviews for a service (public)
  fastify.get('/:id/reviews', async (request, reply) => {
    const serviceId = Number(request.params.id);
    if (!Number.isFinite(serviceId)) {
      return reply.status(400).send({ message: 'Invalid service id' });
    }

    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
    if (!service) {
      return reply.status(404).send({ message: 'Service not found' });
    }

    const reviews = db.prepare(
      `SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at,
              u.id as user_id, u.name as user_name
       FROM service_reviews r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.service_id = ?
       ORDER BY r.created_at DESC`
    ).all(serviceId);

    return {
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        updated_at: r.updated_at,
        user: {
          id: r.user_id,
          name: r.user_name || 'User',
        },
      })),
    };
  });

  // POST /api/services/:id/reviews — add review to a service (authenticated)
  fastify.post('/:id/reviews', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const serviceId = Number(request.params.id);
    const { rating, comment } = request.body || {};
    const score = Number(rating);
    const text = typeof comment === 'string' ? comment.trim() : '';

    if (!Number.isFinite(serviceId)) {
      return reply.status(400).send({ message: 'Invalid service id' });
    }

    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return reply.status(400).send({ message: 'Rating must be between 1 and 5' });
    }

    if (!text) {
      return reply.status(400).send({ message: 'Review comment is required' });
    }

    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
    if (!service) {
      return reply.status(404).send({ message: 'Service not found' });
    }

    const inserted = db.prepare(
      `INSERT INTO service_reviews (service_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?)`
    ).run(serviceId, request.user.id, score, text);

    updateServiceReviewSummary(serviceId);

    const review = db.prepare(
      `SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at,
              u.id as user_id, u.name as user_name
       FROM service_reviews r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`
    ).get(inserted.lastInsertRowid);

    return reply.status(201).send({
      review: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        created_at: review.created_at,
        updated_at: review.updated_at,
        user: {
          id: review.user_id,
          name: review.user_name || 'User',
        },
      },
    });
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

