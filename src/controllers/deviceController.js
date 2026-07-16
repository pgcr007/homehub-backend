const Device = require('../models/Device');
const Room = require('../models/Room');
const { deriveDeviceSecret } = require('../services/webhookAuth');

const { DEVICE_TYPES, DEVICE_TYPE_NAMES } = Device;

async function assertRoomOwnership(roomId, ownerId) {
  if (!roomId) return null;
  const room = await Room.findOne({ _id: roomId, owner: ownerId });
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
 * devices (e.g. the {deviceId} segment of home/{ownerId}/{deviceId}/state).
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

    const roomId = await assertRoomOwnership(room, req.userId);
    const protocol = DEVICE_TYPES[type].protocol;

    const device = await Device.create({
      name: name.trim(),
      owner: req.userId,
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
  const filter = { owner: req.userId };
  if (req.query.room) filter.room = req.query.room;

  const devices = await Device.find(filter).sort({ createdAt: -1 });
  return res.json({ devices });
}

async function getDevice(req, res) {
  const device = await Device.findOne({ _id: req.params.id, owner: req.userId });
  if (!device) return res.status(404).json({ error: 'device not found' });
  return res.json({ device });
}

/**
 * GET /api/devices/:id/webhook-secret
 * Separate from the main device payload so the secret isn't echoed back on
 * every ordinary list/get call — only fetched when actually needed.
 */
async function getWebhookSecret(req, res) {
  const device = await Device.findOne({ _id: req.params.id, owner: req.userId });
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
    const device = await Device.findOne({ _id: req.params.id, owner: req.userId });
    if (!device) return res.status(404).json({ error: 'device not found' });

    const { name, room } = req.body;

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      device.name = name.trim();
    }

    if (room !== undefined) {
      device.room = room === null ? null : await assertRoomOwnership(room, req.userId);
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
  const device = await Device.findOneAndDelete({ _id: req.params.id, owner: req.userId });
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
};