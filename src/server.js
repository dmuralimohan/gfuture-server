import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import authRoutes from './routes/auth.js';
import serviceRoutes from './routes/services.js';
import orderRoutes from './routes/orders.js';
import categoryRoutes from './routes/categories.js';
import otpRoutes from './routes/otp.js';
import paymentRoutes from './routes/payments.js';
import adminRoutes from './routes/admin.js';
import planRoutes from './routes/plans.js';
import offerRoutes from './routes/offers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// CORS — allowed origins from env or defaults
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000', 'http://3.95.226.54:3001', 'http://10.69.67.139:5173'];

await app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET || 'gfuture-super-secret-key-2026',
  sign: { expiresIn: '30m' }, // Access token = 30 minutes
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
app.register(categoryRoutes, { prefix: '/api/categories' });
app.register(otpRoutes, { prefix: '/api/otp' });
app.register(paymentRoutes, { prefix: '/api/payments' });
app.register(adminRoutes, { prefix: '/api/admin' });
app.register(planRoutes, { prefix: '/api/plans' });
app.register(offerRoutes, { prefix: '/api/offers' });

// Health check
app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Serve Client Build (static SPA) ─────────────────────────
const clientDistPath = join(__dirname, '..', '..', 'client', 'dist');
if (existsSync(clientDistPath)) {
  // Serve static assets (JS, CSS, images, etc.)
  await app.register(fastifyStatic, {
    root: clientDistPath,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback — all non-API routes serve index.html
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ message: 'API route not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn('Client dist not found at ' + clientDistPath + '. Run "npm run build" in client/ first.');
}

// Start
const PORT = process.env.PORT || 3001;

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🚀 GFuture API running on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

