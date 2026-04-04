import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'gfuture.db'));

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
    profile_picture TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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

  CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_verifications(phone, expires_at);
  CREATE INDEX IF NOT EXISTS idx_payment_order ON payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);
  CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);
  CREATE INDEX IF NOT EXISTS idx_services_active ON services(active);
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

  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_txn_user ON wallet_transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_txn_type ON wallet_transactions(type);

  -- Platform Settings
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    label TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Insert default settings if not present
  INSERT OR IGNORE INTO settings (key, value, label) VALUES ('platform_fee_rate', '1.02', 'Platform Fee (%)');
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
`);

// Migrations: add columns that may be missing in older databases
const migrations = [
  { table: 'users', column: 'profile_picture', type: 'TEXT' },
  { table: 'orders', column: 'discount_amount', type: 'REAL DEFAULT 0' },
  { table: 'orders', column: 'coupon_code', type: 'TEXT' },
  { table: 'services', column: 'type', type: "TEXT NOT NULL DEFAULT 'service'" },
  { table: 'services', column: 'size_value', type: 'TEXT' },
  { table: 'services', column: 'size_unit', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_order_id', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_payment_id', type: 'TEXT' },
  { table: 'payments', column: 'razorpay_signature', type: 'TEXT' },
  { table: 'orders', column: 'meeting_requested', type: 'INTEGER DEFAULT 0' },
];

for (const { table, column, type } of migrations) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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

export default db;

