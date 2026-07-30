const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const {
  createDevice,
  listDevices,
  getDevice,
  getWebhookSecret,
  updateDevice,
  deleteDevice,
  sendCommand,
  bulkCommand,
} = require('../controllers/deviceController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);

router.post('/', createDevice);
router.get('/', listDevices);
// Registered ahead of the /:id routes below on principle (Express would
// actually route this correctly either way, since "bulk-command" as a
// single path segment never collides with the two-segment "/:id/command" —
// but keeping fixed-path routes ahead of parameterized ones avoids relying
// on that segment-count distinction if either route ever changes shape).
router.post('/bulk-command', bulkCommand);
router.get('/:id', getDevice);
router.get('/:id/webhook-secret', getWebhookSecret);
router.post('/:id/command', sendCommand);
router.patch('/:id', updateDevice);
router.delete('/:id', deleteDevice);

module.exports = router;