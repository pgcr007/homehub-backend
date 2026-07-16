const Room = require('../models/Room');
const Device = require('../models/Device');

async function createRoom(req, res) {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const room = await Room.create({ name: name.trim(), owner: req.userId });
    return res.status(201).json({ room });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'a room with that name already exists' });
    }
    console.error('[rooms] create error:', err.message);
    return res.status(500).json({ error: 'failed to create room' });
  }
}

async function listRooms(req, res) {
  const rooms = await Room.find({ owner: req.userId }).sort({ name: 1 });
  return res.json({ rooms });
}

async function updateRoom(req, res) {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const room = await Room.findOne({ _id: req.params.id, owner: req.userId });
  if (!room) return res.status(404).json({ error: 'room not found' });

  room.name = name.trim();
  try {
    await room.save();
    return res.json({ room });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'a room with that name already exists' });
    }
    console.error('[rooms] update error:', err.message);
    return res.status(500).json({ error: 'failed to update room' });
  }
}

async function deleteRoom(req, res) {
  const room = await Room.findOne({ _id: req.params.id, owner: req.userId });
  if (!room) return res.status(404).json({ error: 'room not found' });

  // Unassign (not delete) any devices in this room rather than orphaning
  // the request in a half-deleted state.
  await Device.updateMany({ room: room._id, owner: req.userId }, { $set: { room: null } });
  await room.deleteOne();

  return res.json({ status: 'deleted' });
}

module.exports = { createRoom, listRooms, updateRoom, deleteRoom };