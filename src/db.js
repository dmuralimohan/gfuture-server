import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * DB SAFETY RULES
 * - Never DROP / truncate / replace the database file.
 * - Never recreate tables that already exist.
 * - Only ADD missing columns / tables / indexes.
 * - Refuse to create a brand-new empty DB unless ALLOW_NEW_DB=true.
 *
 * EC2 example:
 *   DB_PATH=/home/ec2-user/file/gfuture-server/gfuture.db
 */
const defaultDbPath = join(__dirname, '..', 'gfuture.db');
const configuredDbPath = process.env.DB_PATH
  ? (isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : resolve(process.cwd(), process.env.DB_PATH))
  : defaultDbPath;
const dbPath = resolve(configuredDbPath);
const allowNewDb = String(process.env.ALLOW_NEW_DB || '').toLowerCase() === 'true';
const dbExistedBeforeOpen = existsSync(dbPath);
const dbSizeBeforeOpen = dbExistedBeforeOpen ? statSync(dbPath).size : 0;

console.log(`[DB] Using database file: ${dbPath}`);
console.log(`[DB] File existed before open: ${dbExistedBeforeOpen} (size=${dbSizeBeforeOpen} bytes)`);

if (!dbExistedBeforeOpen) {
  if (!allowNewDb) {
    console.error('[DB] FATAL: Database file does not exist.');
    console.error(`[DB] Expected file: ${dbPath}`);
    console.error('[DB] Refusing to create a new empty database (this protects existing production data).');
    console.error('[DB] Fix: set DB_PATH to your real gfuture.db, or set ALLOW_NEW_DB=true only for intentional fresh setups.');
    throw new Error(`Database file missing at ${dbPath}. Set DB_PATH or ALLOW_NEW_DB=true.`);
  }
  console.warn('[DB] ALLOW_NEW_DB=true — creating a NEW empty database at this path.');
}

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    is_approved INTEGER NOT NULL DEFAULT 1,
    approval_status TEXT NOT NULL DEFAULT 'approved',
    profile_picture TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS provider_profiles (
    user_id TEXT PRIMARY KEY,
    designation TEXT,
    experience_years INTEGER DEFAULT 0,
    expertise TEXT,
    bio TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT,
    image TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    provider_id TEXT,
    price REAL NOT NULL,
    rating REAL DEFAULT 0,
    reviews INTEGER DEFAULT 0,
    image TEXT,
    image_links TEXT,
    location TEXT,
    description TEXT,
    duration TEXT,
    warranty TEXT,
    includes TEXT,
    type TEXT NOT NULL DEFAULT 'service',
    size_value TEXT,
    size_unit TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS service_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    rating REAL NOT NULL,
    comment TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    provider_id TEXT,
    status TEXT DEFAULT 'pending',
    subtotal REAL NOT NULL,
    platform_fee REAL NOT NULL,
    discount_amount REAL DEFAULT 0,
    coupon_code TEXT,
    total REAL NOT NULL,
    address TEXT,
    scheduled_date TEXT,
    scheduled_time TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES users(id),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    service_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    price REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS otp_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    otp TEXT NOT NULL,
    verified INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    amount REAL NOT NULL,
    upi_id TEXT,
    status TEXT DEFAULT 'pending',
    method TEXT DEFAULT 'razorpay',
    transaction_ref TEXT,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS payment_alerts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    source TEXT NOT NULL DEFAULT 'system',
    payment_id TEXT,
    order_id TEXT,
    message TEXT NOT NULL,
    metadata TEXT,
    fingerprint TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (payment_id) REFERENCES payments(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_verifications(phone, expires_at);
  CREATE INDEX IF NOT EXISTS idx_payment_order ON payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_payment_alerts_created ON payment_alerts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payment_alerts_resolved ON payment_alerts(resolved, severity, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_alerts_fingerprint ON payment_alerts(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);
  CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);
  CREATE INDEX IF NOT EXISTS idx_services_active ON services(active);
  CREATE INDEX IF NOT EXISTS idx_service_reviews_service ON service_reviews(service_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_service_reviews_user ON service_reviews(user_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_service ON order_items(service_id);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT '₹',
    description TEXT,
    image TEXT,
    target TEXT NOT NULL DEFAULT 'both',
    features TEXT,
    recommended INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    cta TEXT DEFAULT 'Choose Plan',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    plan_id INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    subscribed_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_plans_user ON user_plans(user_id, status);

  CREATE TABLE IF NOT EXISTS plan_subscription_payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'pending',
    is_first_subscription INTEGER NOT NULL DEFAULT 0,
    razorpay_order_id TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    discount_percent REAL DEFAULT 0,
    discount_flat REAL DEFAULT 0,
    code TEXT UNIQUE,
    target TEXT NOT NULL DEFAULT 'both',
    image TEXT,
    badge TEXT,
    valid_from TEXT DEFAULT (datetime('now')),
    valid_until TEXT,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(active, valid_until);
  CREATE INDEX IF NOT EXISTS idx_user_plans_plan ON user_plans(plan_id);
  CREATE INDEX IF NOT EXISTS idx_offers_provider ON offers(provider_id);

  -- Wallet & Credit Points
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    balance REAL NOT NULL DEFAULT 0,
    credit_points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    credit_points INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    reference_type TEXT,
    reference_id TEXT,
    balance_after REAL,
    credits_after INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS wallet_topups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    razorpay_order_id TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_txn_user ON wallet_transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_txn_type ON wallet_transactions(type);
  CREATE INDEX IF NOT EXISTS idx_wallet_topups_user ON wallet_topups(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wallet_topups_status ON wallet_topups(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_plan_subscription_payments_user ON plan_subscription_payments(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_plan_subscription_payments_status ON plan_subscription_payments(status, created_at DESC);

  -- Platform Settings
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    label TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Insert default settings if not present
  INSERT OR IGNORE INTO settings (key, value, label) VALUES ('platform_fee_rate', '0', 'Platform Fee (%)');
  INSERT OR IGNORE INTO settings (key, value, label) VALUES ('extra_fee_label', '', 'Extra Fee Label');
  INSERT OR IGNORE INTO settings (key, value, label) VALUES ('extra_fee_amount', '0', 'Extra Fee Amount (₹)');

  -- G-Rider: ride-hailing feature
  CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    rider_id TEXT,
    status TEXT DEFAULT 'searching',
    vehicle_type TEXT NOT NULL DEFAULT 'bike',
    pickup_address TEXT NOT NULL,
    pickup_lat REAL,
    pickup_lng REAL,
    drop_address TEXT NOT NULL,
    drop_lat REAL,
    drop_lng REAL,
    distance_km REAL,
    estimated_fare REAL,
    final_fare REAL,
    otp TEXT,
    rating REAL,
    rating_comment TEXT,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT,
    cancelled_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES users(id),
    FOREIGN KEY (rider_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    vehicle_type TEXT NOT NULL DEFAULT 'bike',
    vehicle_number TEXT,
    vehicle_model TEXT,
    is_online INTEGER DEFAULT 0,
    current_lat REAL,
    current_lng REAL,
    rating REAL DEFAULT 4.5,
    total_rides INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_rides_customer ON rides(customer_id);
  CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_id);
  CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
  CREATE INDEX IF NOT EXISTS idx_riders_user ON riders(user_id);
  CREATE INDEX IF NOT EXISTS idx_riders_online ON riders(is_online, vehicle_type);

  -- Meeting Requests (customer <-> provider)
  CREATE TABLE IF NOT EXISTS meeting_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT DEFAULT 'requested',
    meeting_link TEXT,
    meeting_time TEXT,
    meeting_date TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (customer_id) REFERENCES users(id),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_order ON meeting_requests(order_id);
  CREATE INDEX IF NOT EXISTS idx_meeting_customer ON meeting_requests(customer_id);
  CREATE INDEX IF NOT EXISTS idx_meeting_provider ON meeting_requests(provider_id);

  -- Promo Cards (editable from admin)
  CREATE TABLE IF NOT EXISTS promo_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL,
    description TEXT,
    cta TEXT DEFAULT 'Book now',
    bg TEXT DEFAULT 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
    image TEXT,
    link TEXT DEFAULT '/services',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category_id INTEGER,
    provider_id TEXT NOT NULL,
    designation TEXT,
    experience_years INTEGER DEFAULT 0,
    expertise TEXT,
    price REAL DEFAULT 0,
    level TEXT DEFAULT 'beginner',
    duration TEXT,
    meeting_link TEXT,
    meeting_time TEXT,
    meeting_date TEXT,
    video_path TEXT,
    video_name TEXT,
    video_size INTEGER DEFAULT 0,
    attachment_path TEXT,
    attachment_name TEXT,
    intro_video_url TEXT,
    intro_video_name TEXT,
    intro_video_size INTEGER DEFAULT 0,
    intro_video_duration INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS course_enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    subscribed_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(course_id, user_id),
    FOREIGN KEY (course_id) REFERENCES courses(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    payload TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_courses_provider ON courses(provider_id);
  CREATE INDEX IF NOT EXISTS idx_courses_category ON courses(category_id);
  CREATE INDEX IF NOT EXISTS idx_courses_active ON courses(active);
  CREATE INDEX IF NOT EXISTS idx_course_enrollments_course ON course_enrollments(course_id);
  CREATE INDEX IF NOT EXISTS idx_course_enrollments_user ON course_enrollments(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
`);

// Migrations: ADD missing columns only. Never DROP / rename / rewrite tables.
// IMPORTANT: run only after CREATE TABLE IF NOT EXISTS above.
// Prefer nullable + DEFAULT for ALTER safety on older SQLite / existing rows.
const migrations = [
  { table: 'users', column: 'is_approved', type: 'INTEGER DEFAULT 1' },
  { table: 'users', column: 'approval_status', type: "TEXT DEFAULT 'approved'" },
  { table: 'users', column: 'profile_picture', type: 'TEXT' },
  { table: 'users', column: 'referral_code', type: 'TEXT' },
  { table: 'users', column: 'referred_by_user_id', type: 'TEXT' },
  { table: 'users', column: 'referral_rewarded_at', type: 'TEXT' },
  { table: 'users', column: 'is_email_verified', type: 'INTEGER DEFAULT 1' },
  { table: 'users', column: 'address_street', type: 'TEXT' },
  { table: 'users', column: 'address_landmark', type: 'TEXT' },
  { table: 'users', column: 'address_state', type: 'TEXT' },
  { table: 'users', column: 'address_pincode', type: 'TEXT' },
  { table: 'users', column: 'default_address', type: 'TEXT' },
  { table: 'users', column: 'address_name', type: 'TEXT' },
  { table: 'users', column: 'address_phone', type: 'TEXT' },
  { table: 'users', column: 'address_detail', type: 'TEXT' },
  { table: 'orders', column: 'discount_amount', type: 'REAL DEFAULT 0' },
  { table: 'orders', column: 'coupon_code', type: 'TEXT' },
  { table: 'services', column: 'type', type: "TEXT DEFAULT 'service'" },
  { table: 'services', column: 'size_value', type: 'TEXT' },
  { table: 'services', column: 'size_unit', type: 'TEXT' },
  { table: 'services', column: 'image_links', type: 'TEXT' },
  { table: 'services', column: 'location', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_order_id', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_payment_id', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_signature', type: 'TEXT' },
  { table: 'orders', column: 'meeting_requested', type: 'INTEGER DEFAULT 0' },
  { table: 'courses', column: 'intro_video_url', type: 'TEXT' },
  { table: 'courses', column: 'intro_video_name', type: 'TEXT' },
  { table: 'courses', column: 'intro_video_size', type: 'INTEGER DEFAULT 0' },
  { table: 'courses', column: 'intro_video_duration', type: 'INTEGER DEFAULT 0' },
  { table: 'plans', column: 'image', type: 'TEXT' },
];

for (const { table, column, type } of migrations) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    // Skip if table is missing (PRAGMA returns [] for unknown tables).
    if (!columns.length) continue;
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[DB] Added column ${table}.${column}`);
  } catch (err) {
    // Never wipe/retry destructively — log and continue so existing DB keeps working.
    console.warn(`[DB] Skipped adding ${table}.${column}: ${err.message}`);
  }
}

try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique
    ON users(referral_code)
    WHERE referral_code IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_users_referred_by
    ON users(referred_by_user_id);

    CREATE TABLE IF NOT EXISTS referral_rewards (
      id TEXT PRIMARY KEY,
      referrer_user_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL,
      plan_id INTEGER,
      plan_amount REAL NOT NULL DEFAULT 0,
      reward_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (referrer_user_id) REFERENCES users(id),
      FOREIGN KEY (referred_user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      UNIQUE(referred_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer
    ON referral_rewards(referrer_user_id, created_at DESC);
  `);
} catch (err) {
  console.warn('[DB] Referral schema/index setup skipped:', err.message);
}

function referralToken(input = '') {
  const cleaned = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, 4).padEnd(4, 'X');
}

function randomSuffix() {
  return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(2, 8);
}

function generateUniqueReferralCode(seed = 'GFUT') {
  for (let i = 0; i < 20; i++) {
    const code = `${referralToken(seed)}${randomSuffix()}`;
    const exists = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (!exists) return code;
  }

  return `${referralToken(seed)}${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

try {
  const usersWithoutReferral = db
    .prepare("SELECT id, name, email FROM users WHERE referral_code IS NULL OR trim(referral_code) = ''")
    .all();

  for (const user of usersWithoutReferral) {
    const seed = user.name || user.email || 'GFUT';
    const referralCode = generateUniqueReferralCode(seed);
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(referralCode, user.id);
  }
} catch (err) {
  console.warn('[DB] Referral backfill skipped:', err.message);
}

// Ensure core categories exist for new marketplace flows (additive only).
try {
  db.prepare("INSERT OR IGNORE INTO categories (name, icon) VALUES (?, ?)")
    .run('Meat', 'Restaurant');
} catch (err) {
  console.warn('[DB] Meat category seed skipped:', err.message);
}

// Backfill location for existing products without location (non-destructive).
try {
  db.prepare(
    "UPDATE services SET location = 'Kadalur' WHERE type = 'product' AND (location IS NULL OR trim(location) = '')"
  ).run();
} catch (err) {
  console.warn('[DB] Product location backfill skipped:', err.message);
}

// Course Meetings — one meeting link per course service, shared with all purchasers
db.exec(`
  CREATE TABLE IF NOT EXISTS course_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    meeting_link TEXT,
    meeting_time TEXT,
    meeting_date TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (provider_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_course_meetings_service ON course_meetings(service_id);

  -- Password resets via SMS OTP
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    otp TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_phone ON password_resets(phone, expires_at);
`);

try {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0;
  const orderCount = db.prepare('SELECT COUNT(*) AS count FROM orders').get()?.count ?? 0;
  console.log(`[DB] Ready. users=${userCount}, orders=${orderCount}`);
  if (dbExistedBeforeOpen && userCount === 0 && dbSizeBeforeOpen < 4096) {
    console.warn('[DB] WARNING: Opened an existing but nearly-empty DB file. Confirm DB_PATH points to your production gfuture.db.');
  }
  if (!dbExistedBeforeOpen) {
    console.warn('[DB] WARNING: Started with a brand-new empty database. Existing data is NOT here.');
  }
} catch (err) {
  console.warn('[DB] Could not verify row counts:', err.message);
}

export default db;

