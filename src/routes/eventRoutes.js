const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const { listEvents } = require('../controllers/eventController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);
router.get('/', listEvents);

module.exports = router;