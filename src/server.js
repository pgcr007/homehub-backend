require('dotenv').config();
const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const { connectMQTT } = require('./services/mqttService');
const { initFirebase } = require('./services/fcmService');
const { initSocket } = require('./services/socketService');
const { startStaleStateChecker } = require('./services/staleStateChecker');

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  connectMQTT();
  initFirebase();

  const server = http.createServer(app);

  // Phase 3: Socket.IO attaches to the already-created HTTP server, no rewiring needed.
  initSocket(server);

  // Phase 3: periodic sweep that demotes silently-stale 'online' devices to 'unknown'
  // (distinct from an explicit LWT 'offline') — see staleStateChecker.js for why.
  startStaleStateChecker();

  server.listen(PORT, () => {
    console.log(`[server] homehub-backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});