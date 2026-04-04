/**
 * Twilio SMS utility for GFuture.
 * Sends transactional SMS (OTP, meeting link notifications, etc.)
 * Supports both standard auth (TWILIO_ACCOUNT_SID + AUTH_TOKEN) and
 * API Key auth (TWILIO_API_KEY_SID + API_KEY_SECRET + ACCOUNT_SID).
 */

let twilioClient = null;

async function getClient() {
    if (twilioClient) return twilioClient;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    const twilio = await import('twilio');

    if (apiKeySid && apiKeySecret && accountSid) {
        // API Key authentication
        twilioClient = twilio.default(apiKeySid, apiKeySecret, { accountSid });
        return twilioClient;
    }

    if (accountSid && authToken) {
        // Standard authentication
        twilioClient = twilio.default(accountSid, authToken);
        return twilioClient;
    }

    return null;
}

function formatPhone(phone) {
    const clean = phone.replace(/\D/g, '');
    return clean.startsWith('+') ? clean : `+91${clean}`;
}

/**
 * Send an SMS message.
 * @param {string} to - Phone number (will be prefixed with +91 if needed)
 * @param {string} body - Message body
 * @returns {{ success: boolean, sid?: string, error?: string }}
 */
export async function sendSMS(to, body) {
    const client = await getClient();
    const from = process.env.TWILIO_PHONE_NUMBER;

    if (!client || !from) {
        console.log(`[SMS-DEV] To: ${to} | Body: ${body}`);
        return { success: false, error: 'Twilio not configured' };
    }

    try {
        const msg = await client.messages.create({
            body,
            from,
            to: formatPhone(to),
        });
        return { success: true, sid: msg.sid };
    } catch (err) {
        console.error('[SMS] Send failed:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Send meeting link notification to a customer.
 */
export async function sendMeetingLinkSMS(phone, courseName, meetingLink, meetingTime, meetingDate) {
    const timeInfo = [meetingTime, meetingDate].filter(Boolean).join(' on ');
    const body = `GFuture: Your course "${courseName}" has a new meeting link.\n${meetingLink}${timeInfo ? `\nScheduled: ${timeInfo}` : ''}\nJoin on time!`;
    return sendSMS(phone, body);
}

/**
 * Send forgot-password OTP via SMS.
 */
export async function sendPasswordResetSMS(phone, otp) {
    const body = `GFuture: Your password reset code is ${otp}. Valid for 5 minutes. Do not share this code.`;
    return sendSMS(phone, body);
}
