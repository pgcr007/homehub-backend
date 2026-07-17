const Device = require('../models/Device');
const EventLog = require('../models/EventLog');
const { normalizeEvent } = require('./eventNormalizer');

/**
 * This is the MQTT-side mirror of webhookController.js. Phase 2 built the
 * webhook-in path (device state -> normalize -> store -> log -> republish);
 * this module builds the identical pipeline for native-MQTT devices, so both
 * integration paths converge on exactly the same DB writes and exactly the
 * same `home/{ownerId}/{deviceId}/normalized` republish that Phase 3's
 * Socket.IO bridge and Phase 5's rule engine both consume.
 *
 * Three topic shapes are handled, matching docs/DEVICE_SHORTLIST.md's
 * `home/{householdId}/{deviceId}/...` convention (householdId = owner's
 * User._id until Phase 6 introduces a real household model; {deviceId} here
 * is the device's `identifier` field, NOT its Mongo _id — identifier is
 * what's actually configured on the physical device/firmware):
 *
 *   home/{ownerId}/{identifier}/state       - raw device payload (Tasmota/ESPHome)
 *   home/{ownerId}/{identifier}/status      - Last Will and Testament: "Online"/"Offline"
 *   home/{ownerId}/{deviceId}/normalized     - our own republished output (deviceId = _id here);
 *                                              re-broadcast to Socket.IO clients, not re-normalized
 */

const STATE_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/state$/;
const STATUS_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/status$/;
const NORMALIZED_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/normalized$/;

/** Looks up a device by owner+identifier, the same compound-unique key used at registration. */
async function findDeviceByIdentifier(ownerId, identifier) {
  try {
    return await Device.findOne({ owner: ownerId, identifier });
  } catch (err) {
    // Malformed ownerId (not a valid ObjectId) — treat as "no such device", don't crash the subscriber.
    console.warn(`[mqtt] device lookup failed for owner=${ownerId} identifier=${identifier}: ${err.message}`);
    return null;
  }
}

/**
 * Handles a raw device-state message: home/{ownerId}/{identifier}/state
 * Mirrors handleWebhookEvent's state-write logic exactly, source tagged 'mqtt' instead of 'webhook'.
 */
async function handleStateTopic(ownerId, identifier, payloadBuffer) {
  const device = await findDeviceByIdentifier(ownerId, identifier);
  if (!device) {
    console.warn(`[mqtt] no device registered for owner=${ownerId} identifier=${identifier}, dropping message`);
    return;
  }
  if (device.protocol !== 'mqtt') {
    console.warn(`[mqtt] device ${device._id} is not an MQTT-protocol device, dropping message`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    console.warn(`[mqtt] malformed JSON on state topic for device ${device._id}, dropping message`);
    return;
  }

  let normalizedState;
  try {
    ({ normalizedState } = normalizeEvent(device, payload));
  } catch (err) {
    // Bad/unexpected payload shape — log and move on. Unlike the webhook endpoint (which can
    // return 422 to a caller), there's no request/response here to reject; the device just
    // gets no state update this cycle. This is exactly the "topic-naming and payload-shape
    // assumptions get proven wrong" risk the plan calls out for real-device testing.
    console.warn(`[mqtt] normalization failed for device ${device._id}: ${err.message}`);
    return;
  }

  device.state = { ...device.state, ...normalizedState };
  device.status = 'online';
  device.lastSeen = new Date();
  await device.save();

  await EventLog.create({
    device: device._id,
    owner: device.owner,
    source: 'mqtt',
    type: 'state_change',
    normalizedState,
    rawPayload: payload,
  });

  // Lazy require: mqttService requires this module to wire its message
  // handler, so a top-level require here would be a circular import that
  // resolves to an incomplete (pre-module.exports) object. By call time
  // (a real message arriving, well after both modules finish loading) the
  // require below always resolves to the fully-populated module.
  const { publishNormalizedEvent } = require('./mqttService');
  publishNormalizedEvent(device, normalizedState);
}

/**
 * Handles a Last Will and Testament / heartbeat message: home/{ownerId}/{identifier}/status
 * Broker-delivered LWT payloads are conventionally "Online"/"Offline" (Tasmota's tele/LWT
 * default); we accept a few case-insensitive variants so ESPHome's availability payloads
 * ("online"/"offline") work the same way without a separate code path.
 */
async function handleStatusTopic(ownerId, identifier, payloadBuffer) {
  const device = await findDeviceByIdentifier(ownerId, identifier);
  if (!device) {
    console.warn(`[mqtt] no device registered for owner=${ownerId} identifier=${identifier}, dropping status message`);
    return;
  }

  const raw = payloadBuffer.toString('utf8').trim().toLowerCase();
  const isOnline = raw === 'online' || raw === '1';
  const isOffline = raw === 'offline' || raw === '0';
  if (!isOnline && !isOffline) {
    console.warn(`[mqtt] unrecognized status payload '${raw}' for device ${device._id}, ignoring`);
    return;
  }

  // This is a protocol-level signal (broker-detected connect/disconnect), not a capability
  // reading, so it updates `status` directly rather than going through normalizeEvent.
  device.status = isOnline ? 'online' : 'offline';
  if (isOnline) device.lastSeen = new Date();
  await device.save();

  await EventLog.create({
    device: device._id,
    owner: device.owner,
    source: 'mqtt',
    type: isOnline ? 'online' : 'offline',
    normalizedState: {},
    rawPayload: null,
  });
}

/**
 * Handles our own republished normalized events: home/{ownerId}/{deviceId}/normalized
 * These already went through normalizeEvent (via the webhook path or handleStateTopic above),
 * so this is a pure re-broadcast to any Socket.IO clients subscribed for that owner — no DB
 * writes here, this topic is purely the fan-out point for Phase 3's live-state push.
 */
async function handleNormalizedTopic(ownerId, deviceId, payloadBuffer) {
  let normalizedState;
  try {
    normalizedState = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    console.warn(`[mqtt] malformed JSON on our own normalized topic for device ${deviceId}, dropping`);
    return;
  }

  const { emitDeviceEvent } = require('./socketService');
  emitDeviceEvent(ownerId, { deviceId, state: normalizedState });
}

/**
 * Single dispatch point wired into mqttService's `client.on('message', ...)`.
 * Unrecognized topics (e.g. a stray legacy `homehub/test/#` message) are silently ignored.
 */
async function handleIncomingMessage(topic, payloadBuffer) {
  let match = STATE_TOPIC_RE.exec(topic);
  if (match) return handleStateTopic(match[1], match[2], payloadBuffer);

  match = STATUS_TOPIC_RE.exec(topic);
  if (match) return handleStatusTopic(match[1], match[2], payloadBuffer);

  match = NORMALIZED_TOPIC_RE.exec(topic);
  if (match) return handleNormalizedTopic(match[1], match[2], payloadBuffer);
}

module.exports = {
  handleIncomingMessage,
  handleStateTopic,
  handleStatusTopic,
  handleNormalizedTopic,
};