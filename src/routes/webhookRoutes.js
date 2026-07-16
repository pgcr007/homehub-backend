const express = require('express');
const { handleWebhookEvent } = require('../controllers/webhookController');

const router = express.Router();

// express.raw (not express.json) so the controller can verify the HMAC
// signature against the exact bytes received, before any parsing happens.
router.post(
  '/:deviceId',
  express.raw({ type: '*/*', limit: '100kb' }),
  handleWebhookEvent
);

module.exports = router;