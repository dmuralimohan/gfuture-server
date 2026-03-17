import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { hashSync } from 'bcryptjs';

const db = new Database('/Users/murali-15351/project/client2/server/gfuture.db');

const password = hashSync('password123', 10);

const riderData = [
    { name: 'Raju Kumar', email: 'rider.bike@demo.com', phone: '9876543210', vehicleType: 'bike', vehicleNumber: 'TS09AB1234', vehicleModel: 'Honda Activa', lat: 17.385, lng: 78.486, rating: 4.8, rides: 120 },
    { name: 'Suresh Reddy', email: 'rider.auto@demo.com', phone: '9876543211', vehicleType: 'auto', vehicleNumber: 'TS09CX5678', vehicleModel: 'Bajaj Auto', lat: 17.39, lng: 78.49, rating: 4.6, rides: 85 },
    { name: 'Venkat Rao', email: 'rider.car@demo.com', phone: '9876543212', vehicleType: 'car', vehicleNumber: 'TS09DZ9012', vehicleModel: 'Maruti Swift Dzire', lat: 17.38, lng: 78.48, rating: 4.9, rides: 200 },
];

for (const r of riderData) {
    let existing = db.prepare('SELECT id FROM users WHERE email = ?').get(r.email);
    let userId;
    if (existing) {
        userId = existing.id;
    } else {
        userId = randomUUID();
        db.prepare('INSERT INTO users (id, name, email, phone, password, role) VALUES (?, ?, ?, ?, ?, ?)').run(userId, r.name, r.email, r.phone, password, 'provider');
        console.log('Created user:', r.name);
    }
    const existingRider = db.prepare('SELECT id FROM riders WHERE user_id = ?').get(userId);
    if (!existingRider) {
        db.prepare('INSERT INTO riders (user_id, vehicle_type, vehicle_number, vehicle_model, is_online, current_lat, current_lng, rating, total_rides, verified) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1)').run(userId, r.vehicleType, r.vehicleNumber, r.vehicleModel, r.lat, r.lng, r.rating, r.rides);
        console.log('Created rider:', r.vehicleType);
    } else {
        db.prepare('UPDATE riders SET vehicle_type=?, vehicle_number=?, vehicle_model=?, is_online=1, verified=1 WHERE user_id=?').run(r.vehicleType, r.vehicleNumber, r.vehicleModel, userId);
        console.log('Updated rider:', r.vehicleType);
    }
}

// Cancel stuck rides
db.prepare("UPDATE rides SET status = 'cancelled' WHERE status NOT IN ('completed','cancelled')").run();

// Verify
const allRiders = db.prepare('SELECT r.user_id, u.name, r.vehicle_type, r.vehicle_number, r.is_online, r.verified FROM riders r JOIN users u ON r.user_id = u.id').all();
console.log('\nAll riders:');
allRiders.forEach(r => console.log(`  ${r.name} | ${r.vehicle_type} | ${r.vehicle_number} | online:${r.is_online} | verified:${r.verified}`));
