const User = require('../models/User');

async function registerFcmToken(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  await User.findByIdAndUpdate(req.userId, {
    $addToSet: { fcmTokens: token },
  });

  res.json({ status: 'registered' });
}

module.exports = { registerFcmToken };