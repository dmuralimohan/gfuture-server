# GFuture API Server

Home services marketplace — Fastify + SQLite backend.

## Setup

```bash
npm install
npm run seed     # Seeds DB with demo data
npm run dev      # Start with --watch + .env
npm start        # Production start
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `JWT_SECRET` | JWT signing secret | (built-in dev key) |
| `CORS_ORIGINS` | Comma-separated allowed origins | localhost + Vercel |
| `MERCHANT_UPI_ID` | UPI merchant ID for payments | `gfuture@upi` |
| `MERCHANT_NAME` | Merchant display name | `GFuture` |
| `TWILIO_ACCOUNT_SID` | Twilio SID for OTP | (optional) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | (optional) |
| `TWILIO_PHONE_NUMBER` | Twilio sender number | (optional) |

## Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| Customer | `customer@demo.com` | `password123` |
| Provider | `provider@demo.com` | `password123` |
| Admin | `admin@demo.com` | `password123` |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health check |
| POST | `/api/auth/signup` | No | Register |
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/refresh` | No | Refresh tokens |
| POST | `/api/auth/logout` | No | Logout |
| GET | `/api/auth/profile` | Yes | Get profile |
| PUT | `/api/auth/profile` | Yes | Update profile |
| GET | `/api/categories` | No | List categories |
| GET | `/api/services` | No | List/search/filter services |
| GET | `/api/services/:id` | No | Service detail |
| POST | `/api/services` | Provider | Create service |
| PUT | `/api/services/:id` | Owner | Update service |
| POST | `/api/orders` | Yes | Place order |
| GET | `/api/orders` | Yes | List orders |
| GET | `/api/orders/:id` | Yes | Order detail |
| PATCH | `/api/orders/:id/status` | Yes | Update status |
| POST | `/api/otp/send` | No | Send OTP |
| POST | `/api/otp/verify` | No | Verify OTP |
| POST | `/api/payments/initiate` | Yes | Create payment + QR |
| POST | `/api/payments/verify` | Yes | Confirm payment |
| GET | `/api/payments/:orderId` | Yes | Payment status |
