const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const { getUsage } = require('../controllers/insightsController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);
router.get('/usage', getUsage);

module.exports = router;