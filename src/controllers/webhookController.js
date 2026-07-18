const Device = require('../models/Device');
const EventLog = require('../models/EventLog');
const { normalizeEvent } = require('../services/eventNormalizer');
const { verifySignature } = require('../services/webhookAuth');
const { publishNormalizedEvent } = require('../services/mqttService');
const { evaluateRulesForEvent, consumePendingChain } = require('../services/ruleEngine');

/**
 * POST /api/webhooks/:deviceId
 *
 * Public endpoint (no user JWT — vendors can't get one) secured instead by a
 * per-device HMAC signature in the X-HomeHub-Signature header, computed over
 * the raw request body. This is the "most likely abuse target" the security
 * checklist calls out, so: raw-body signature check happens before any JSON
 * parsing or DB work, and a dedicated rate limiter (see app.js) applies here.
 */
async function handleWebhookEvent(req, res) {
  const { deviceId } = req.params;

  let device;
  try {
    device = await Device.findById(deviceId);
  } catch {
    // Malformed ObjectId — treat the same as "not found", don't leak shape info.
    return res.status(404).json({ error: 'device not found' });
  }
  if (!device) {
    return res.status(404).json({ error: 'device not found' });
  }
  if (device.protocol !== 'webhook') {
    return res.status(400).json({ error: 'device does not use the webhook protocol' });
  }

  const signature = req.headers['x-homehub-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!verifySignature(device._id.toString(), rawBody, signature)) {
    return res.status(401).json({ error: 'invalid or missing signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'body must be valid JSON' });
  }

  let normalizedState;
  try {
    ({ normalizedState } = normalizeEvent(device, payload));
  } catch (err) {
    // Bad/unexpected payload shape from the vendor — a client error, not a server one.
    return res.status(422).json({ error: err.message });
  }

  try {
    const previousState = { ...device.state };
    const { chainId, chainDepth } = consumePendingChain(device._id);

    device.state = { ...device.state, ...normalizedState };
    device.status = 'online';
    device.lastSeen = new Date();
    await device.save();

    await EventLog.create({
      device: device._id,
      owner: device.owner,
      source: 'webhook',
      type: 'state_change',
      normalizedState,
      rawPayload: payload,
      chainId,
      chainDepth,
    });

    publishNormalizedEvent(device, normalizedState);

    await evaluateRulesForEvent({ device, normalizedState, previousState, chainId, chainDepth });

    return res.json({ status: 'ok', state: device.state });
  } catch (err) {
    console.error('[webhook] failed to persist event:', err.message);
    return res.status(500).json({ error: 'failed to record event' });
  }
}

module.exports = { handleWebhookEvent };