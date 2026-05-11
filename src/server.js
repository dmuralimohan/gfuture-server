import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import authRoutes from './routes/auth.js';
import serviceRoutes from './routes/services.js';
import orderRoutes from './routes/orders.js';
import courseRoutes from './routes/courses.js';
import notificationRoutes from './routes/notifications.js';
import categoryRoutes from './routes/categories.js';
import otpRoutes from './routes/otp.js';
import paymentRoutes from './routes/payments.js';
import adminRoutes from './routes/admin.js';
import planRoutes from './routes/plans.js';
import offerRoutes from './routes/offers.js';
import walletRoutes from './routes/wallet.js';
import rideRoutes from './routes/rides.js';
import { addConnection, removeConnection, updateRiderLocation, getConnection } from './ws.js';
import db from './db.js';

const app = Fastify({ logger: true });

const uploadRoot = join(process.cwd(), 'uploads');
if (!existsSync(uploadRoot)) {
  mkdirSync(uploadRoot, { recursive: true });
}

// CORS — allowed origins from env or defaults
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000', 'http://3.95.226.54:3001', 'http://10.69.67.139:5173'];

await app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET || 'gfuture_super_secret_key_2026', //@author muralimohand
  sign: { expiresIn: '30m' }, // Access token = 30 minutes
});

await app.register(multipart, {
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 2,
  },
});

await app.register(staticPlugin, {
  root: uploadRoot,
  prefix: '/uploads/',
});

// Decorators
app.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ message: 'Authentication required', error: 'Unauthorized' });
  }
});

// Routes
app.register(authRoutes, { prefix: '/api/auth' });
app.register(serviceRoutes, { prefix: '/api/services' });
app.register(orderRoutes, { prefix: '/api/orders' });
app.register(courseRoutes, { prefix: '/api/courses' });
app.register(notificationRoutes, { prefix: '/api/notifications' });
app.register(categoryRoutes, { prefix: '/api/categories' });
app.register(otpRoutes, { prefix: '/api/otp' });
app.register(paymentRoutes, { prefix: '/api/payments' });
app.register(adminRoutes, { prefix: '/api/admin' });
app.register(planRoutes, { prefix: '/api/plans' });
app.register(offerRoutes, { prefix: '/api/offers' });
app.register(walletRoutes, { prefix: '/api/wallet' });
app.register(rideRoutes, { prefix: '/api/rides' });

// Health check
app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── WebSocket ────────────────────────────────────────────────
await app.register(websocket);

// Helper: verify JWT from query string token
function verifyWsToken(token) {
  try {
    return app.jwt.verify(token);
  } catch {
    return null;
  }
}

// Rider WebSocket: /ws/rider?token=JWT
app.get('/ws/rider', { websocket: true }, (socket, req) => {
  const token = req.query.token;
  const user = verifyWsToken(token);
  if (!user) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Unauthorized' }));
    socket.close();
    return;
  }

  // Check rider record exists
  const rider = db.prepare('SELECT * FROM riders WHERE user_id = ? AND verified = 1').get(user.id);
  if (!rider) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Not a registered rider' }));
    socket.close();
    return;
  }

  // Register connection
  addConnection(user.id, socket, 'rider', {
    lat: rider.current_lat,
    lng: rider.current_lng,
    vehicleType: rider.vehicle_type,
  });

  // Mark rider online in DB
  db.prepare('UPDATE riders SET is_online = 1, updated_at = datetime(\'now\') WHERE user_id = ?').run(user.id);

  socket.send(JSON.stringify({ type: 'CONNECTED', role: 'rider', userId: user.id }));
  app.log.info(`Rider WS connected: ${user.id}`);

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'LOCATION_UPDATE':
          if (msg.lat != null && msg.lng != null) {
            updateRiderLocation(user.id, msg.lat, msg.lng);
            db.prepare('UPDATE riders SET current_lat = ?, current_lng = ?, updated_at = datetime(\'now\') WHERE user_id = ?')
              .run(msg.lat, msg.lng, user.id);
          }
          break;
        case 'GO_OFFLINE':
          db.prepare('UPDATE riders SET is_online = 0, updated_at = datetime(\'now\') WHERE user_id = ?').run(user.id);
          removeConnection(user.id);
          socket.send(JSON.stringify({ type: 'STATUS', online: false }));
          break;
        case 'GO_ONLINE':
          db.prepare('UPDATE riders SET is_online = 1, updated_at = datetime(\'now\') WHERE user_id = ?').run(user.id);
          addConnection(user.id, socket, 'rider', {
            lat: msg.lat || rider.current_lat,
            lng: msg.lng || rider.current_lng,
            vehicleType: rider.vehicle_type,
          });
          socket.send(JSON.stringify({ type: 'STATUS', online: true }));
          break;
        case 'PING':
          socket.send(JSON.stringify({ type: 'PONG' }));
          break;
      }
    } catch { /* ignore bad messages */ }
  });

  socket.on('close', () => {
    db.prepare('UPDATE riders SET is_online = 0, updated_at = datetime(\'now\') WHERE user_id = ?').run(user.id);
    removeConnection(user.id);
    app.log.info(`Rider WS disconnected: ${user.id}`);
  });
});

// Customer WebSocket: /ws/customer?token=JWT
app.get('/ws/customer', { websocket: true }, (socket, req) => {
  const token = req.query.token;
  const user = verifyWsToken(token);
  if (!user) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Unauthorized' }));
    socket.close();
    return;
  }

  addConnection(user.id, socket, 'customer');
  socket.send(JSON.stringify({ type: 'CONNECTED', role: 'customer', userId: user.id }));
  app.log.info(`Customer WS connected: ${user.id}`);

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'PING') {
        socket.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch { /* ignore */ }
  });

  socket.on('close', () => {
    removeConnection(user.id);
    app.log.info(`Customer WS disconnected: ${user.id}`);
  });
});

// Provider WebSocket: /ws/provider?token=JWT
app.get('/ws/provider', { websocket: true }, (socket, req) => {
  const token = req.query.token;
  const user = verifyWsToken(token);
  if (!user) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Unauthorized' }));
    socket.close();
    return;
  }

  addConnection(user.id, socket, 'provider');
  socket.send(JSON.stringify({ type: 'CONNECTED', role: 'provider', userId: user.id }));
  app.log.info(`Provider WS connected: ${user.id}`);

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'PING') {
        socket.send(JSON.stringify({ type: 'PONG' }));
      }
    } catch { /* ignore */ }
  });

  socket.on('close', () => {
    removeConnection(user.id);
    app.log.info(`Provider WS disconnected: ${user.id}`);
  });
});

// Public settings (for platform fee display on frontend)
app.get('/api/settings/public', async (request, reply) => {
  const settings = db.prepare('SELECT key, value, label FROM settings').all();
  const map = {};
  for (const s of settings) {
    map[s.key] = { value: s.value, label: s.label };
  }
  reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  return { settings: map };
});

// Public promo cards (for home page)
app.get('/api/promo-cards', async (request, reply) => {
  const cards = db.prepare('SELECT * FROM promo_cards WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  return { promoCards: cards };
});

// Start
const PORT = process.env.PORT || 3001;

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🚀 GFuture API running on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

