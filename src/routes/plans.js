import db from '../db.js';

export default async function planRoutes(fastify) {
    // ─── Public: GET /api/plans — list all active plans ─────────
    fastify.get('/', async (request) => {
        const { target } = request.query; // 'customer', 'provider', or omit for all
        let where = 'WHERE active = 1';
        const params = [];

        if (target) {
            where += " AND (target = ? OR target = 'both')";
            params.push(target);
        }

        const plans = db
            .prepare(`SELECT * FROM plans ${where} ORDER BY sort_order ASC`)
            .all(...params);

        return {
            plans: plans.map((p) => ({
                ...p,
                features: p.features ? JSON.parse(p.features) : [],
            })),
        };
    });

    // ─── Auth: GET /api/plans/my — current user's active plan ───
    fastify.get('/my', { preHandler: [fastify.authenticate] }, async (request) => {
        const row = db
            .prepare(
                `SELECT up.*, p.name as plan_name, p.price, p.currency, p.description, p.features, p.recommended
         FROM user_plans up
         JOIN plans p ON up.plan_id = p.id
         WHERE up.user_id = ? AND up.status = 'active'
         ORDER BY up.subscribed_at DESC
         LIMIT 1`
            )
            .get(request.user.id);

        if (!row) return { plan: null };

        return {
            plan: {
                ...row,
                features: row.features ? JSON.parse(row.features) : [],
            },
        };
    });

    // ─── Auth: POST /api/plans/subscribe — choose / change plan ─
    fastify.post('/subscribe', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { plan_id } = request.body;
        if (!plan_id) return reply.status(400).send({ message: 'plan_id is required' });

        const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(plan_id);
        if (!plan) return reply.status(404).send({ message: 'Plan not found or inactive' });

        // Deactivate any existing active plans for this user
        db.prepare(
            "UPDATE user_plans SET status = 'cancelled' WHERE user_id = ? AND status = 'active'"
        ).run(request.user.id);

        // Insert new subscription
        const result = db.prepare(
            `INSERT INTO user_plans (user_id, plan_id, status, subscribed_at)
       VALUES (?, ?, 'active', datetime('now'))`
        ).run(request.user.id, plan_id);

        const subscription = db
            .prepare(
                `SELECT up.*, p.name as plan_name, p.price, p.currency, p.description, p.features
         FROM user_plans up
         JOIN plans p ON up.plan_id = p.id
         WHERE up.id = ?`
            )
            .get(result.lastInsertRowid);

        subscription.features = subscription.features ? JSON.parse(subscription.features) : [];

        return reply.status(201).send({ subscription, message: 'Plan subscribed successfully' });
    });

    // ─── Auth: POST /api/plans/cancel — cancel current plan ─────
    fastify.post('/cancel', { preHandler: [fastify.authenticate] }, async (request) => {
        const updated = db
            .prepare(
                "UPDATE user_plans SET status = 'cancelled' WHERE user_id = ? AND status = 'active'"
            )
            .run(request.user.id);

        return { message: updated.changes > 0 ? 'Plan cancelled' : 'No active plan to cancel' };
    });

    // ─── Auth: GET /api/plans/recommend — get recommended plan ──
    fastify.get('/recommend', { preHandler: [fastify.authenticate] }, async (request) => {
        const userRole = request.user.role;
        const target = userRole === 'provider' ? 'provider' : 'customer';

        // First, try the recommended plan matching user type
        let plan = db
            .prepare(
                `SELECT * FROM plans
         WHERE active = 1 AND recommended = 1 AND (target = ? OR target = 'both')
         ORDER BY sort_order ASC LIMIT 1`
            )
            .get(target);

        // Fallback: cheapest active plan for their role
        if (!plan) {
            plan = db
                .prepare(
                    `SELECT * FROM plans
           WHERE active = 1 AND (target = ? OR target = 'both')
           ORDER BY price ASC LIMIT 1`
                )
                .get(target);
        }

        if (!plan) return { recommendation: null };

        return {
            recommendation: {
                ...plan,
                features: plan.features ? JSON.parse(plan.features) : [],
            },
        };
    });
}
