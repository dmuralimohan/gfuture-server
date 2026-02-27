import db from '../db.js';

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

    // POST /api/wallet/add-funds — add money to wallet
    fastify.post('/add-funds', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const { amount } = request.body;
        if (!amount || amount <= 0) {
            return reply.status(400).send({ message: 'Valid amount is required' });
        }

        const result = addTransaction(request.user.id, {
            type: 'top_up',
            amount,
            description: `Added ₹${amount} to wallet`,
            referenceType: 'top_up',
        });

        return { wallet: result, message: 'Funds added successfully' };
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
