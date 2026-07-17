const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { listEvents } = require('../controllers/eventController');

const router = express.Router();

router.use(requireAuth);
router.get('/', listEvents);

module.exports = router;