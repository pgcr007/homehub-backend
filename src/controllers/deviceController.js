const Device = require('../models/Device');
const Room = require('../models/Room');
const { deriveDeviceSecret } = require('../services/webhookAuth');
const { publishCommand } = require('../services/mqttService');

const { DEVICE_TYPES, DEVICE_TYPE_NAMES } = Device;

async function assertRoomInHousehold(roomId, householdId) {
  if (!roomId) return null;
  const room = await Room.findOne({ _id: roomId, household: householdId });
  if (!room) {
    const err = new Error('room not found');
    err.status = 400;
    throw err;
  }
  return room._id;
}

/**
 * POST /api/devices
 * body: { name, type, identifier, room? }
 * `identifier` is the human-facing label used in MQTT topics for MQTT-protocol
 * devices (e.g. the {deviceId} segment of home/{householdId}/{deviceId}/state).
 * For webhook-protocol devices it's just a label — the actual webhook secret
 * is keyed off the Device's _id, returned once in this response.
 */
async function createDevice(req, res) {
  try {
    const { name, type, identifier, room } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!type || !DEVICE_TYPE_NAMES.includes(type)) {
      return res.status(400).json({
        error: `type must be one of: ${DEVICE_TYPE_NAMES.join(', ')}`,
      });
    }
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'identifier is required' });
    }

    const roomId = await assertRoomInHousehold(room, req.householdId);
    const protocol = DEVICE_TYPES[type].protocol;

    const device = await Device.create({
      name: name.trim(),
      household: req.householdId,
      createdBy: req.userId,
      room: roomId,
      type,
      protocol,
      identifier: identifier.trim(),
      capabilities: DEVICE_TYPES[type].capabilities,
    });

    const response = { device };
    if (protocol === 'webhook') {
      response.webhookUrl = `/api/webhooks/${device._id}`;
      response.webhookSecret = deriveDeviceSecret(device._id.toString());
      response.note =
        'Configure the vendor to POST here and sign the raw body with this secret ' +
        '(HMAC-SHA256, header X-HomeHub-Signature, hex-encoded). ' +
        'This secret can be re-fetched any time via GET /api/devices/:id/webhook-secret.';
    }

    return res.status(201).json(response);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === 11000) {
      return res.status(409).json({ error: 'a device with that identifier already exists' });
    }
    console.error('[devices] create error:', err.message);
    return res.status(500).json({ error: 'failed to create device' });
  }
}

/** GET /api/devices?room=<roomId> */
async function listDevices(req, res) {
  const filter = { household: req.householdId };
  if (req.query.room) filter.room = req.query.room;

  const devices = await Device.find(filter).sort({ createdAt: -1 });
  return res.json({ devices });
}

async function getDevice(req, res) {
  const device = await Device.findOne({ _id: req.params.id, household: req.householdId });
  if (!device) return res.status(404).json({ error: 'device not found' });
  return res.json({ device });
}

/**
 * POST /api/devices/:id/command
 * body: { <capability>: <value>, ... } e.g. { "power": "on" } or { "power": "on", "brightness": 60 }
 * Only MQTT-protocol devices accept commands this way — webhook-protocol
 * devices (the thermostat) would need a vendor-specific outbound call,
 * which is out of scope for now.
 */
async function sendCommand(req, res) {
  try {
    const device = await Device.findOne({ _id: req.params.id, household: req.householdId });
    if (!device) return res.status(404).json({ error: 'device not found' });

    if (device.protocol !== 'mqtt') {
      return res.status(400).json({ error: 'this device does not accept commands over MQTT' });
    }

    const command = req.body;
    if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(command).length === 0) {
      return res.status(400).json({ error: 'command body must be a non-empty object, e.g. { "power": "on" }' });
    }

    const topic = publishCommand(device, command);
    return res.json({ status: 'sent', topic, command });
  } catch (err) {
    console.error('[devices] command error:', err.message);
    return res.status(500).json({ error: 'failed to send command' });
  }
}

/**
 * GET /api/devices/:id/webhook-secret
 * Separate from the main device payload so the secret isn't echoed back on
 * every ordinary list/get call — only fetched when actually needed.
 */
async function getWebhookSecret(req, res) {
  const device = await Device.findOne({ _id: req.params.id, household: req.householdId });
  if (!device) return res.status(404).json({ error: 'device not found' });
  if (device.protocol !== 'webhook') {
    return res.status(400).json({ error: 'device does not use the webhook protocol' });
  }
  return res.json({
    webhookUrl: `/api/webhooks/${device._id}`,
    webhookSecret: deriveDeviceSecret(device._id.toString()),
  });
}

/**
 * PATCH /api/devices/:id
 * Only name and room are mutable. `type`, `protocol`, and `identifier` are
 * fixed at creation — changing them would silently break an already-configured
 * physical device or vendor webhook pointing at the old values.
 */
async function updateDevice(req, res) {
  try {
    const device = await Device.findOne({ _id: req.params.id, household: req.householdId });
    if (!device) return res.status(404).json({ error: 'device not found' });

    const { name, room } = req.body;

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      device.name = name.trim();
    }

    if (room !== undefined) {
      device.room = room === null ? null : await assertRoomInHousehold(room, req.householdId);
    }

    await device.save();
    return res.json({ device });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[devices] update error:', err.message);
    return res.status(500).json({ error: 'failed to update device' });
  }
}

async function deleteDevice(req, res) {
  const device = await Device.findOneAndDelete({ _id: req.params.id, household: req.householdId });
  if (!device) return res.status(404).json({ error: 'device not found' });
  return res.json({ status: 'deleted' });
}

module.exports = {
  createDevice,
  listDevices,
  getDevice,
  getWebhookSecret,
  updateDevice,
  deleteDevice,
  sendCommand,
};