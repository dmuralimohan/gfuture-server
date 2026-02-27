import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';

console.log('🌱 Seeding database...');

// Seed Categories
const cats = [
  { name: 'Appliance Repair & Service', icon: 'BuildCircle' },
  { name: 'Electrician, Plumber & Carpenter', icon: 'ElectricalServices' },
  { name: 'Home Cleaning', icon: 'CleaningServices' },
  { name: 'Water Purifier', icon: 'WaterDrop' },
  { name: 'Bathroom & Kitchen', icon: 'Bathtub' },
  { name: 'AC Service & Repair', icon: 'AcUnit' },
  { name: 'Painting & Renovation', icon: 'FormatPaint' },
  { name: 'Pest Control', icon: 'BugReport' },
];

const insertCat = db.prepare('INSERT OR IGNORE INTO categories (id, name, icon) VALUES (?, ?, ?)');
cats.forEach((c, i) => insertCat.run(i + 1, c.name, c.icon));

// Seed demo users
const password = await bcrypt.hash('password123', 12);

const demoUsers = [
  { id: uuidv4(), name: 'Demo Customer', email: 'customer@demo.com', phone: '9876543210', role: 'customer' },
  { id: uuidv4(), name: 'Ravi Kumar', email: 'provider@demo.com', phone: '9876543211', role: 'provider' },
  { id: uuidv4(), name: 'Admin User', email: 'admin@demo.com', phone: '9876543212', role: 'admin' },
];

const insertUser = db.prepare('INSERT INTO users (id, name, email, phone, password, role) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET password = excluded.password');
demoUsers.forEach((u) => insertUser.run(u.id, u.name, u.email, u.phone, password, u.role));

const providerId = demoUsers[1].id;

// Seed Services
const servicesData = [
  { name: 'Washing Machine Repair', cat: 1, price: 399, rating: 4.8, reviews: 2340, duration: '60-90 mins', warranty: '30 days', desc: 'Expert washing machine repair service. Our trained technicians diagnose and fix all brands and models.', includes: ['Diagnosis', 'Basic Repair', 'Spare Parts (extra)', 'Testing'], image: 'https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=400' },
  { name: 'AC Service & Deep Clean', cat: 6, price: 549, rating: 4.9, reviews: 5600, duration: '45-60 mins', warranty: '30 days', desc: 'Comprehensive AC servicing including deep cleaning, gas check, and performance optimization.', includes: ['Filter Cleaning', 'Coil Cleaning', 'Gas Check', 'Performance Test'], image: 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=400' },
  { name: 'Full Home Deep Cleaning', cat: 3, price: 1999, rating: 4.7, reviews: 8900, duration: '4-6 hours', warranty: '3 days', desc: 'Professional deep cleaning for your entire home.', includes: ['Room Cleaning', 'Kitchen Deep Clean', 'Bathroom Scrub', 'Balcony Clean'], image: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=400' },
  { name: 'Electrician - General', cat: 2, price: 199, rating: 4.6, reviews: 12400, duration: '30-60 mins', warranty: '15 days', desc: 'General electrical work including switch repair, fan installation, wiring fixes.', includes: ['Switch Repair', 'Fan Service', 'MCB Check', 'Wiring Fix'], image: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=400' },
  { name: 'RO Water Purifier Service', cat: 4, price: 349, rating: 4.5, reviews: 3200, duration: '30-45 mins', warranty: '30 days', desc: 'Complete RO water purifier service and filter replacement.', includes: ['Filter Check', 'RO Membrane Check', 'Sanitization', 'TDS Test'], image: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400' },
  { name: 'Plumber - Tap & Leak Fix', cat: 2, price: 249, rating: 4.7, reviews: 6700, duration: '30-60 mins', warranty: '15 days', desc: 'Fix leaking taps, pipes, and fittings.', includes: ['Leak Detection', 'Tap Repair', 'Pipe Fitting', 'Sealing'], image: 'https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?w=400' },
  { name: 'Bathroom Renovation', cat: 5, price: 15999, rating: 4.8, reviews: 890, duration: '5-7 days', warranty: '1 year', desc: 'Complete bathroom renovation with modern fittings.', includes: ['Design Consultation', 'Tile Work', 'Plumbing', 'Waterproofing'], image: 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=400' },
  { name: 'Pest Control - Full Home', cat: 8, price: 1299, rating: 4.6, reviews: 4500, duration: '2-3 hours', warranty: '90 days', desc: 'Comprehensive pest control for cockroaches, ants, termites.', includes: ['Cockroach Control', 'Ant Treatment', 'Spray Treatment', 'Follow-up'], image: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400' },
  { name: 'Wall Painting - Per Room', cat: 7, price: 3499, rating: 4.7, reviews: 2100, duration: '1-2 days', warranty: '1 year', desc: 'Professional wall painting with premium paints.', includes: ['Wall Prep', 'Putty', 'Primer Coat', '2x Paint Coats'], image: 'https://images.unsplash.com/photo-1562259929-b4e1fd3aef09?w=400' },
  { name: 'Refrigerator Repair', cat: 1, price: 449, rating: 4.5, reviews: 1800, duration: '60-90 mins', warranty: '30 days', desc: 'Fridge not cooling? Our technicians fix all brands.', includes: ['Diagnosis', 'Gas Check', 'Thermostat Fix', 'Compressor Check'], image: 'https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?w=400' },
  { name: 'Carpenter - Furniture Repair', cat: 2, price: 299, rating: 4.6, reviews: 3400, duration: '60-120 mins', warranty: '15 days', desc: 'Expert carpenter for furniture repair and custom work.', includes: ['Door Repair', 'Hinge Fix', 'Shelf Install', 'Polish Touch-up'], image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=400' },
  { name: 'Kitchen Deep Cleaning', cat: 3, price: 899, rating: 4.8, reviews: 5200, duration: '2-3 hours', warranty: '3 days', desc: 'Thorough kitchen deep cleaning — chimney, gas stove, countertops.', includes: ['Chimney Clean', 'Gas Stove Clean', 'Cabinet Wipe', 'Sink Scrub'], image: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400' },
];

const insertService = db.prepare(`
  INSERT OR IGNORE INTO services (name, category_id, provider_id, price, rating, reviews, duration, warranty, description, includes, image)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

servicesData.forEach((s) => {
  insertService.run(s.name, s.cat, providerId, s.price, s.rating, s.reviews, s.duration, s.warranty, s.desc, JSON.stringify(s.includes), s.image);
});

// Seed Plans
const plansData = [
  {
    name: 'Basic Starter',
    price: 500,
    description: 'Perfect for beginners',
    target: 'both',
    features: ['Marketplace Access', 'Referral ID', 'Joining Gift', 'Dashboard Hub'],
    recommended: 0,
    cta: 'Choose Plan',
    sort_order: 1,
  },
  {
    name: 'Moderator Pro',
    price: 10000,
    description: 'Recommended for Learners',
    target: 'both',
    features: ['Priority Sync', 'Higher Share Rate (2x)', 'Training Suite', 'Team Manager Tools'],
    recommended: 1,
    cta: 'Choose Plan',
    sort_order: 2,
  },
  {
    name: 'Growth Engine',
    price: 25000,
    description: 'For growing businesses',
    target: 'provider',
    features: ['Elite Share Tier', 'Custom Hub View', 'Priority Support', 'Advanced Analytics'],
    recommended: 0,
    cta: 'Choose Plan',
    sort_order: 3,
  },
  {
    name: 'Market Node',
    price: 50000,
    description: 'Enterprise-level access',
    target: 'provider',
    features: ['Global Governance', 'Market Pool', 'White-label Dashboard', 'Dedicated Manager'],
    recommended: 0,
    cta: 'Choose Plan',
    sort_order: 4,
  },
];

const insertPlan = db.prepare(`
  INSERT OR IGNORE INTO plans (name, price, description, target, features, recommended, cta, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

plansData.forEach((p) => {
  insertPlan.run(p.name, p.price, p.description, p.target, JSON.stringify(p.features), p.recommended, p.cta, p.sort_order);
});

// Seed Offers
const offersData = [
  {
    title: '20% Off First Service',
    description: 'New customer special! Get 20% discount on your first service booking.',
    discount_percent: 20,
    code: 'WELCOME20',
    target: 'customer',
    badge: 'NEW USER',
    image: 'https://images.unsplash.com/photo-1607082349566-187342175e2f?w=800',
    sort_order: 1,
  },
  {
    title: 'Flat ₹500 Off AC Service',
    description: 'Summer special! Book any AC service and get ₹500 off instantly.',
    discount_flat: 500,
    code: 'COOL500',
    target: 'customer',
    badge: 'SUMMER DEAL',
    image: 'https://images.unsplash.com/photo-1631545806609-4a0fa1e4d176?w=800',
    sort_order: 2,
  },
  {
    title: '0% Commission First Month',
    description: 'Join as provider and enjoy zero commission for your first month of services.',
    discount_percent: 100,
    code: 'PROVIDER0',
    target: 'provider',
    badge: 'PROVIDERS',
    image: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800',
    sort_order: 3,
  },
  {
    title: 'Refer & Earn ₹200',
    description: 'Refer a friend and both of you get ₹200 credit on next booking!',
    discount_flat: 200,
    code: 'REFER200',
    target: 'both',
    badge: 'REFER & EARN',
    image: 'https://images.unsplash.com/photo-1521791136064-7986c2920216?w=800',
    sort_order: 4,
  },
  {
    title: 'Premium Plan – 30% Off',
    description: 'Upgrade to Moderator Pro plan and save 30% this month only.',
    discount_percent: 30,
    code: 'PREMIUM30',
    target: 'both',
    badge: 'LIMITED TIME',
    image: 'https://images.unsplash.com/photo-1553729459-afe8f2e2389d?w=800',
    sort_order: 5,
  },
];

const insertOffer = db.prepare(`
  INSERT OR IGNORE INTO offers (provider_id, title, description, discount_percent, discount_flat, code, target, image, badge, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

offersData.forEach((o) => {
  insertOffer.run(o.provider_id || null, o.title, o.description, o.discount_percent || 0, o.discount_flat || 0, o.code, o.target, o.image || '', o.badge || '', o.sort_order);
});

console.log('✅ Database seeded successfully!');
console.log('📧 Demo accounts:');
console.log('   Customer: customer@demo.com / password123');
console.log('   Provider: provider@demo.com / password123');
console.log('   Admin:    admin@demo.com / password123');

