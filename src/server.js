require('dotenv').config();
const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const { connectMQTT } = require('./services/mqttService');
const { initFirebase } = require('./services/fcmService');

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDB();
  connectMQTT();
  initFirebase();

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`[server] homehub-backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});