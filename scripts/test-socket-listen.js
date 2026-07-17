require('dotenv').config();
const { io } = require('socket.io-client');

/**
 * Phase 3/4 handoff check: confirms a real Socket.IO client actually receives
 * `device:event` end-to-end — i.e. the one hop `socketService.test.js` doesn't
 * cover, because that suite calls emitDeviceEvent() directly rather than going
 * through the real MQTT -> mqttSubscriber -> publishNormalizedEvent ->
 * `.../normalized` -> socketService chain.
 *
 * Usage:
 *   node scripts/test-socket-listen.js <backendUrl> <jwt>
 *
 * Get a JWT via:
 *   curl -X POST <backendUrl>/api/auth/login \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"you@example.com","password":"yourpassword"}'
 *
 * Then, while this script is running, in another terminal:
 *   node scripts/test-mqtt-publish.js <ownerId> <identifier> state "{\"POWER\":\"ON\"}"
 *
 * (ownerId must match the userId embedded in the JWT you passed in, since
 * socketService scopes delivery to the `owner:{userId}` room.)
 *
 * Success looks like: this script prints "[device:event] { ... }" within a
 * second or two of the publish script logging "Published successfully."
 */

const BACKEND_URL = process.argv[2];
const TOKEN = process.argv[3];

if (!BACKEND_URL || !TOKEN) {
  console.error('Usage: node scripts/test-socket-listen.js <backendUrl> <jwt>');
  process.exit(1);
}

console.log(`Connecting to ${BACKEND_URL} ...`);

const socket = io(BACKEND_URL, {
  auth: { token: TOKEN },
  // Let engine.io negotiate (polling first, upgrade to websocket) instead of
  // forcing websocket-only — more forgiving of PaaS proxies (e.g. Render)
  // and cold-starting free-tier instances.
  transports: ['polling', 'websocket'],
  timeout: 20000,
});

socket.on('connect', () => {
  console.log(`Connected (socket id: ${socket.id}, transport: ${socket.io.engine.transport.name}). Listening for device:event ...`);
  console.log('Now run test-mqtt-publish.js in another terminal to trigger one.');
});

socket.io.engine.on('upgrade', () => {
  console.log(`Transport upgraded to: ${socket.io.engine.transport.name}`);
});

socket.on('device:event', (event) => {
  console.log('[device:event]', JSON.stringify(event, null, 2));
});

socket.on('connect_error', (err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log(`Disconnected: ${reason}`);
});

process.on('SIGINT', () => {
  socket.close();
  process.exit(0);
});