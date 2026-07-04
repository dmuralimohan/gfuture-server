import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { addTransaction } from './wallet.js';

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const MIN_PLAN_AMOUNT_PAISE = 100;

let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
    try {
        const { default: Razorpay } = await import('razorpay');
        razorpay = new Razorpay({
            key_id: razorpayKeyId,
            key_secret: razorpayKeySecret,
        });
    } catch {
        console.warn('⚠️ razorpay package not installed — paid plan checkout via Razorpay is disabled.');
    }
}

function parsePlan(plan) {
    if (!plan) return null;
    return {
        ...plan,
        features: plan.features ? JSON.parse(plan.features) : [],
    };
}

function getCurrentSubscription(userId) {
    const row = db
        .prepare(
            `SELECT p.id, p.name, p.price, p.currency, p.description, p.features,
                    up.status as subscription_status, up.subscribed_at, up.expires_at
             FROM user_plans up
             JOIN plans p ON up.plan_id = p.id
             WHERE up.user_id = ? AND up.status = 'active'
             ORDER BY up.subscribed_at DESC
             LIMIT 1`
        )
        .get(userId);

    return parsePlan(row);
}

function createSubscription(userId, planId) {
    db.prepare(
        "UPDATE user_plans SET status = 'cancelled' WHERE user_id = ? AND status = 'active'"
    ).run(userId);

    const result = db.prepare(
        `INSERT INTO user_plans (user_id, plan_id, status, subscribed_at)
         VALUES (?, ?, 'active', datetime('now'))`
    ).run(userId, planId);

    const subscription = db
        .prepare(
            `SELECT p.id, p.name, p.price, p.currency, p.description, p.features,
                    up.status as subscription_status, up.subscribed_at, up.expires_at
             FROM user_plans up
             JOIN plans p ON up.plan_id = p.id
             WHERE up.id = ?`
        )
        .get(result.lastInsertRowid);

    return parsePlan(subscription);
}

function applyReferralRewardForPair({ referrerId, referredId, fastify }) {
    try {
        const applyReferralRewardTxn = db.transaction(() => {
            const referredUser = db
                .prepare('SELECT id, name, referred_by_user_id, referral_rewarded_at FROM users WHERE id = ?')
                .get(referredId);

            if (!referredUser || referredUser.referred_by_user_id !== referrerId || referredUser.referral_rewarded_at) {
                return;
            }

            const existingReward = db
                .prepare('SELECT id FROM referral_rewards WHERE referred_user_id = ?')
                .get(referredId);

            if (existingReward) {
                db.prepare("UPDATE users SET referral_rewarded_at = datetime('now') WHERE id = ?").run(referredId);
                return;
            }

            const referredPlan = db
                .prepare(
                    `SELECT p.id, p.name, p.price
                     FROM user_plans up
                     JOIN plans p ON p.id = up.plan_id
                     WHERE up.user_id = ? AND up.status = 'active'
                     ORDER BY up.subscribed_at DESC
                     LIMIT 1`
                )
                .get(referredId);

            const referrerPlan = db
                .prepare(
                    `SELECT p.id, p.name, p.price
                     FROM user_plans up
                     JOIN plans p ON p.id = up.plan_id
                     WHERE up.user_id = ? AND up.status = 'active'
                     ORDER BY up.subscribed_at DESC
                     LIMIT 1`
                )
                .get(referrerId);

            if (!referredPlan || !referrerPlan) return;

            // Reward only when both users are on the same active scheme.
            if (Number(referredPlan.id) !== Number(referrerPlan.id)) return;

            const planAmount = Number(referredPlan.price || 0);
            const rewardAmount = Math.round(planAmount * 0.1 * 100) / 100;
            if (rewardAmount <= 0) return;

            addTransaction(referrerId, {
                type: 'referral_bonus',
                amount: rewardAmount,
                description: `Referral bonus from ${referredUser.name}'s ${referredPlan.name} plan`,
                referenceType: 'referral_plan',
                referenceId: referredId,
            });

            db.prepare(
                `INSERT INTO referral_rewards (id, referrer_user_id, referred_user_id, plan_id, plan_amount, reward_amount)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ).run(
                uuidv4(),
                referrerId,
                referredId,
                referredPlan.id,
                planAmount,
                rewardAmount,
            );

            db.prepare("UPDATE users SET referral_rewarded_at = datetime('now') WHERE id = ?").run(referredId);
        });

        applyReferralRewardTxn();
    } catch (err) {
        fastify.log.error('Referral reward processing failed:', err);
    }
}

function applyReferralRewardsOnPlanChange({ userId, fastify }) {
    const subscriber = db
        .prepare('SELECT id, referred_by_user_id FROM users WHERE id = ?')
        .get(userId);

    if (!subscriber) return;

    // Case 1: user was referred by someone. Evaluate reward eligibility for that pair.
    if (subscriber.referred_by_user_id) {
        applyReferralRewardForPair({
            referrerId: subscriber.referred_by_user_id,
            referredId: subscriber.id,
            fastify,
        });
    }

    // Case 2: user is a referrer. If they upgraded to match any referred user's scheme, reward those pairs.
    const referredUsers = db
        .prepare('SELECT id FROM users WHERE referred_by_user_id = ?')
        .all(subscriber.id);

    for (const referredUser of referredUsers) {
        applyReferralRewardForPair({
            referrerId: subscriber.id,
            referredId: referredUser.id,
            fastify,
        });
    }
}

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
        return { plans: plans.map(parsePlan) };
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

        return { plan: parsePlan(row) };
    });

    // ─── Auth: POST /api/plans/subscribe/initiate — paid plan init ─
    fastify.post('/subscribe/initiate', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { plan_id } = request.body || {};
        if (!plan_id) return reply.status(400).send({ message: 'plan_id is required' });

        const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(plan_id);
        if (!plan) return reply.status(404).send({ message: 'Plan not found or inactive' });

        const planAmount = Number(plan.price || 0);
        if (planAmount <= 0) {
            return {
                requiresPayment: false,
                plan: parsePlan(plan),
                message: 'This is a free plan. You can subscribe directly.',
            };
        }

        if (!razorpay) {
            return reply.status(500).send({ message: 'Payment gateway not configured on server' });
        }

        const amountPaise = Math.round(planAmount * 100);
        if (amountPaise < MIN_PLAN_AMOUNT_PAISE) {
            return reply.status(400).send({ message: `Plan amount must be at least ${MIN_PLAN_AMOUNT_PAISE} paise` });
        }

        const existingPending = db
            .prepare(
                `SELECT * FROM plan_subscription_payments
                 WHERE user_id = ? AND plan_id = ? AND status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 1`
            )
            .get(request.user.id, plan.id);

        const customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(request.user.id);

        if (existingPending?.razorpay_order_id) {
            return {
                requiresPayment: true,
                payment: {
                    id: existingPending.id,
                    planId: plan.id,
                    planName: plan.name,
                    amount: planAmount,
                    status: existingPending.status,
                    razorpayOrderId: existingPending.razorpay_order_id,
                    razorpayKeyId,
                    customerName: customer?.name || '',
                    customerEmail: customer?.email || '',
                    customerPhone: customer?.phone || '',
                },
            };
        }

        try {
            const paymentId = uuidv4();
            const rzpOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt: `plan_${paymentId.substring(0, 20)}`,
                payment_capture: 1,
                notes: {
                    planPaymentId: paymentId,
                    planId: String(plan.id),
                    userId: request.user.id,
                },
            });

            db.prepare(
                `INSERT INTO plan_subscription_payments
                 (id, user_id, plan_id, amount, currency, status, razorpay_order_id)
                 VALUES (?, ?, ?, ?, 'INR', 'pending', ?)`
            ).run(
                paymentId,
                request.user.id,
                plan.id,
                planAmount,
                rzpOrder.id,
            );

            return {
                requiresPayment: true,
                payment: {
                    id: paymentId,
                    planId: plan.id,
                    planName: plan.name,
                    amount: planAmount,
                    status: 'pending',
                    razorpayOrderId: rzpOrder.id,
                    razorpayKeyId,
                    customerName: customer?.name || '',
                    customerEmail: customer?.email || '',
                    customerPhone: customer?.phone || '',
                },
            };
        } catch (err) {
            fastify.log.error('Plan payment initiation failed:', err);
            return reply.status(500).send({ message: 'Failed to initiate plan payment' });
        }
    });

    // ─── Auth: POST /api/plans/subscribe/verify — paid plan verify ─
    fastify.post('/subscribe/verify', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const {
            paymentId,
            razorpay_order_id: razorpayOrderId,
            razorpay_payment_id: razorpayPaymentId,
            razorpay_signature: razorpaySignature,
        } = request.body || {};

        if (!paymentId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return reply.status(400).send({ message: 'paymentId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
        }

        if (!razorpayKeySecret) {
            return reply.status(500).send({ message: 'Payment gateway not configured on server' });
        }

        const payment = db.prepare('SELECT * FROM plan_subscription_payments WHERE id = ?').get(paymentId);
        if (!payment) return reply.status(404).send({ message: 'Plan payment record not found' });
        if (payment.user_id !== request.user.id) return reply.status(403).send({ message: 'Not authorized' });

        if (payment.status === 'completed') {
            return {
                success: true,
                subscription: getCurrentSubscription(request.user.id),
                message: 'Plan payment already verified',
            };
        }

        if (payment.razorpay_order_id !== razorpayOrderId) {
            return reply.status(400).send({ message: 'Razorpay order mismatch' });
        }

        const expectedSignature = crypto
            .createHmac('sha256', razorpayKeySecret)
            .update(`${razorpayOrderId}|${razorpayPaymentId}`)
            .digest('hex');

        const signaturesMatch =
            expectedSignature.length === razorpaySignature.length
            && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpaySignature));

        if (!signaturesMatch) {
            db.prepare(
                `UPDATE plan_subscription_payments
                 SET status = 'failed', razorpay_payment_id = ?, razorpay_signature = ?, updated_at = datetime('now')
                 WHERE id = ?`
            ).run(razorpayPaymentId, razorpaySignature, paymentId);
            return reply.status(400).send({ message: 'Signature mismatch' });
        }

        db.prepare('BEGIN').run();
        let subscription;
        try {
            const latestPayment = db.prepare('SELECT * FROM plan_subscription_payments WHERE id = ?').get(paymentId);

            if (latestPayment.status === 'completed') {
                subscription = getCurrentSubscription(request.user.id);
            } else {
                db.prepare(
                    `UPDATE plan_subscription_payments
                     SET status = 'completed', razorpay_payment_id = ?, razorpay_signature = ?, completed_at = datetime('now'), updated_at = datetime('now')
                     WHERE id = ?`
                ).run(razorpayPaymentId, razorpaySignature, paymentId);

                subscription = createSubscription(request.user.id, latestPayment.plan_id);
            }

            db.prepare('COMMIT').run();

            applyReferralRewardsOnPlanChange({ userId: request.user.id, fastify });

            return {
                success: true,
                subscription,
                message: 'Plan subscribed successfully',
            };
        } catch (err) {
            db.prepare('ROLLBACK').run();
            fastify.log.error('Plan payment verification failed:', err);
            return reply.status(500).send({ message: 'Could not finalize subscription' });
        }
    });

    // ─── Auth: POST /api/plans/subscribe — choose / change plan ─
    fastify.post('/subscribe', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { plan_id } = request.body;
        if (!plan_id) return reply.status(400).send({ message: 'plan_id is required' });

        const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(plan_id);
        if (!plan) return reply.status(404).send({ message: 'Plan not found or inactive' });

        const planAmount = Number(plan.price || 0);
        if (planAmount > 0) {
            return reply.status(400).send({ message: 'Paid plans require payment verification. Use subscribe/initiate and subscribe/verify.' });
        }

        const subscription = createSubscription(request.user.id, plan.id);

        applyReferralRewardsOnPlanChange({ userId: request.user.id, fastify });

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

        return { plan: parsePlan(plan) };
    });
}
