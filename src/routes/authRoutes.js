const express = require('express');
const { register, login, me, changePassword } = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', requireAuth, me);
router.patch('/password', requireAuth, changePassword);

module.exports = router;