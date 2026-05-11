import db from '../db.js';

function parsePayload(row) {
    return row?.payload ? (() => {
        try {
            return JSON.parse(row.payload);
        } catch {
            return null;
        }
    })() : null;
}

export default async function notificationRoutes(fastify) {
    // GET /api/notifications — current user's notifications
    fastify.get('/', { preHandler: [fastify.authenticate] }, async (request) => {
        const notifications = db.prepare(`
      SELECT *
      FROM notifications
      WHERE user_id = ?
      ORDER BY read_at IS NOT NULL ASC, created_at DESC, id DESC
      LIMIT 100
    `).all(request.user.id).map((row) => ({
            ...row,
            payload: parsePayload(row),
        }));

        const unreadCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM notifications
      WHERE user_id = ? AND read_at IS NULL
    `).get(request.user.id).count;

        return { notifications, unreadCount };
    });

    // PATCH /api/notifications/:id/read — mark a notification read
    fastify.patch('/:id/read', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(request.params.id);
        if (!notification || notification.user_id !== request.user.id) {
            return reply.status(404).send({ message: 'Notification not found' });
        }

        db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`)
            .run(request.params.id);

        const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(request.params.id);
        return { notification: { ...updated, payload: parsePayload(updated) } };
    });

    // POST /api/notifications/read-all — mark all read
    fastify.post('/read-all', { preHandler: [fastify.authenticate] }, async (request) => {
        db.prepare(`
      UPDATE notifications
      SET read_at = COALESCE(read_at, datetime('now')), updated_at = datetime('now')
      WHERE user_id = ? AND read_at IS NULL
    `).run(request.user.id);

        return { success: true };
    });
}
