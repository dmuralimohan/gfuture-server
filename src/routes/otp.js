import crypto from 'crypto';
import db from '../db.js';

// Twilio setup — uses ENV variables
// Set these in your environment:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
let twilioClient = null;

async function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    const twilio = await import('twilio');
    twilioClient = twilio.default(accountSid, authToken);
    return twilioClient;
  }
  return null;
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

export default async function otpRoutes(fastify) {
  // POST /api/otp/send — Send OTP to phone number
  fastify.post('/send', async (request, reply) => {
    const { phone } = request.body;

    if (!phone) {
      return reply.status(400).send({ message: 'Phone number is required' });
    }

    // Clean phone number
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
      return reply.status(400).send({ message: 'Invalid phone number' });
    }

    // Rate limit: max 5 OTPs per phone in last 10 minutes
    const recentCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM otp_verifications 
       WHERE phone = ? AND created_at > datetime('now', '-10 minutes')`
    ).get(cleanPhone);

    if (recentCount.cnt >= 5) {
      return reply.status(429).send({ message: 'Too many OTP requests. Please wait 10 minutes.' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

    // Save OTP
    db.prepare('INSERT INTO otp_verifications (phone, otp, expires_at) VALUES (?, ?, ?)')
      .run(cleanPhone, otp, expiresAt);

    // Try to send via Twilio
    const client = await getTwilioClient();
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

    if (client && twilioPhone) {
      try {
        const toNumber = cleanPhone.startsWith('+') ? cleanPhone : `+91${cleanPhone}`;
        await client.messages.create({
          body: `Your G-Future verification code is: ${otp}. Valid for 5 minutes. Do not share.`,
          from: twilioPhone,
          to: toNumber,
        });
        return {
          success: true,
          message: 'OTP sent successfully',
          // Never expose OTP in production
          ...(process.env.NODE_ENV === 'development' ? { _dev_otp: otp } : {}),
        };
      } catch (twilioErr) {
        fastify.log.error('Twilio error:', twilioErr.message);
        // Fallback to dev mode
        return {
          success: true,
          message: 'OTP generated (Twilio unavailable — check server logs)',
          _dev_otp: otp, // Show OTP when Twilio fails for dev testing
        };
      }
    }

    // Dev mode — no Twilio configured
    fastify.log.info(`[DEV] OTP for ${cleanPhone}: ${otp}`);
    return {
      success: true,
      message: 'OTP sent successfully',
      _dev_otp: otp, // Remove in production
    };
  });

  // POST /api/otp/verify — Verify OTP
  fastify.post('/verify', async (request, reply) => {
    const { phone, otp } = request.body;

    if (!phone || !otp) {
      return reply.status(400).send({ message: 'Phone and OTP are required' });
    }

    const cleanPhone = phone.replace(/\D/g, '');

    // Find valid OTP
    const record = db.prepare(
      `SELECT * FROM otp_verifications 
       WHERE phone = ? AND otp = ? AND verified = 0 AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).get(cleanPhone, otp);

    if (!record) {
      return reply.status(400).send({ message: 'Invalid or expired OTP' });
    }

    // Mark as verified
    db.prepare('UPDATE otp_verifications SET verified = 1 WHERE id = ?').run(record.id);

    // Clean up old OTPs for this phone
    db.prepare(
      `DELETE FROM otp_verifications WHERE phone = ? AND (verified = 1 OR expires_at < datetime('now'))`
    ).run(cleanPhone);

    return {
      success: true,
      verified: true,
      message: 'Phone number verified successfully',
    };
  });
}
