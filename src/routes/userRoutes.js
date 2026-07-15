const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { registerFcmToken } = require('../controllers/userController');

const router = express.Router();

router.post('/register-token', requireAuth, registerFcmToken);

module.exports = router;