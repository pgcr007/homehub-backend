const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const { publishTest } = require('./services/mqttService');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);
app.use(express.json());
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Generous global limiter; auth routes get a tighter one below
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'too many attempts, try again later' },
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'homehub-backend' });
});

// Phase 1 sanity check: hit this to confirm MQTT publish/subscribe works end to end
app.post('/health/mqtt-test', (_req, res) => {
  try {
    publishTest();
    res.json({ status: 'published', topic: 'homehub/test/ping' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.use('/api/auth', authLimiter, authRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
});

// Central error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

module.exports = app;