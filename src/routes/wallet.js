import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import db from '../db.js';

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
const MIN_TOPUP_AMOUNT = 1;
const MIN_TOPUP_AMOUNT_PAISE = 100;

let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
    try {
        const { default: Razorpay } = await import('razorpay');
        razorpay = new Razorpay({
            key_id: razorpayKeyId,
            key_secret: razorpayKeySecret,
        });
    } catch {
        console.warn('⚠️ razorpay package not installed — wallet top-up via Razorpay is disabled.');
    }
}

// Ensure wallet exists for a user
function ensureWallet(userId) {
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    if (!wallet) {
        db.prepare('INSERT INTO wallets (user_id, balance, credit_points) VALUES (?, 0, 100)').run(userId);
        // Grant 100 welcome credit points
        db.prepare(
            `INSERT INTO wallet_transactions (user_id, type, amount, credit_points, description, reference_type, balance_after, credits_after)
       VALUES (?, 'credit_earned', 0, 100, 'Welcome bonus credit points', 'signup', 0, 100)`
        ).run(userId);
        return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    }
    return wallet;
}

function addTransaction(userId, { type, amount = 0, creditPoints = 0, description, referenceType, referenceId }) {
    const wallet = ensureWallet(userId);
    const newBalance = wallet.balance + amount;
    const newCredits = wallet.credit_points + creditPoints;

    db.prepare(
        `UPDATE wallets SET balance = ?, credit_points = ?, updated_at = datetime('now') WHERE user_id = ?`
    ).run(newBalance, newCredits, userId);

    db.prepare(
        `INSERT INTO wallet_transactions (user_id, type, amount, credit_points, description, reference_type, reference_id, balance_after, credits_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, type, amount, creditPoints, description, referenceType || null, referenceId || null, newBalance, newCredits);

    return { balance: newBalance, credit_points: newCredits };
}

export default async function walletRoutes(fastify) {
    // GET /api/wallet — get wallet balance & credits
    fastify.get('/', { preHandler: [fastify.authenticate] }, async (request) => {
        const wallet = ensureWallet(request.user.id);
        return { wallet };
    });

    // GET /api/wallet/transactions — transaction history
    fastify.get('/transactions', { preHandler: [fastify.authenticate] }, async (request) => {
        const { page = 1, limit = 20, type } = request.query;
        const offset = (page - 1) * limit;
        let where = 'WHERE user_id = ?';
        const params = [request.user.id];

        if (type) {
            where += ' AND type = ?';
            params.push(type);
        }

        const total = db.prepare(`SELECT COUNT(*) as count FROM wallet_transactions ${where}`).get(...params).count;
        const transactions = db.prepare(
            `SELECT * FROM wallet_transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
        ).all(...params, Number(limit), Number(offset));

        return {
            transactions,
            total,
            page: Number(page),
            totalPages: Math.ceil(total / Number(limit)),
        };
    });

    // POST /api/wallet/add-funds — legacy direct top-up route (disabled by default)
    fastify.post('/add-funds', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { amount } = request.body || {};
        if (!amount || amount <= 0) {
            return reply.status(400).send({ message: 'Valid amount is required' });
        }

        if (process.env.ALLOW_DIRECT_WALLET_CREDIT !== 'true') {
            return reply.status(400).send({ message: 'Direct wallet credit is disabled. Use Razorpay wallet top-up.' });
        }

        const result = addTransaction(request.user.id, {
            type: 'top_up',
            amount,
            description: `Added ₹${amount} to wallet`,
            referenceType: 'top_up',
        });

        return { wallet: result, message: 'Funds added successfully' };
    });

    // POST /api/wallet/topup/initiate — create Razorpay order for wallet top-up
    fastify.post('/topup/initiate', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { amount } = request.body || {};
        const topupAmount = Number(amount);

        if (!Number.isFinite(topupAmount) || topupAmount < MIN_TOPUP_AMOUNT) {
            return reply.status(400).send({ message: `Minimum top-up amount is ₹${MIN_TOPUP_AMOUNT}` });
        }

        if (!razorpay) {
            return reply.status(500).send({ message: 'Payment gateway not configured on server' });
        }

        const amountPaise = Math.round(topupAmount * 100);
        if (amountPaise < MIN_TOPUP_AMOUNT_PAISE) {
            return reply.status(400).send({ message: `Amount must be at least ${MIN_TOPUP_AMOUNT_PAISE} paise` });
        }

        try {
            const topupId = uuidv4();
            const rzpOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt: `wallet_${topupId.substring(0, 20)}`,
                payment_capture: 1,
                notes: {
                    walletTopupId: topupId,
                    userId: request.user.id,
                },
            });

            db.prepare(
                `INSERT INTO wallet_topups (id, user_id, amount, status, razorpay_order_id)
                 VALUES (?, ?, ?, 'pending', ?)`
            ).run(topupId, request.user.id, topupAmount, rzpOrder.id);

            const customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(request.user.id);

            return {
                topup: {
                    id: topupId,
                    amount: topupAmount,
                    status: 'pending',
                    razorpayOrderId: rzpOrder.id,
                    razorpayKeyId,
                    customerName: customer?.name || '',
                    customerEmail: customer?.email || '',
                    customerPhone: customer?.phone || '',
                },
            };
        } catch (err) {
            fastify.log.error('Wallet Razorpay top-up initiate failed:', err);
            return reply.status(500).send({ message: 'Failed to initiate wallet top-up' });
        }
    });

    // POST /api/wallet/topup/verify — verify Razorpay signature and credit wallet once
    fastify.post('/topup/verify', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const {
            topupId,
            razorpay_order_id: razorpayOrderId,
            razorpay_payment_id: razorpayPaymentId,
            razorpay_signature: razorpaySignature,
        } = request.body || {};

        if (!topupId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return reply.status(400).send({ message: 'topupId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
        }

        if (!razorpayKeySecret) {
            return reply.status(500).send({ message: 'Payment gateway not configured on server' });
        }

        const topup = db.prepare('SELECT * FROM wallet_topups WHERE id = ?').get(topupId);
        if (!topup) {
            return reply.status(404).send({ message: 'Wallet top-up not found' });
        }
        if (topup.user_id !== request.user.id) {
            return reply.status(403).send({ message: 'Not authorized' });
        }

        if (topup.status === 'completed') {
            return {
                success: true,
                wallet: ensureWallet(request.user.id),
                message: 'Wallet top-up already verified',
            };
        }

        if (topup.razorpay_order_id !== razorpayOrderId) {
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
                `UPDATE wallet_topups SET status = 'failed', razorpay_payment_id = ?, razorpay_signature = ?, updated_at = datetime('now') WHERE id = ?`
            ).run(razorpayPaymentId, razorpaySignature, topupId);
            return reply.status(400).send({ message: 'Signature mismatch' });
        }

        db.prepare('BEGIN').run();
        try {
            const latestTopup = db.prepare('SELECT * FROM wallet_topups WHERE id = ?').get(topupId);
            if (latestTopup.status === 'completed') {
                db.prepare('COMMIT').run();
                return {
                    success: true,
                    wallet: ensureWallet(request.user.id),
                    message: 'Wallet top-up already verified',
                };
            }

            const result = addTransaction(request.user.id, {
                type: 'top_up',
                amount: Number(latestTopup.amount),
                description: `Added ₹${Number(latestTopup.amount).toFixed(2)} to wallet via Razorpay`,
                referenceType: 'wallet_topup',
                referenceId: topupId,
            });

            db.prepare(
                `UPDATE wallet_topups
                 SET status = 'completed', razorpay_payment_id = ?, razorpay_signature = ?, completed_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?`
            ).run(razorpayPaymentId, razorpaySignature, topupId);

            db.prepare('COMMIT').run();
            return {
                success: true,
                wallet: result,
                topup: {
                    id: topupId,
                    status: 'completed',
                    amount: Number(latestTopup.amount),
                },
                message: 'Wallet top-up successful',
            };
        } catch (err) {
            db.prepare('ROLLBACK').run();
            fastify.log.error('Wallet Razorpay top-up verify failed:', err);
            return reply.status(500).send({ message: 'Failed to verify wallet top-up' });
        }
    });

    // GET /api/wallet/topup/:id — fetch top-up status
    fastify.get('/topup/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { id } = request.params;
        const topup = db.prepare(
            `SELECT id, amount, status, razorpay_order_id, razorpay_payment_id, completed_at, created_at
             FROM wallet_topups WHERE id = ? AND user_id = ?`
        ).get(id, request.user.id);

        if (!topup) {
            return reply.status(404).send({ message: 'Wallet top-up not found' });
        }

        return {
            topup: {
                id: topup.id,
                amount: Number(topup.amount),
                status: topup.status,
                razorpayOrderId: topup.razorpay_order_id,
                razorpayPaymentId: topup.razorpay_payment_id,
                completedAt: topup.completed_at,
                createdAt: topup.created_at,
            },
        };
    });

    // POST /api/wallet/redeem-credits — convert credit points to wallet balance
    fastify.post('/redeem-credits', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { points } = request.body;
        const wallet = ensureWallet(request.user.id);

        if (!points || points <= 0) {
            return reply.status(400).send({ message: 'Valid points amount required' });
        }
        if (points > wallet.credit_points) {
            return reply.status(400).send({ message: 'Insufficient credit points' });
        }
        if (points < 50) {
            return reply.status(400).send({ message: 'Minimum 50 points required to redeem' });
        }

        // 1 point = ₹0.50
        const cashValue = points * 0.5;

        const result = addTransaction(request.user.id, {
            type: 'credit_redeemed',
            amount: cashValue,
            creditPoints: -points,
            description: `Redeemed ${points} credits for ₹${cashValue}`,
            referenceType: 'credit_redeem',
        });

        return {
            wallet: result,
            redeemed: { points, cashValue },
            message: `Redeemed ${points} points for ₹${cashValue}`,
        };
    });

    // POST /api/wallet/pay — pay from wallet for an order
    fastify.post('/pay', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { orderId, useCredits = false } = request.body;

        if (!orderId) {
            return reply.status(400).send({ message: 'Order ID is required' });
        }

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return reply.status(404).send({ message: 'Order not found' });
        if (order.customer_id !== request.user.id) {
            return reply.status(403).send({ message: 'Not authorized' });
        }

        const wallet = ensureWallet(request.user.id);
        let amountToPay = order.total;
        let creditsUsed = 0;

        // Optionally use credit points to reduce amount
        if (useCredits && wallet.credit_points > 0) {
            const maxCredits = Math.min(wallet.credit_points, Math.floor(amountToPay / 0.5));
            const creditDiscount = maxCredits * 0.5;
            amountToPay -= creditDiscount;
            creditsUsed = maxCredits;
        }

        if (wallet.balance < amountToPay) {
            return reply.status(400).send({
                message: 'Insufficient wallet balance',
                required: amountToPay,
                available: wallet.balance,
            });
        }

        // Deduct wallet + credits
        const result = addTransaction(request.user.id, {
            type: 'payment',
            amount: -amountToPay,
            creditPoints: -creditsUsed,
            description: `Payment for order #${orderId.substring(0, 8)}`,
            referenceType: 'order',
            referenceId: orderId,
        });

        // Earn 2% of order total as credit points
        const earnedPoints = Math.floor(order.total * 0.02);
        if (earnedPoints > 0) {
            addTransaction(request.user.id, {
                type: 'credit_earned',
                creditPoints: earnedPoints,
                description: `Earned ${earnedPoints} points from order #${orderId.substring(0, 8)}`,
                referenceType: 'order_reward',
                referenceId: orderId,
            });
        }

        // Mark order and payment as confirmed
        db.prepare(`UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(orderId);

        const existingPayment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
        if (existingPayment) {
            db.prepare(
                `UPDATE payments SET status = 'completed', method = 'wallet', paid_at = datetime('now'), updated_at = datetime('now') WHERE order_id = ?`
            ).run(orderId);
        } else {
            const { v4: uuidv4 } = await import('uuid');
            db.prepare(
                `INSERT INTO payments (id, order_id, amount, status, method, paid_at) VALUES (?, ?, ?, 'completed', 'wallet', datetime('now'))`
            ).run(uuidv4(), orderId, order.total);
        }

        const updatedWallet = ensureWallet(request.user.id);

        return {
            wallet: updatedWallet,
            payment: {
                orderId,
                amountPaid: amountToPay,
                creditsUsed,
                pointsEarned: earnedPoints,
            },
            message: 'Payment successful',
        };
    });
}

export { ensureWallet, addTransaction };
