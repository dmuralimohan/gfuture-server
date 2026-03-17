import db from '../db.js';
import { randomUUID } from 'crypto';
import {
    getNearbyOnlineRiders,
    broadcastRideRequest,
    notifyRideTaken,
    sendToUser,
} from '../ws.js';

// Fare calculation constants
const BASE_FARE = { bike: 25, auto: 40, car: 80 };
const PER_KM = { bike: 8, auto: 12, car: 16 };
const MIN_FARE = { bike: 30, auto: 50, car: 100 };

function calculateFare(vehicleType, distanceKm) {
    const type = vehicleType || 'bike';
    const fare = BASE_FARE[type] + PER_KM[type] * distanceKm;
    return Math.max(fare, MIN_FARE[type]);
}

function generateOtp() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

export default async function rideRoutes(app) {

    // ─── Rider Registration ──────────────────────────────────────
    app.post('/rider/register', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const { vehicleType = 'bike', vehicleNumber, vehicleModel } = request.body;

        if (!vehicleNumber || !vehicleModel) {
            return reply.status(400).send({ message: 'Vehicle number and model are required' });
        }

        const existing = db.prepare('SELECT * FROM riders WHERE user_id = ?').get(userId);
        if (existing) {
            return reply.status(409).send({ message: 'Already registered as rider' });
        }

        db.prepare(`
          INSERT INTO riders (user_id, vehicle_type, vehicle_number, vehicle_model, verified)
          VALUES (?, ?, ?, ?, 1)
        `).run(userId, vehicleType, vehicleNumber, vehicleModel);

        return reply.status(201).send({ message: 'Rider registered', vehicleType, vehicleNumber, vehicleModel });
    });

    // ─── Rider Profile ───────────────────────────────────────────
    app.get('/rider/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const rider = db.prepare(`
          SELECT r.*, u.name, u.email, u.phone, u.profile_picture
          FROM riders r JOIN users u ON r.user_id = u.id
          WHERE r.user_id = ?
        `).get(userId);

        if (!rider) {
            return reply.status(404).send({ message: 'Not registered as rider', registered: false });
        }

        return {
            registered: true,
            rider: {
                userId: rider.user_id,
                name: rider.name,
                email: rider.email,
                phone: rider.phone,
                profilePicture: rider.profile_picture,
                vehicleType: rider.vehicle_type,
                vehicleNumber: rider.vehicle_number,
                vehicleModel: rider.vehicle_model,
                isOnline: !!rider.is_online,
                rating: rider.rating,
                totalRides: rider.total_rides,
                verified: !!rider.verified,
            },
        };
    });

    // ─── Toggle Online/Offline (REST fallback) ───────────────────
    app.post('/rider/toggle-online', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const { online, lat, lng } = request.body;

        const rider = db.prepare('SELECT * FROM riders WHERE user_id = ? AND verified = 1').get(userId);
        if (!rider) return reply.status(404).send({ message: 'Rider not found' });

        db.prepare(`
          UPDATE riders SET is_online = ?, current_lat = COALESCE(?, current_lat),
          current_lng = COALESCE(?, current_lng), updated_at = datetime('now')
          WHERE user_id = ?
        `).run(online ? 1 : 0, lat || null, lng || null, userId);

        return { message: online ? 'Online' : 'Offline', online: !!online };
    });

    // ─── Rider: Get Pending Ride Requests ────────────────────────
    app.get('/rider/requests', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const rider = db.prepare('SELECT * FROM riders WHERE user_id = ? AND verified = 1').get(userId);
        if (!rider) return reply.status(404).send({ message: 'Rider not found' });

        // Show rides that are searching and match vehicle type, within ~10km
        const degPerKm = 0.009;
        const delta = degPerKm * 10;
        const lat = rider.current_lat || 17.385;
        const lng = rider.current_lng || 78.486;

        const rides = db.prepare(`
          SELECT r.*, u.name as customer_name, u.phone as customer_phone, u.profile_picture as customer_picture
          FROM rides r JOIN users u ON r.customer_id = u.id
          WHERE r.status = 'searching' AND r.vehicle_type = ?
            AND r.pickup_lat BETWEEN ? AND ?
            AND r.pickup_lng BETWEEN ? AND ?
          ORDER BY r.created_at DESC LIMIT 10
        `).all(rider.vehicle_type, lat - delta, lat + delta, lng - delta, lng + delta);

        return {
            requests: rides.map(r => ({
                id: r.id,
                customerName: r.customer_name,
                customerPhone: r.customer_phone,
                customerPicture: r.customer_picture,
                pickupAddress: r.pickup_address,
                pickupLat: r.pickup_lat,
                pickupLng: r.pickup_lng,
                dropAddress: r.drop_address,
                dropLat: r.drop_lat,
                dropLng: r.drop_lng,
                distanceKm: r.distance_km,
                estimatedFare: r.estimated_fare,
                vehicleType: r.vehicle_type,
                createdAt: r.created_at,
            })),
        };
    });

    // ─── Accept Ride (Rider) ─────────────────────────────────────
    app.post('/:rideId/accept', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;
        const userId = request.user.id;

        const rider = db.prepare('SELECT * FROM riders WHERE user_id = ? AND verified = 1').get(userId);
        if (!rider) return reply.status(403).send({ message: 'Not a verified rider' });

        const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
        if (!ride) return reply.status(404).send({ message: 'Ride not found' });
        if (ride.status !== 'searching') {
            return reply.status(409).send({ message: 'Ride already taken' });
        }

        // Assign rider
        db.prepare(`
          UPDATE rides SET rider_id = ?, status = 'accepted', updated_at = datetime('now')
          WHERE id = ? AND status = 'searching'
        `).run(userId, rideId);

        // Verify it was actually updated (race condition check)
        const updated = db.prepare('SELECT * FROM rides WHERE id = ? AND rider_id = ?').get(rideId, userId);
        if (!updated) {
            return reply.status(409).send({ message: 'Ride was taken by another rider' });
        }

        // Get rider details for customer notification
        const riderUser = db.prepare('SELECT name, phone, profile_picture FROM users WHERE id = ?').get(userId);

        const riderInfo = {
            id: userId,
            name: riderUser.name,
            phone: riderUser.phone,
            profilePicture: riderUser.profile_picture,
            vehicleNumber: rider.vehicle_number,
            vehicleModel: rider.vehicle_model,
            rating: rider.rating,
            totalRides: rider.total_rides,
        };

        // Notify customer via WebSocket
        sendToUser(ride.customer_id, 'RIDE_ACCEPTED', {
            rideId,
            rider: riderInfo,
            otp: ride.otp,
        });

        // Notify other riders that this ride is taken
        const nearbyRiders = getNearbyOnlineRiders(
            ride.pickup_lat, ride.pickup_lng, 10, ride.vehicle_type
        );
        notifyRideTaken(nearbyRiders.map(r => r.userId), rideId, userId);

        return {
            message: 'Ride accepted',
            ride: {
                id: ride.id,
                customerName: null, // fetched separately
                pickupAddress: ride.pickup_address,
                pickupLat: ride.pickup_lat,
                pickupLng: ride.pickup_lng,
                dropAddress: ride.drop_address,
                dropLat: ride.drop_lat,
                dropLng: ride.drop_lng,
                distanceKm: ride.distance_km,
                estimatedFare: ride.estimated_fare,
                otp: ride.otp,
            },
        };
    });

    // ─── Rider's Active Ride ─────────────────────────────────────
    app.get('/rider/active', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const ride = db.prepare(`
          SELECT r.*, u.name as customer_name, u.phone as customer_phone, u.profile_picture as customer_picture
          FROM rides r JOIN users u ON r.customer_id = u.id
          WHERE r.rider_id = ? AND r.status IN ('accepted', 'arriving', 'in_progress')
          ORDER BY r.updated_at DESC LIMIT 1
        `).get(userId);

        if (!ride) return { ride: null };

        return {
            ride: {
                id: ride.id,
                status: ride.status,
                customerName: ride.customer_name,
                customerPhone: ride.customer_phone,
                customerPicture: ride.customer_picture,
                pickupAddress: ride.pickup_address,
                pickupLat: ride.pickup_lat,
                pickupLng: ride.pickup_lng,
                dropAddress: ride.drop_address,
                dropLat: ride.drop_lat,
                dropLng: ride.drop_lng,
                distanceKm: ride.distance_km,
                estimatedFare: ride.estimated_fare,
                otp: ride.otp,
                vehicleType: ride.vehicle_type,
            },
        };
    });

    // ─── Rider Ride History ──────────────────────────────────────
    app.get('/rider/history', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const { page = 1, limit = 20 } = request.query;
        const offset = (page - 1) * limit;

        const total = db.prepare('SELECT COUNT(*) as count FROM rides WHERE rider_id = ?').get(userId).count;
        const rides = db.prepare(`
          SELECT r.*, u.name as customer_name
          FROM rides r JOIN users u ON r.customer_id = u.id
          WHERE r.rider_id = ?
          ORDER BY r.created_at DESC LIMIT ? OFFSET ?
        `).all(userId, Number(limit), offset);

        return {
            rides: rides.map(r => ({
                id: r.id,
                status: r.status,
                customerName: r.customer_name,
                pickupAddress: r.pickup_address,
                dropAddress: r.drop_address,
                distanceKm: r.distance_km,
                estimatedFare: r.estimated_fare,
                finalFare: r.final_fare,
                rating: r.rating,
                createdAt: r.created_at,
                completedAt: r.completed_at,
            })),
            page: Number(page),
            totalPages: Math.ceil(total / limit),
            total,
        };
    });
    // Estimate fare before booking
    app.post('/estimate', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { vehicleType, distanceKm } = request.body;
        if (!distanceKm || distanceKm <= 0) {
            return reply.status(400).send({ message: 'Invalid distance' });
        }
        const estimates = {};
        for (const type of ['bike', 'auto', 'car']) {
            estimates[type] = Math.round(calculateFare(type, distanceKm));
        }
        return {
            estimates,
            selected: vehicleType || 'bike',
            selectedFare: estimates[vehicleType || 'bike'],
            distanceKm,
        };
    });

    // Book a ride
    app.post('/book', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const {
            vehicleType = 'bike',
            pickupAddress,
            pickupLat,
            pickupLng,
            dropAddress,
            dropLat,
            dropLng,
            distanceKm,
        } = request.body;

        if (!pickupAddress || !dropAddress) {
            return reply.status(400).send({ message: 'Pickup and drop addresses are required' });
        }
        if (!distanceKm || distanceKm <= 0) {
            return reply.status(400).send({ message: 'Invalid distance' });
        }

        // Check for existing active ride
        const activeRide = db.prepare(
            `SELECT id FROM rides WHERE customer_id = ? AND status IN ('searching', 'accepted', 'arriving', 'in_progress')`
        ).get(userId);
        if (activeRide) {
            return reply.status(409).send({ message: 'You already have an active ride', rideId: activeRide.id });
        }

        const rideId = `RIDE-${randomUUID().slice(0, 8).toUpperCase()}`;
        const estimatedFare = Math.round(calculateFare(vehicleType, distanceKm));
        const otp = generateOtp();

        db.prepare(`
      INSERT INTO rides (id, customer_id, status, vehicle_type, pickup_address, pickup_lat, pickup_lng,
        drop_address, drop_lat, drop_lng, distance_km, estimated_fare, otp)
      VALUES (?, ?, 'searching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rideId, userId, vehicleType, pickupAddress, pickupLat, pickupLng,
            dropAddress, dropLat, dropLng, distanceKm, estimatedFare, otp);

        // Broadcast to nearby online riders via WebSocket
        const nearbyWsRiders = getNearbyOnlineRiders(pickupLat, pickupLng, 10, vehicleType);
        const rideRequest = {
            id: rideId,
            pickupAddress, pickupLat, pickupLng,
            dropAddress, dropLat, dropLng,
            distanceKm, estimatedFare, vehicleType,
        };
        const sentCount = broadcastRideRequest(nearbyWsRiders.map(r => r.userId), rideRequest);

        // Also check DB for online riders not connected via WS (REST fallback)
        const onlineRider = db.prepare(
            `SELECT r.*, u.name as rider_name, u.phone as rider_phone, u.profile_picture
       FROM riders r JOIN users u ON r.user_id = u.id
       WHERE r.is_online = 1 AND r.vehicle_type = ? AND r.verified = 1
       LIMIT 1`
        ).get(vehicleType);

        return reply.status(201).send({
            ride: {
                id: rideId,
                status: 'searching',
                vehicleType,
                pickupAddress,
                dropAddress,
                distanceKm,
                estimatedFare,
                otp,
                rider: null,
                notifiedRiders: sentCount,
                hasNearbyRiders: sentCount > 0 || !!onlineRider,
            },
        });
    });

    // Get ride status
    app.get('/:rideId', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;
        const userId = request.user.id;

        const ride = db.prepare(`
      SELECT r.*, u.name as rider_name, u.phone as rider_phone, u.profile_picture as rider_picture
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      WHERE r.id = ?
    `).get(rideId);

        if (!ride) {
            return reply.status(404).send({ message: 'Ride not found' });
        }
        if (ride.customer_id !== userId && ride.rider_id !== userId) {
            return reply.status(403).send({ message: 'Not authorized' });
        }

        let riderDetails = null;
        if (ride.rider_id) {
            const rider = db.prepare(`SELECT * FROM riders WHERE user_id = ?`).get(ride.rider_id);
            riderDetails = {
                id: ride.rider_id,
                name: ride.rider_name,
                phone: ride.rider_phone,
                profilePicture: ride.rider_picture,
                vehicleNumber: rider?.vehicle_number,
                vehicleModel: rider?.vehicle_model,
                rating: rider?.rating,
                totalRides: rider?.total_rides,
                currentLat: rider?.current_lat,
                currentLng: rider?.current_lng,
            };
        }

        return {
            ride: {
                id: ride.id,
                status: ride.status,
                vehicleType: ride.vehicle_type,
                pickupAddress: ride.pickup_address,
                pickupLat: ride.pickup_lat,
                pickupLng: ride.pickup_lng,
                dropAddress: ride.drop_address,
                dropLat: ride.drop_lat,
                dropLng: ride.drop_lng,
                distanceKm: ride.distance_km,
                estimatedFare: ride.estimated_fare,
                finalFare: ride.final_fare,
                otp: ride.otp,
                rating: ride.rating,
                rider: riderDetails,
                startedAt: ride.started_at,
                completedAt: ride.completed_at,
                cancelledAt: ride.cancelled_at,
                createdAt: ride.created_at,
            },
        };
    });

    // Get user's ride history
    app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.id;
        const { page = 1, limit = 20, status } = request.query;
        const offset = (page - 1) * limit;

        let where = 'WHERE r.customer_id = ?';
        const params = [userId];
        if (status) {
            where += ' AND r.status = ?';
            params.push(status);
        }

        const total = db.prepare(`SELECT COUNT(*) as count FROM rides r ${where}`).get(...params).count;
        params.push(Number(limit), offset);

        const rides = db.prepare(`
      SELECT r.*, u.name as rider_name, u.profile_picture as rider_picture
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);

        return {
            rides: rides.map(r => ({
                id: r.id,
                status: r.status,
                vehicleType: r.vehicle_type,
                pickupAddress: r.pickup_address,
                dropAddress: r.drop_address,
                distanceKm: r.distance_km,
                estimatedFare: r.estimated_fare,
                finalFare: r.final_fare,
                rating: r.rating,
                riderName: r.rider_name,
                riderPicture: r.rider_picture,
                createdAt: r.created_at,
                completedAt: r.completed_at,
            })),
            page: Number(page),
            totalPages: Math.ceil(total / limit),
            total,
        };
    });

    // Cancel ride
    app.post('/:rideId/cancel', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;
        const userId = request.user.id;
        const { reason } = request.body || {};

        const ride = db.prepare(`SELECT * FROM rides WHERE id = ?`).get(rideId);
        if (!ride) return reply.status(404).send({ message: 'Ride not found' });
        if (ride.customer_id !== userId && ride.rider_id !== userId) {
            return reply.status(403).send({ message: 'Not authorized' });
        }
        if (['completed', 'cancelled'].includes(ride.status)) {
            return reply.status(400).send({ message: 'Ride cannot be cancelled' });
        }

        db.prepare(`
      UPDATE rides SET status = 'cancelled', cancelled_at = datetime('now'),
        cancel_reason = ?, cancelled_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason || null, userId, rideId);

        // Notify the other party via WebSocket
        if (ride.customer_id !== userId && ride.customer_id) {
            sendToUser(ride.customer_id, 'RIDE_CANCELLED', { rideId, cancelledBy: 'rider', reason });
        }
        if (ride.rider_id && ride.rider_id !== userId) {
            sendToUser(ride.rider_id, 'RIDE_CANCELLED', { rideId, cancelledBy: 'customer', reason });
        }

        return { message: 'Ride cancelled', rideId };
    });

    // Verify OTP and start ride (rider endpoint)
    app.post('/:rideId/start', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;
        const { otp } = request.body;

        const ride = db.prepare(`SELECT * FROM rides WHERE id = ?`).get(rideId);
        if (!ride) return reply.status(404).send({ message: 'Ride not found' });
        if (ride.status !== 'accepted' && ride.status !== 'arriving') {
            return reply.status(400).send({ message: 'Ride not in valid state to start' });
        }
        if (ride.otp !== otp) {
            return reply.status(400).send({ message: 'Invalid OTP' });
        }

        db.prepare(`
      UPDATE rides SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(rideId);

        // Notify customer ride started
        sendToUser(ride.customer_id, 'RIDE_STARTED', { rideId });

        return { message: 'Ride started', rideId };
    });

    // Complete ride (rider endpoint)
    app.post('/:rideId/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;

        const ride = db.prepare(`SELECT * FROM rides WHERE id = ?`).get(rideId);
        if (!ride) return reply.status(404).send({ message: 'Ride not found' });
        if (ride.status !== 'in_progress') {
            return reply.status(400).send({ message: 'Ride not in progress' });
        }

        const finalFare = ride.estimated_fare; // In production, recalculate based on actual distance

        db.prepare(`
      UPDATE rides SET status = 'completed', final_fare = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(finalFare, rideId);

        // Update rider stats
        if (ride.rider_id) {
            db.prepare(`UPDATE riders SET total_rides = total_rides + 1, updated_at = datetime('now') WHERE user_id = ?`)
                .run(ride.rider_id);
        }

        // Notify customer ride completed
        sendToUser(ride.customer_id, 'RIDE_COMPLETED', { rideId, finalFare });

        return { message: 'Ride completed', rideId, finalFare };
    });

    // Rate ride
    app.post('/:rideId/rate', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { rideId } = request.params;
        const userId = request.user.id;
        const { rating, comment } = request.body;

        if (!rating || rating < 1 || rating > 5) {
            return reply.status(400).send({ message: 'Rating must be between 1 and 5' });
        }

        const ride = db.prepare(`SELECT * FROM rides WHERE id = ? AND customer_id = ?`).get(rideId, userId);
        if (!ride) return reply.status(404).send({ message: 'Ride not found' });
        if (ride.status !== 'completed') {
            return reply.status(400).send({ message: 'Can only rate completed rides' });
        }
        if (ride.rating) {
            return reply.status(400).send({ message: 'Ride already rated' });
        }

        db.prepare(`UPDATE rides SET rating = ?, rating_comment = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(rating, comment || null, rideId);

        // Update rider average rating
        if (ride.rider_id) {
            const avg = db.prepare(
                `SELECT AVG(rating) as avg_rating FROM rides WHERE rider_id = ? AND rating IS NOT NULL`
            ).get(ride.rider_id);
            if (avg?.avg_rating) {
                db.prepare(`UPDATE riders SET rating = ?, updated_at = datetime('now') WHERE user_id = ?`)
                    .run(Math.round(avg.avg_rating * 10) / 10, ride.rider_id);
            }
        }

        return { message: 'Rating submitted', rideId };
    });

    // Get nearby riders (for map display)
    app.get('/nearby', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { lat, lng, vehicleType, radius = 5 } = request.query;
        if (!lat || !lng) {
            return reply.status(400).send({ message: 'Location required' });
        }

        // Simple bounding-box query (not haversine, good enough for demo)
        const degPerKm = 0.009; // Approximate
        const delta = degPerKm * Number(radius);

        let query = `
      SELECT r.user_id, r.vehicle_type, r.vehicle_model, r.vehicle_number,
             r.current_lat, r.current_lng, r.rating, u.name, u.profile_picture
      FROM riders r JOIN users u ON r.user_id = u.id
      WHERE r.is_online = 1 AND r.verified = 1
        AND r.current_lat BETWEEN ? AND ?
        AND r.current_lng BETWEEN ? AND ?
    `;
        const params = [Number(lat) - delta, Number(lat) + delta, Number(lng) - delta, Number(lng) + delta];

        if (vehicleType) {
            query += ' AND r.vehicle_type = ?';
            params.push(vehicleType);
        }
        query += ' LIMIT 20';

        const riders = db.prepare(query).all(...params);

        return {
            riders: riders.map(r => ({
                id: r.user_id,
                name: r.name,
                profilePicture: r.profile_picture,
                vehicleType: r.vehicle_type,
                vehicleModel: r.vehicle_model,
                vehicleNumber: r.vehicle_number,
                lat: r.current_lat,
                lng: r.current_lng,
                rating: r.rating,
            })),
        };
    });
}
