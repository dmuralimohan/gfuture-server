import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import db from '../db.js';
import { ensureWallet } from './wallet.js';
import { sendPasswordResetSMS } from '../sms.js';

// Refresh token expires in 7 days
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function saveRefreshToken(userId, token) {
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

export default async function authRoutes(fastify) {
  // POST /api/auth/signup
  fastify.post('/signup', async (request, reply) => {
    const { name, email, phone, password, role } = request.body;

    if (!name || !email || !phone || !password) {
      return reply.status(400).send({ message: 'All fields are required' });
    }

    const validRoles = ['customer', 'provider'];
    const userRole = validRoles.includes(role) ? role : 'customer';

    // Check existing
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return reply.status(409).send({ message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    db.prepare('INSERT INTO users (id, name, email, phone, password, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, name, email, phone, hashedPassword, userRole);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    // Initialize wallet with welcome bonus
    ensureWallet(userId);
    const accessToken = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });
    const refreshToken = generateRefreshToken();
    saveRefreshToken(userId, refreshToken);

    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);

    return reply.status(201).send({
      user: sanitizeUser(user),
      wallet,
      accessToken,
      refreshToken,
    });
  });

  // POST /api/auth/login
  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body;

    if (!email || !password) {
      return reply.status(400).send({ message: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return reply.status(401).send({ message: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return reply.status(401).send({ message: 'Invalid email or password' });
    }

    const accessToken = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });
    const refreshToken = generateRefreshToken();
    saveRefreshToken(user.id, refreshToken);

    return {
      user: sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  });

  // POST /api/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body;

    if (!refreshToken) {
      return reply.status(400).send({ message: 'Refresh token is required' });
    }

    const stored = db.prepare(
      `SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > datetime('now')`
    ).get(refreshToken);

    if (!stored) {
      return reply.status(401).send({ message: 'Invalid or expired refresh token' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
    if (!user) {
      return reply.status(401).send({ message: 'User not found' });
    }

    // Delete old token
    db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);

    // Issue new tokens
    const newAccessToken = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });
    const newRefreshToken = generateRefreshToken();
    saveRefreshToken(user.id, newRefreshToken);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  });

  // GET /api/auth/profile (protected)
  fastify.get('/profile', { preHandler: [fastify.authenticate] }, async (request) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id);
    return { user: sanitizeUser(user) };
  });

  // PUT /api/auth/profile (protected)
  fastify.put('/profile', { preHandler: [fastify.authenticate] }, async (request) => {
    const { name, phone, profile_picture } = request.body;
    const userId = request.user.id;

    db.prepare(`UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), profile_picture = COALESCE(?, profile_picture), updated_at = datetime('now') WHERE id = ?`)
      .run(name || null, phone || null, profile_picture || null, userId);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return { user: sanitizeUser(user) };
  });

  // POST /api/auth/logout
  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = request.body;
    if (refreshToken) {
      db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
    }
    return { message: 'Logged out successfully' };
  });

  // POST /api/auth/forgot-password — send OTP via SMS
  fastify.post('/forgot-password', async (request, reply) => {
    const { phone } = request.body;

    if (!phone) {
      return reply.status(400).send({ message: 'Phone number is required' });
    }

    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return reply.status(400).send({ message: 'Invalid phone number' });
    }

    // Find user by phone
    const user = db.prepare('SELECT id, phone FROM users WHERE phone = ?').get(cleanPhone)
      || db.prepare('SELECT id, phone FROM users WHERE phone = ?').get(phone);

    if (!user) {
      return reply.status(404).send({ message: 'No account found with this phone number' });
    }

    // Rate limit: max 5 attempts per phone in 10 minutes
    const recentCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM password_resets
       WHERE phone = ? AND created_at > datetime('now', '-10 minutes')`
    ).get(cleanPhone);

    if (recentCount.cnt >= 5) {
      return reply.status(429).send({ message: 'Too many attempts. Please wait 10 minutes.' });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    db.prepare('INSERT INTO password_resets (user_id, phone, otp, expires_at) VALUES (?, ?, ?, ?)')
      .run(user.id, cleanPhone, otp, expiresAt);

    // Send SMS
    const result = await sendPasswordResetSMS(cleanPhone, otp);

    // In dev, expose OTP if Twilio isn't configured
    const isDev = !result.success;
    return {
      success: true,
      message: 'Reset code sent to your phone',
      ...(isDev ? { _dev_otp: otp } : {}),
    };
  });

  // POST /api/auth/reset-password — verify OTP and set new password
  fastify.post('/reset-password', async (request, reply) => {
    const { phone, otp, newPassword } = request.body;

    if (!phone || !otp || !newPassword) {
      return reply.status(400).send({ message: 'Phone, OTP, and new password are required' });
    }

    if (newPassword.length < 6) {
      return reply.status(400).send({ message: 'Password must be at least 6 characters' });
    }

    const cleanPhone = phone.replace(/\D/g, '');

    const reset = db.prepare(
      `SELECT * FROM password_resets
       WHERE phone = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    ).get(cleanPhone, otp);

    if (!reset) {
      return reply.status(400).send({ message: 'Invalid or expired reset code' });
    }

    // Mark as used
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(reset.id);

    // Update password
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hashedPassword, reset.user_id);

    // Revoke all refresh tokens for security
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(reset.user_id);

    return { success: true, message: 'Password reset successfully. Please log in.' };
  });
}
