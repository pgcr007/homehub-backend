const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const requireAuth = require('./middleware/requireAuth');
const User = require('./models/User');
const { publishTest } = require('./services/mqttService');
const { sendToTokens, getStaleTokens } = require('./services/fcmService');

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy that sets
// X-Forwarded-For. Trust the first hop so express-rate-limit can resolve
// real client IPs instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

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

// Phase 1 sanity check: hit this to confirm FCM push works end to end
app.post('/health/fcm-test', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const result = await sendToTokens(
      user.fcmTokens,
      { title: 'HomeHub test', body: 'FCM is wired up correctly 🎉' }
    );

    const staleTokens = getStaleTokens(user.fcmTokens, result);
    if (staleTokens.length) {
      await User.findByIdAndUpdate(user._id, { $pullAll: { fcmTokens: staleTokens } });
    }

    res.json({ status: 'sent', result, prunedStaleTokens: staleTokens.length });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/user', userRoutes);

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