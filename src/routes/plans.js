import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { addTransaction } from './wallet.js';

export default async function planRoutes(fastify) {
    // ─── Public: GET /api/plans — list all active plans ─────────
    fastify.get('/', async (request, reply) => {
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

        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
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
                `SELECT p.id, p.name, p.price, p.currency, p.description, p.features, p.recommended, p.target, p.cta, p.sort_order,
                        up.status as subscription_status, up.subscribed_at, up.expires_at
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
                `SELECT p.id, p.name, p.price, p.currency, p.description, p.features,
                        up.status as subscription_status, up.subscribed_at, up.expires_at
         FROM user_plans up
         JOIN plans p ON up.plan_id = p.id
         WHERE up.id = ?`
            )
            .get(result.lastInsertRowid);

        subscription.features = subscription.features ? JSON.parse(subscription.features) : [];

        // One-time referral reward: referrer gets 10% of the referred user's subscribed plan amount.
        try {
            const subscriber = db
                .prepare('SELECT id, name, referred_by_user_id, referral_rewarded_at FROM users WHERE id = ?')
                .get(request.user.id);

            const planAmount = Number(plan.price || 0);
            const rewardAmount = Math.round(planAmount * 0.1 * 100) / 100;

            if (subscriber?.referred_by_user_id && !subscriber.referral_rewarded_at && rewardAmount > 0) {
                const applyReferralReward = db.transaction(() => {
                    const latestSubscriber = db
                        .prepare('SELECT id, name, referred_by_user_id, referral_rewarded_at FROM users WHERE id = ?')
                        .get(subscriber.id);

                    if (!latestSubscriber?.referred_by_user_id || latestSubscriber.referral_rewarded_at) {
                        return;
                    }

                    const existingReward = db
                        .prepare('SELECT id FROM referral_rewards WHERE referred_user_id = ?')
                        .get(latestSubscriber.id);

                    if (existingReward) {
                        db.prepare("UPDATE users SET referral_rewarded_at = datetime('now') WHERE id = ?").run(latestSubscriber.id);
                        return;
                    }

                    addTransaction(latestSubscriber.referred_by_user_id, {
                        type: 'referral_bonus',
                        amount: rewardAmount,
                        description: `Referral bonus from ${latestSubscriber.name}'s ${plan.name} plan`,
                        referenceType: 'referral_plan',
                        referenceId: latestSubscriber.id,
                    });

                    db.prepare(
                        `INSERT INTO referral_rewards (id, referrer_user_id, referred_user_id, plan_id, plan_amount, reward_amount)
                         VALUES (?, ?, ?, ?, ?, ?)`
                    ).run(
                        uuidv4(),
                        latestSubscriber.referred_by_user_id,
                        latestSubscriber.id,
                        plan.id,
                        planAmount,
                        rewardAmount,
                    );

                    db.prepare("UPDATE users SET referral_rewarded_at = datetime('now') WHERE id = ?").run(latestSubscriber.id);
                });

                applyReferralReward();
            }
        } catch (err) {
            fastify.log.error('Referral reward processing failed:', err);
        }

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

        if (!plan) return { plan: null };

        return {
            plan: {
                ...plan,
                features: plan.features ? JSON.parse(plan.features) : [],
            },
        };
    });
}
