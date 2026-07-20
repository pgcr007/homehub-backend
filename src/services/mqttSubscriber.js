const Device = require('../models/Device');
const EventLog = require('../models/EventLog');
const { normalizeEvent } = require('./eventNormalizer');
const Household = require('../models/Household');

/**
 * This is the MQTT-side mirror of webhookController.js. The webhook-in path
 * (device state -> normalize -> store -> log -> republish) and this module's
 * native-MQTT path converge on exactly the same DB writes and exactly the
 * same `home/{householdId}/{deviceId}/normalized` republish that the
 * Socket.IO bridge and the rule engine both consume.
 *
 * Three topic shapes are handled, matching docs/DEVICE_SHORTLIST.md's
 * `home/{householdId}/{deviceId}/...` convention ({deviceId} in the state/
 * status topics is the device's `identifier` field, NOT its Mongo _id —
 * identifier is what's actually configured on the physical device/firmware):
 *
 *   home/{householdId}/{identifier}/state       - raw device payload (Tasmota/ESPHome)
 *   home/{householdId}/{identifier}/status      - Last Will and Testament: "Online"/"Offline"
 *   home/{householdId}/{deviceId}/normalized     - our own republished output (deviceId = _id here);
 *                                              re-broadcast to Socket.IO clients, not re-normalized
 */

const STATE_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/state$/;
const STATUS_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/status$/;
const NORMALIZED_TOPIC_RE = /^home\/([^/]+)\/([^/]+)\/normalized$/;

/**
 * Phase 6 Step 3 defense-in-depth. The broker's own ACLs (see
 * docs/PHASE6_STEP3_BROKER_ACL.md) are what's actually supposed to stop a
 * device credential from ever publishing outside its own household's topic
 * tree — but that's configured in HiveMQ Cloud's console, which this
 * backend has no API visibility into and can't unit-test. This check
 * can't catch an ACL that's misconfigured too *broad* (no way to inspect
 * that from here), but it does catch the cheaper, more common failure: a
 * message arriving for a household ID that doesn't exist at all, which
 * only happens via a typo'd/spoofed topic or a household that's since been
 * deleted. Logged distinctly from an ordinary "device not registered"
 * miss (see findDeviceByIdentifier below) so it's easy to grep for as a
 * possible ACL/security issue rather than routine noise.
 */
async function householdExists(householdId) {
  try {
    return Boolean(await Household.exists({ _id: householdId }));
  } catch {
    // Malformed ObjectId — definitely not a real household.
    return false;
  }
}

/** Looks up a device by household+identifier, the same compound-unique key used at registration. */
async function findDeviceByIdentifier(householdId, identifier) {
  try {
    return await Device.findOne({ household: householdId, identifier });
  } catch (err) {
    // Malformed householdId (not a valid ObjectId) — treat as "no such device", don't crash the subscriber.
    console.warn(`[mqtt] device lookup failed for household=${householdId} identifier=${identifier}: ${err.message}`);
    return null;
  }
}

/**
 * Handles a raw device-state message: home/{householdId}/{identifier}/state
 * Mirrors handleWebhookEvent's state-write logic exactly, source tagged 'mqtt' instead of 'webhook'.
 */
async function handleStateTopic(householdId, identifier, payloadBuffer) {
  if (!(await householdExists(householdId))) {
    console.warn(
      `[mqtt][security] state message for unknown household=${householdId} identifier=${identifier} — possible ACL misconfiguration or stale/spoofed topic, dropping`
    );
    return;
  }

  const device = await findDeviceByIdentifier(householdId, identifier);
  if (!device) {
    console.warn(`[mqtt] no device registered for household=${householdId} identifier=${identifier}, dropping message`);
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
    // gets no state update this cycle.
    console.warn(`[mqtt] normalization failed for device ${device._id}: ${err.message}`);
    return;
  }

  // Captured before the merge below so the rule engine's 'changed' operator
  // and the EventLog entry both have a true before/after to compare against.
  const previousState = { ...device.state };

  // Was this event caused by a rule's device_command action (published to
  // this same device moments ago), or is it organic? Consumed now so both
  // the EventLog entry and the rule evaluation below agree on the same
  // chain context.
  const { evaluateRulesForEvent, consumePendingChain } = require('./ruleEngine');
  const { chainId, chainDepth } = consumePendingChain(device._id);

  device.state = { ...device.state, ...normalizedState };
  device.status = 'online';
  device.lastSeen = new Date();
  await device.save();

  await EventLog.create({
    device: device._id,
    household: device.household,
    source: 'mqtt',
    type: 'state_change',
    normalizedState,
    rawPayload: payload,
    chainId,
    chainDepth,
  });

  // Lazy require: mqttService requires this module to wire its message
  // handler, so a top-level require here would be a circular import that
  // resolves to an incomplete (pre-module.exports) object. By call time
  // (a real message arriving, well after both modules finish loading) the
  // require below always resolves to the fully-populated module.
  const { publishNormalizedEvent } = require('./mqttService');
  publishNormalizedEvent(device, normalizedState);

  await evaluateRulesForEvent({ device, normalizedState, previousState, chainId, chainDepth });
}

/**
 * Handles a Last Will and Testament / heartbeat message: home/{householdId}/{identifier}/status
 * Broker-delivered LWT payloads are conventionally "Online"/"Offline" (Tasmota's tele/LWT
 * default); we accept a few case-insensitive variants so ESPHome's availability payloads
 * ("online"/"offline") work the same way without a separate code path.
 */
async function handleStatusTopic(householdId, identifier, payloadBuffer) {
  if (!(await householdExists(householdId))) {
    console.warn(
      `[mqtt][security] status message for unknown household=${householdId} identifier=${identifier} — possible ACL misconfiguration or stale/spoofed topic, dropping`
    );
    return;
  }

  const device = await findDeviceByIdentifier(householdId, identifier);
  if (!device) {
    console.warn(`[mqtt] no device registered for household=${householdId} identifier=${identifier}, dropping status message`);
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
    household: device.household,
    source: 'mqtt',
    type: isOnline ? 'online' : 'offline',
    normalizedState: {},
    rawPayload: null,
  });

  // Push the status flip live too, not just capability state — same lazy
  // require as publishNormalizedEvent above, same circular-import reason.
  const { emitDeviceEvent } = require('./socketService');
  emitDeviceEvent(device.household.toString(), { deviceId: device._id.toString(), status: device.status });
}

/**
 * Handles our own republished normalized events: home/{householdId}/{deviceId}/normalized
 * These already went through normalizeEvent (via the webhook path or handleStateTopic above),
 * so this is a pure re-broadcast to any Socket.IO clients subscribed for that household — no DB
 * writes here, this topic is purely the fan-out point for the live-state push.
 */
async function handleNormalizedTopic(householdId, deviceId, payloadBuffer) {
  let normalizedState;
  try {
    normalizedState = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    console.warn(`[mqtt] malformed JSON on our own normalized topic for device ${deviceId}, dropping`);
    return;
  }

  const { emitDeviceEvent } = require('./socketService');
  emitDeviceEvent(householdId, { deviceId, state: normalizedState });
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
  householdExists,
};