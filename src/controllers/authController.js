const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

async function register(req, res) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'an account with that email already exists' });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ email, passwordHash, name });

    const token = signToken(user._id.toString());
    return res.status(201).json({ token, user });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    return res.status(500).json({ error: 'failed to register' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const token = signToken(user._id.toString());
    return res.json({ token, user });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(500).json({ error: 'failed to log in' });
  }
}

async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });
  return res.json({ user });
}

/**
 * PATCH /api/auth/password
 * body: { currentPassword, newPassword }
 * Profile screen's "Change password" action. Requires the current
 * password rather than trusting the JWT alone — a valid session token
 * proves "still logged in", not "this is really you re-confirming a
 * sensitive change", same reasoning most account-settings password
 * changes use.
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'user not found' });

    const ok = await user.comparePassword(currentPassword);
    if (!ok) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }

    user.passwordHash = await User.hashPassword(newPassword);
    await user.save();

    return res.json({ status: 'updated' });
  } catch (err) {
    console.error('[auth] change password error:', err.message);
    return res.status(500).json({ error: 'failed to change password' });
  }
}

module.exports = { register, login, me, changePassword };