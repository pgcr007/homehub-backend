require('dotenv').config();
const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const { connectMQTT } = require('./services/mqttService');

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  connectMQTT();

  const server = http.createServer(app);
  // Socket.IO real-time layer arrives in Phase 3 — server is already
  // created via http.createServer so it can be attached without rewiring.

  server.listen(PORT, () => {
    console.log(`[server] homehub-backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});