#!/usr/bin/env node
const BASE = 'http://localhost:3001';

async function api(method, path, body, token) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json();
    return { status: res.status, data };
}

async function test() {
    console.log('=== 1. LOGIN (Customer) ===');
    const login = await api('POST', '/api/auth/login', { email: 'customer@demo.com', password: 'password123' });
    console.log('Status:', login.status, '| User:', login.data.user?.name);
    const CUST_TOKEN = login.data.accessToken;
    if (!CUST_TOKEN) { console.error('LOGIN FAILED'); process.exit(1); }

    console.log('\n=== 2. LOGIN (Rider: rider.bike@demo.com) ===');
    const riderLogin = await api('POST', '/api/auth/login', { email: 'rider.bike@demo.com', password: 'password123' });
    console.log('Status:', riderLogin.status, '| User:', riderLogin.data.user?.name);
    const RIDER_TOKEN = riderLogin.data.accessToken;
    if (!RIDER_TOKEN) { console.error('RIDER LOGIN FAILED'); process.exit(1); }

    console.log('\n=== 3. RIDER PROFILE ===');
    const profile = await api('GET', '/api/rides/rider/profile', null, RIDER_TOKEN);
    console.log('Status:', profile.status, '| Registered:', profile.data.registered, '| Vehicle:', profile.data.rider?.vehicleNumber);

    console.log('\n=== 4. RIDER GO ONLINE ===');
    const online = await api('POST', '/api/rides/rider/toggle-online', { online: true, lat: 17.385, lng: 78.486 }, RIDER_TOKEN);
    console.log('Status:', online.status, '| Online:', online.data.online);

    console.log('\n=== 5. ESTIMATE ===');
    const est = await api('POST', '/api/rides/estimate', { vehicleType: 'bike', distanceKm: 5 }, CUST_TOKEN);
    console.log('Status:', est.status, '| Estimates:', JSON.stringify(est.data.estimates));

    console.log('\n=== 6. BOOK RIDE (Customer) ===');
    const book = await api('POST', '/api/rides/book', {
        vehicleType: 'bike', pickupAddress: 'Hyderabad Central', pickupLat: 17.385, pickupLng: 78.486,
        dropAddress: 'Gachibowli', dropLat: 17.44, dropLng: 78.35, distanceKm: 5
    }, CUST_TOKEN);
    console.log('Status:', book.status, '| Ride:', book.data.ride?.id, '| RideStatus:', book.data.ride?.status,
        '| OTP:', book.data.ride?.otp, '| Fare:', book.data.ride?.estimatedFare,
        '| NotifiedRiders:', book.data.ride?.notifiedRiders, '| HasNearby:', book.data.ride?.hasNearbyRiders);
    const RIDE_ID = book.data.ride?.id;
    const OTP = book.data.ride?.otp;

    console.log('\n=== 7. RIDER SEES REQUESTS ===');
    const reqs = await api('GET', '/api/rides/rider/requests', null, RIDER_TOKEN);
    console.log('Status:', reqs.status, '| Requests:', reqs.data.requests?.length, '| IDs:', reqs.data.requests?.map(r => r.id).join(', '));

    console.log('\n=== 8. RIDER ACCEPTS RIDE ===');
    const accept = await api('POST', `/api/rides/${RIDE_ID}/accept`, {}, RIDER_TOKEN);
    console.log('Status:', accept.status, '| Message:', accept.data.message, '| Pickup:', accept.data.ride?.pickupAddress);

    console.log('\n=== 9. RIDE STATUS (Customer verifies accepted) ===');
    const status = await api('GET', `/api/rides/${RIDE_ID}`, null, CUST_TOKEN);
    console.log('Status:', status.status, '| RideStatus:', status.data.ride?.status, '| Rider:', status.data.ride?.rider?.name);

    console.log('\n=== 10. START RIDE (Rider OTP verify) ===');
    const start = await api('POST', `/api/rides/${RIDE_ID}/start`, { otp: OTP }, RIDER_TOKEN);
    console.log('Status:', start.status, '| Result:', JSON.stringify(start.data));

    console.log('\n=== 11. COMPLETE RIDE (Rider) ===');
    const complete = await api('POST', `/api/rides/${RIDE_ID}/complete`, {}, RIDER_TOKEN);
    console.log('Status:', complete.status, '| Result:', JSON.stringify(complete.data));

    console.log('\n=== 12. RATE RIDE (Customer) ===');
    const rate = await api('POST', `/api/rides/${RIDE_ID}/rate`, { rating: 5, comment: 'Great ride!' }, CUST_TOKEN);
    console.log('Status:', rate.status, '| Result:', JSON.stringify(rate.data));

    console.log('\n=== 13. CUSTOMER RIDE HISTORY ===');
    const history = await api('GET', '/api/rides', null, CUST_TOKEN);
    console.log('Status:', history.status, '| Total:', history.data.total);

    console.log('\n=== 14. RIDER RIDE HISTORY ===');
    const riderHist = await api('GET', '/api/rides/rider/history', null, RIDER_TOKEN);
    console.log('Status:', riderHist.status, '| Total:', riderHist.data.total);

    console.log('\n=== 15. RIDER ACTIVE RIDE (should be null after complete) ===');
    const active = await api('GET', '/api/rides/rider/active', null, RIDER_TOKEN);
    console.log('Status:', active.status, '| Active:', active.data.ride ? active.data.ride.id : 'none');

    console.log('\n=== 16. BOOK + CANCEL ===');
    const book2 = await api('POST', '/api/rides/book', {
        vehicleType: 'bike', pickupAddress: 'Ameerpet', pickupLat: 17.437, pickupLng: 78.448,
        dropAddress: 'HITEC City', dropLat: 17.445, dropLng: 78.38, distanceKm: 8
    }, CUST_TOKEN);
    console.log('Booked:', book2.data.ride?.id, '| Status:', book2.data.ride?.status);
    const cancel = await api('POST', `/api/rides/${book2.data.ride?.id}/cancel`, { reason: 'Test cancel' }, CUST_TOKEN);
    console.log('Cancel Status:', cancel.status, '| Result:', JSON.stringify(cancel.data));

    console.log('\n=== 17. RIDER GO OFFLINE ===');
    const offline = await api('POST', '/api/rides/rider/toggle-online', { online: false }, RIDER_TOKEN);
    console.log('Status:', offline.status, '| Online:', offline.data.online);

    console.log('\n=== ALL 17 TESTS COMPLETE ===');
}

test().catch(e => { console.error('Test error:', e.message); process.exit(1); });
