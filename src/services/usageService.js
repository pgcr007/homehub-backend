const EventLog = require('../models/EventLog');
const Device = require('../models/Device');

/**
 * Reconstructs on/off duration per power-capable device from EventLog
 * state_change events, over a trailing window. This is a walk, not a
 * stored aggregate — EventLog is the source of truth for device state
 * history (see eventNormalizer.js), so usage is derived on read rather
 * than tracked as a separate running counter that could drift out of
 * sync with the log.
 *
 * Approximation, by design: if a device has never reported a power event
 * before the window starts, it's assumed "off" at windowStart rather than
 * guessing from current state. This undercounts a device that was already
 * on before the window and never toggled again — acceptable for a v1
 * "roughly how much is this thing running" view, not a billing-grade meter.
 */
async function computeUsage(householdId, days = 7) {
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const now = new Date();

  const devices = await Device.find({
    household: householdId,
    capabilities: 'power',
  }).populate('room', 'name');

  const results = [];

  for (const device of devices) {
    const priorEvent = await EventLog.findOne({
      device: device._id,
      type: 'state_change',
      'normalizedState.power': { $exists: true },
      createdAt: { $lt: windowStart },
    }).sort({ createdAt: -1 });

    let currentPower = priorEvent?.normalizedState?.power ?? 'off';
    let cursor = windowStart;
    let onMs = 0;

    const events = await EventLog.find({
      device: device._id,
      type: 'state_change',
      'normalizedState.power': { $exists: true },
      createdAt: { $gte: windowStart, $lte: now },
    }).sort({ createdAt: 1 });

    for (const ev of events) {
      if (currentPower === 'on') {
        onMs += ev.createdAt.getTime() - cursor.getTime();
      }
      cursor = ev.createdAt;
      currentPower = ev.normalizedState.power;
    }

    // Tail: still "on" from the last event through to now.
    if (currentPower === 'on') {
      onMs += now.getTime() - cursor.getTime();
    }

    results.push({
      deviceId: device._id.toString(),
      name: device.name,
      type: device.type,
      room: device.room ? { id: device.room._id.toString(), name: device.room.name } : null,
      onHours: Math.round((onMs / 3600000) * 100) / 100,
    });
  }

  results.sort((a, b) => b.onHours - a.onHours);

  const totalOnHours = Math.round(
    results.reduce((sum, r) => sum + r.onHours, 0) * 100
  ) / 100;

  return {
    windowDays: days,
    generatedAt: now,
    totalOnHours,
    devices: results,
  };
}

module.exports = { computeUsage };