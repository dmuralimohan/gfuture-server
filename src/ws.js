/**
 * WebSocket connection manager for G-Rider real-time features.
 * Tracks connected riders and customers for ride notifications.
 */

// Map<userId, { socket, role, lat?, lng?, vehicleType? }>
const connections = new Map();

export function addConnection(userId, socket, role, meta = {}) {
    connections.set(userId, { socket, role, ...meta });
}

export function removeConnection(userId) {
    connections.delete(userId);
}

export function getConnection(userId) {
    return connections.get(userId);
}

/** Send a typed JSON message to a specific user */
export function sendToUser(userId, type, payload) {
    const conn = connections.get(userId);
    if (conn && conn.socket.readyState === 1) { // OPEN
        conn.socket.send(JSON.stringify({ type, ...payload }));
        return true;
    }
    return false;
}

/** Get all online riders near a location, optionally filtered by vehicle type */
export function getNearbyOnlineRiders(lat, lng, radiusKm = 5, vehicleType = null) {
    const results = [];
    const degPerKm = 0.009;
    const delta = degPerKm * radiusKm;

    for (const [userId, conn] of connections) {
        if (conn.role !== 'rider') continue;
        if (vehicleType && conn.vehicleType !== vehicleType) continue;
        if (conn.lat == null || conn.lng == null) continue;
        if (Math.abs(conn.lat - lat) <= delta && Math.abs(conn.lng - lng) <= delta) {
            results.push({ userId, ...conn });
        }
    }
    return results;
}

/** Broadcast a ride request to multiple riders */
export function broadcastRideRequest(riderUserIds, rideData) {
    let sent = 0;
    for (const userId of riderUserIds) {
        if (sendToUser(userId, 'NEW_RIDE_REQUEST', { ride: rideData })) {
            sent++;
        }
    }
    return sent;
}

/** Notify all riders that a ride was taken */
export function notifyRideTaken(riderUserIds, rideId, acceptedBy) {
    for (const userId of riderUserIds) {
        if (userId !== acceptedBy) {
            sendToUser(userId, 'RIDE_TAKEN', { rideId, acceptedBy });
        }
    }
}

/** Update rider location in the connection map */
export function updateRiderLocation(userId, lat, lng) {
    const conn = connections.get(userId);
    if (conn) {
        conn.lat = lat;
        conn.lng = lng;
    }
}

export function getOnlineRiderCount() {
    let count = 0;
    for (const conn of connections.values()) {
        if (conn.role === 'rider') count++;
    }
    return count;
}
