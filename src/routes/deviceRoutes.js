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
} = require('../controllers/deviceController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);

router.post('/', createDevice);
router.get('/', listDevices);
router.get('/:id', getDevice);
router.get('/:id/webhook-secret', getWebhookSecret);
router.post('/:id/command', sendCommand);
router.patch('/:id', updateDevice);
router.delete('/:id', deleteDevice);

module.exports = router;