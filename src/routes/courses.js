import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { sendToUser } from '../ws.js';
import { sendMeetingLinkSMS } from '../sms.js';

const UPLOAD_ROOT = join(process.cwd(), 'uploads');
const COURSE_UPLOAD_ROOT = join(UPLOAD_ROOT, 'courses');
const VIDEO_DIR = join(COURSE_UPLOAD_ROOT, 'videos');
const ATTACHMENT_DIR = join(COURSE_UPLOAD_ROOT, 'attachments');

function ensureDir(dirPath) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

function toInt(value, fallback = null) {
    if (value === '' || value == null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback = null) {
    if (value === '' || value == null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value) {
    if (value == null) return null;
    const text = String(value).trim();
    return text.length ? text : null;
}

function slugify(value) {
    return String(value || 'course')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'course';
}

function generateMeetingLink(title) {
    const roomId = `${slugify(title)}-${uuidv4().slice(0, 8)}`;
    return `https://meet.jit.si/${roomId}`;
}

function readFormValue(fields, key) {
    const value = fields[key];
    if (Array.isArray(value)) return value[0];
    return value;
}

async function saveUpload(part, targetDir, allowedKind = 'file') {
    ensureDir(targetDir);
    const originalName = part.filename || `${allowedKind}-${Date.now()}`;
    const fileExt = extname(originalName);
    const safeName = `${Date.now()}-${uuidv4().slice(0, 8)}${fileExt}`;
    const absolutePath = join(targetDir, safeName);
    const relativePath = `/uploads/courses/${targetDir === VIDEO_DIR ? 'videos' : 'attachments'}/${safeName}`;

    let size = 0;
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            size += chunk.length;
            callback(null, chunk);
        },
    });

    await pipeline(part.file, counter, createWriteStream(absolutePath));

    return {
        path: relativePath,
        name: originalName,
        size,
        mimeType: part.mimetype,
    };
}

function removeFile(relativePath) {
    if (!relativePath) return;
    const absolutePath = join(process.cwd(), relativePath.replace(/^\//, ''));
    if (existsSync(absolutePath)) {
        try {
            unlinkSync(absolutePath);
        } catch {
            // ignore file cleanup issues
        }
    }
}

function parseJsonMaybe(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function serializeCourse(row, viewerId = null, extra = {}) {
    const video = row.video_path
        ? { url: row.video_path, name: row.video_name, size: row.video_size, kind: 'video' }
        : null;
    const attachment = row.attachment_path
        ? { url: row.attachment_path, name: row.attachment_name, kind: 'attachment' }
        : null;

    return {
        ...row,
        category_id: row.category_id ?? null,
        experience_years: row.experience_years ?? 0,
        price: Number(row.price || 0),
        active: !!row.active,
        enrollment_count: Number(row.enrollment_count || 0),
        is_subscribed: !!row.is_subscribed,
        providerProfile: extra.providerProfile || null,
        materials: [video, attachment].filter(Boolean),
    };
}

function courseSelectClause(viewerId = null) {
    return `
    SELECT
      c.*,
      cat.name as category_name,
      u.name as provider_name,
      u.phone as provider_phone,
      pp.designation as provider_designation,
      pp.experience_years as provider_experience_years,
      pp.expertise as provider_expertise,
      pp.bio as provider_bio,
      (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id) as enrollment_count,
      ${viewerId ? 'EXISTS(SELECT 1 FROM course_enrollments ce2 WHERE ce2.course_id = c.id AND ce2.user_id = ?)' : '0'} as is_subscribed
    FROM courses c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN users u ON c.provider_id = u.id
    LEFT JOIN provider_profiles pp ON pp.user_id = u.id
  `;
}

function getCourseById(courseId, viewerId = null) {
    const params = viewerId ? [viewerId, courseId] : [courseId];
    return db.prepare(`${courseSelectClause(viewerId)} WHERE c.id = ?`).get(...params);
}

async function readMultipartFields(request) {
    const fields = {};
    const files = {};

    for await (const part of request.parts()) {
        if (part.type === 'file') {
            if (part.fieldname === 'video' && part.mimetype && !part.mimetype.startsWith('video/')) {
                throw new Error('Video upload must be a video file');
            }
            const targetDir = part.fieldname === 'video' ? VIDEO_DIR : ATTACHMENT_DIR;
            files[part.fieldname] = await saveUpload(part, targetDir, part.fieldname);
        } else {
            fields[part.fieldname] = part.value;
        }
    }

    return { fields, files };
}

function requireOwnerOrAdmin(course, user) {
    return course.provider_id === user.id || user.role === 'admin';
}

async function notifyCourseSubscribers(course, payload = {}) {
    const subscribers = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.phone
    FROM course_enrollments ce
    JOIN users u ON ce.user_id = u.id
    WHERE ce.course_id = ?
  `).all(course.id);

    const title = payload.title || course.title;
    const body = payload.body || `A new update is available for ${course.title}`;
    const notificationType = payload.type || 'course_meeting_updated';

    for (const subscriber of subscribers) {
        db.prepare(
            `INSERT INTO notifications (user_id, type, title, body, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(subscriber.id, notificationType, title, body, JSON.stringify({ courseId: course.id, ...payload }));

        sendToUser(subscriber.id, 'COURSE_NOTIFICATION', {
            courseId: course.id,
            title,
            body,
            course,
            ...payload,
        });

        if (subscriber.phone && payload.meetingLink) {
            sendMeetingLinkSMS(subscriber.phone, course.title, payload.meetingLink, payload.meetingTime, payload.meetingDate)
                .catch((err) => console.error(`[SMS] Failed for ${subscriber.id}:`, err));
        }
    }

    return subscribers.length;
}

export default async function courseRoutes(fastify) {
    // GET /api/courses — public list
    fastify.get('/', async (request) => {
        const { search, category, provider_id, page = 1, limit = 20 } = request.query;
        const viewerId = request.user?.id || null;
        const offset = (Number(page) - 1) * Number(limit);

        const conditions = ['c.active = 1'];
        const filterParams = [];
        const rowParams = [];

        if (viewerId) {
            rowParams.push(viewerId);
        }

        if (provider_id) {
            conditions.push('c.provider_id = ?');
            filterParams.push(provider_id);
        }

        if (category) {
            conditions.push('c.category_id = ?');
            filterParams.push(Number(category));
        }

        if (search) {
            conditions.push('(c.title LIKE ? OR c.description LIKE ? OR pp.expertise LIKE ?)');
            filterParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const list = db.prepare(`
      ${courseSelectClause(viewerId)}
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...rowParams, ...filterParams, Number(limit), Number(offset));

        const total = db.prepare(`
      SELECT COUNT(*) as total
      FROM courses c
      LEFT JOIN provider_profiles pp ON pp.user_id = c.provider_id
      ${whereClause}
    `).get(...filterParams).total;

        return {
            courses: list.map((row) => serializeCourse(row)),
            total,
            page: Number(page),
            totalPages: Math.ceil(total / Number(limit || 1)),
        };
    });

    // GET /api/courses/me — user-owned or enrolled courses
    fastify.get('/me', { preHandler: [fastify.authenticate] }, async (request) => {
        const userId = request.user.id;
        const role = request.user.role;

        let rows;
        if (role === 'provider' || role === 'admin') {
            rows = db.prepare(`
        ${courseSelectClause(userId)}
        WHERE c.provider_id = ?
        ORDER BY c.updated_at DESC
      `).all(userId, userId);
        } else {
            rows = db.prepare(`
        ${courseSelectClause(userId)}
        WHERE EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.user_id = ?)
        ORDER BY c.updated_at DESC
      `).all(userId, userId);
        }

        return { courses: rows.map((row) => serializeCourse(row)) };
    });

    // GET /api/courses/:id — course detail
    fastify.get('/:id', async (request, reply) => {
        const viewerId = request.user?.id || null;
        const course = getCourseById(request.params.id, viewerId);

        if (!course) {
            return reply.status(404).send({ message: 'Course not found' });
        }

        const isSubscriber = viewerId
            ? db.prepare('SELECT 1 FROM course_enrollments WHERE course_id = ? AND user_id = ?').get(course.id, viewerId)
            : null;

        if (!course.active && course.provider_id !== viewerId && !isSubscriber && request.user?.role !== 'admin') {
            return reply.status(404).send({ message: 'Course not found' });
        }

        return {
            course: serializeCourse(course, viewerId, {
                providerProfile: course.provider_designation || course.provider_experience_years || course.provider_expertise || course.provider_bio
                    ? {
                        designation: course.provider_designation,
                        experience_years: course.provider_experience_years,
                        expertise: course.provider_expertise,
                        bio: course.provider_bio,
                    }
                    : null,
            }),
        };
    });

    // POST /api/courses — create course
    fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        if (request.user.role !== 'provider' && request.user.role !== 'admin') {
            return reply.status(403).send({ message: 'Only providers can create courses' });
        }

        let fields = request.body || {};
        let files = {};
        if (request.isMultipart()) {
            try {
                ({ fields, files } = await readMultipartFields(request));
            } catch (err) {
                return reply.status(400).send({ message: err.message || 'Invalid upload' });
            }
        }

        const title = toText(readFormValue(fields, 'title'));
        const description = toText(readFormValue(fields, 'description'));
        if (!title || !description) {
            return reply.status(400).send({ message: 'Title and description are required' });
        }

        const providerId = request.user.id;
        const designation = toText(readFormValue(fields, 'designation'));
        const experienceYears = toInt(readFormValue(fields, 'experience_years'), 0) || 0;
        const expertise = toText(readFormValue(fields, 'expertise'));
        const price = toFloat(readFormValue(fields, 'price'), 0) || 0;
        const level = toText(readFormValue(fields, 'level')) || 'beginner';
        const duration = toText(readFormValue(fields, 'duration'));
        const categoryId = toInt(readFormValue(fields, 'category_id'));
        const meetingTime = toText(readFormValue(fields, 'meeting_time'));
        const meetingDate = toText(readFormValue(fields, 'meeting_date'));
        const meetingLink = toText(readFormValue(fields, 'meeting_link')) || generateMeetingLink(title);
        const active = readFormValue(fields, 'active') === '0' ? 0 : 1;

        if (designation || expertise || experienceYears) {
            db.prepare(
                `INSERT INTO provider_profiles (user_id, designation, experience_years, expertise, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           designation = COALESCE(excluded.designation, provider_profiles.designation),
           experience_years = COALESCE(excluded.experience_years, provider_profiles.experience_years),
           expertise = COALESCE(excluded.expertise, provider_profiles.expertise),
           updated_at = datetime('now')`
            ).run(providerId, designation, experienceYears, expertise);
        }

        const videoFile = files.video || null;
        const attachmentFile = files.attachment || null;

        const result = db.prepare(`
      INSERT INTO courses (
        title, description, category_id, provider_id, designation, experience_years,
        expertise, price, level, duration, meeting_link, meeting_time, meeting_date,
        video_path, video_name, video_size, attachment_path, attachment_name, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            title,
            description,
            categoryId,
            providerId,
            designation,
            experienceYears,
            expertise,
            price,
            level,
            duration,
            meetingLink,
            meetingTime,
            meetingDate,
            videoFile?.path || null,
            videoFile?.name || null,
            videoFile?.size || 0,
            attachmentFile?.path || null,
            attachmentFile?.name || null,
            active,
        );

        const course = getCourseById(result.lastInsertRowid, providerId);
        return reply.status(201).send({ course: serializeCourse(course, providerId) });
    });

    // PUT /api/courses/:id — update course
    fastify.put('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const existing = db.prepare('SELECT * FROM courses WHERE id = ?').get(request.params.id);
        if (!existing) {
            return reply.status(404).send({ message: 'Course not found' });
        }

        if (!requireOwnerOrAdmin(existing, request.user)) {
            return reply.status(403).send({ message: 'Not authorized' });
        }

        let fields = request.body || {};
        let files = {};
        if (request.isMultipart()) {
            try {
                ({ fields, files } = await readMultipartFields(request));
            } catch (err) {
                return reply.status(400).send({ message: err.message || 'Invalid upload' });
            }
        }

        const title = toText(readFormValue(fields, 'title'));
        const description = toText(readFormValue(fields, 'description'));
        const designation = toText(readFormValue(fields, 'designation'));
        const experienceYears = toInt(readFormValue(fields, 'experience_years'));
        const expertise = toText(readFormValue(fields, 'expertise'));
        const price = toFloat(readFormValue(fields, 'price'));
        const level = toText(readFormValue(fields, 'level'));
        const duration = toText(readFormValue(fields, 'duration'));
        const categoryId = toInt(readFormValue(fields, 'category_id'));
        const meetingTime = toText(readFormValue(fields, 'meeting_time'));
        const meetingDate = toText(readFormValue(fields, 'meeting_date'));
        const meetingLink = toText(readFormValue(fields, 'meeting_link'));
        const active = readFormValue(fields, 'active');

        if (files.video?.path) {
            removeFile(existing.video_path);
        }
        if (files.attachment?.path) {
            removeFile(existing.attachment_path);
        }

        db.prepare(`
      UPDATE courses SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        category_id = COALESCE(?, category_id),
        designation = COALESCE(?, designation),
        experience_years = COALESCE(?, experience_years),
        expertise = COALESCE(?, expertise),
        price = COALESCE(?, price),
        level = COALESCE(?, level),
        duration = COALESCE(?, duration),
        meeting_link = COALESCE(?, meeting_link),
        meeting_time = COALESCE(?, meeting_time),
        meeting_date = COALESCE(?, meeting_date),
        video_path = COALESCE(?, video_path),
        video_name = COALESCE(?, video_name),
        video_size = COALESCE(?, video_size),
        attachment_path = COALESCE(?, attachment_path),
        attachment_name = COALESCE(?, attachment_name),
        active = COALESCE(?, active),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
            title,
            description,
            categoryId,
            designation,
            experienceYears,
            expertise,
            price,
            level,
            duration,
            meetingLink,
            meetingTime,
            meetingDate,
            files.video?.path || null,
            files.video?.name || null,
            files.video?.size || null,
            files.attachment?.path || null,
            files.attachment?.name || null,
            active == null ? null : Number(active),
            request.params.id,
        );

        if (designation || expertise || Number.isFinite(experienceYears)) {
            db.prepare(
                `INSERT INTO provider_profiles (user_id, designation, experience_years, expertise, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           designation = COALESCE(excluded.designation, provider_profiles.designation),
           experience_years = COALESCE(excluded.experience_years, provider_profiles.experience_years),
           expertise = COALESCE(excluded.expertise, provider_profiles.expertise),
           updated_at = datetime('now')`
            ).run(existing.provider_id, designation || null, Number.isFinite(experienceYears) ? experienceYears : null, expertise || null);
        }

        const updated = getCourseById(existing.id, request.user.id);
        return { course: serializeCourse(updated, request.user.id) };
    });

    // POST /api/courses/:id/enroll — subscribe user to course
    fastify.post('/:id/enroll', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(request.params.id);
        if (!course) {
            return reply.status(404).send({ message: 'Course not found' });
        }

        const userId = request.user.id;

        db.prepare(
            `INSERT INTO course_enrollments (course_id, user_id, subscribed_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(course_id, user_id) DO UPDATE SET updated_at = datetime('now')`
        ).run(course.id, userId);

        const updatedCourse = getCourseById(course.id, userId);
        db.prepare(
            `INSERT INTO notifications (user_id, type, title, body, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(
            userId,
            'course_enrolled',
            'Course subscribed',
            `You are subscribed to ${course.title}`,
            JSON.stringify({ courseId: course.id }),
        );

        return { course: serializeCourse(updatedCourse, userId), enrolled: true };
    });

    // POST /api/courses/:id/meeting/share — provider notifies all subscribers
    fastify.post('/:id/meeting/share', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(request.params.id);
        if (!course) {
            return reply.status(404).send({ message: 'Course not found' });
        }

        if (!requireOwnerOrAdmin(course, request.user)) {
            return reply.status(403).send({ message: 'Not authorized' });
        }

        const body = request.body || {};
        const meetingLink = toText(body.meeting_link) || course.meeting_link || generateMeetingLink(course.title);
        const meetingTime = toText(body.meeting_time) || course.meeting_time || null;
        const meetingDate = toText(body.meeting_date) || course.meeting_date || null;

        db.prepare(
            `UPDATE courses SET meeting_link = ?, meeting_time = ?, meeting_date = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(meetingLink, meetingTime, meetingDate, course.id);

        const updatedCourse = getCourseById(course.id, request.user.id);
        const notifiedCount = await notifyCourseSubscribers(updatedCourse, {
            type: 'course_meeting_updated',
            title: `Live session for ${updatedCourse.title}`,
            body: `${updatedCourse.title} now has a live session link`,
            meetingLink,
            meetingTime,
            meetingDate,
        });

        return { course: serializeCourse(updatedCourse, request.user.id), notifiedCount };
    });
}
