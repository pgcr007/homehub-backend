const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const {
  createDevice,
  listDevices,
  getDevice,
  getWebhookSecret,
  updateDevice,
  deleteDevice,
} = require('../controllers/deviceController');

const router = express.Router();

router.use(requireAuth);

router.post('/', createDevice);
router.get('/', listDevices);
router.get('/:id', getDevice);
router.get('/:id/webhook-secret', getWebhookSecret);
router.patch('/:id', updateDevice);
router.delete('/:id', deleteDevice);

module.exports = router;