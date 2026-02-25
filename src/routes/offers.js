import db from '../db.js';

export default async function offerRoutes(fastify) {
    // GET /api/offers — public, list active offers optionally filtered by target
    fastify.get('/', async (request) => {
        const { target } = request.query;
        let where = "WHERE o.active = 1 AND (o.valid_until IS NULL OR o.valid_until >= datetime('now'))";
        const params = [];

        if (target) {
            where += " AND (o.target = ? OR o.target = 'both')";
            params.push(target);
        }

        const offers = db.prepare(`
      SELECT o.*, u.name as provider_name FROM offers o
      LEFT JOIN users u ON o.provider_id = u.id
      ${where}
      ORDER BY o.sort_order ASC, o.created_at DESC
    `).all(...params);

        return { offers };
    });

    // POST /api/offers/apply — validate & calculate coupon discount
    fastify.post('/apply', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { code, subtotal } = request.body;
        if (!code) return reply.status(400).send({ message: 'Coupon code is required' });
        if (!subtotal || subtotal <= 0) return reply.status(400).send({ message: 'Valid subtotal is required' });

        const offer = db.prepare(`
      SELECT * FROM offers
      WHERE code = ? AND active = 1
        AND (valid_until IS NULL OR valid_until >= datetime('now'))
    `).get(code.toUpperCase());

        if (!offer) return reply.status(404).send({ message: 'Invalid or expired coupon code' });

        // Check target matches user role
        const userRole = request.user.role;
        if (offer.target !== 'both' && offer.target !== userRole) {
            return reply.status(400).send({ message: `This coupon is for ${offer.target}s only` });
        }

        // Calculate discount
        let discountAmount = 0;
        if (offer.discount_percent > 0) {
            discountAmount = Math.round((subtotal * offer.discount_percent / 100) * 100) / 100;
        }
        if (offer.discount_flat > 0) {
            discountAmount += offer.discount_flat;
        }
        // Cap discount at subtotal
        discountAmount = Math.min(discountAmount, subtotal);

        return {
            valid: true,
            offer: {
                id: offer.id,
                title: offer.title,
                code: offer.code,
                discount_percent: offer.discount_percent,
                discount_flat: offer.discount_flat,
            },
            discount_amount: discountAmount,
        };
    });

    // ─── Provider Offers CRUD (authenticated provider) ────────────
    const providerOnly = async (request, reply) => {
        await fastify.authenticate(request, reply);
        if (request.user.role !== 'provider') {
            return reply.status(403).send({ message: 'Provider access required' });
        }
    };

    // GET /api/offers/my — provider's own offers
    fastify.get('/my', { preHandler: [providerOnly] }, async (request) => {
        const offers = db.prepare(
            'SELECT * FROM offers WHERE provider_id = ? ORDER BY sort_order ASC, created_at DESC'
        ).all(request.user.id);
        return { offers };
    });

    // POST /api/offers/provider — provider creates offer
    fastify.post('/provider', { preHandler: [providerOnly] }, async (request, reply) => {
        const { title, description, discount_percent, discount_flat, code, image, badge, valid_from, valid_until, sort_order } = request.body;
        if (!title) return reply.status(400).send({ message: 'Title is required' });
        if (!code) return reply.status(400).send({ message: 'Coupon code is required' });

        // Check code uniqueness
        const existing = db.prepare('SELECT id FROM offers WHERE code = ?').get(code.toUpperCase());
        if (existing) return reply.status(409).send({ message: 'This coupon code is already taken' });

        const result = db.prepare(`
      INSERT INTO offers (provider_id, title, description, discount_percent, discount_flat, code, target, image, badge, valid_from, valid_until, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 'customer', ?, ?, ?, ?, 1, ?)
    `).run(
            request.user.id,
            title, description || '', discount_percent || 0, discount_flat || 0,
            code.toUpperCase(), image || '', badge || '',
            valid_from || new Date().toISOString(), valid_until || null,
            sort_order || 0
        );

        const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(result.lastInsertRowid);
        return reply.status(201).send({ offer });
    });

    // PUT /api/offers/provider/:id — provider updates own offer
    fastify.put('/provider/:id', { preHandler: [providerOnly] }, async (request, reply) => {
        const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND provider_id = ?').get(request.params.id, request.user.id);
        if (!offer) return reply.status(404).send({ message: 'Offer not found or not yours' });

        const { title, description, discount_percent, discount_flat, code, image, badge, valid_from, valid_until, active, sort_order } = request.body;

        db.prepare(`
      UPDATE offers SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        discount_percent = COALESCE(?, discount_percent),
        discount_flat = COALESCE(?, discount_flat),
        code = COALESCE(?, code),
        image = COALESCE(?, image),
        badge = COALESCE(?, badge),
        valid_from = COALESCE(?, valid_from),
        valid_until = COALESCE(?, valid_until),
        active = COALESCE(?, active),
        sort_order = COALESCE(?, sort_order),
        updated_at = datetime('now')
      WHERE id = ? AND provider_id = ?
    `).run(title, description, discount_percent, discount_flat, code ? code.toUpperCase() : null, image, badge, valid_from, valid_until, active !== undefined ? (active ? 1 : 0) : null, sort_order, request.params.id, request.user.id);

        const updated = db.prepare('SELECT * FROM offers WHERE id = ?').get(request.params.id);
        return { offer: updated };
    });

    // DELETE /api/offers/provider/:id — provider deletes own offer
    fastify.delete('/provider/:id', { preHandler: [providerOnly] }, async (request, reply) => {
        const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND provider_id = ?').get(request.params.id, request.user.id);
        if (!offer) return reply.status(404).send({ message: 'Offer not found or not yours' });
        db.prepare('DELETE FROM offers WHERE id = ?').run(request.params.id);
        return { message: 'Offer deleted successfully' };
    });
}
