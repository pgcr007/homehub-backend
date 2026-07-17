const mongoose = require('mongoose');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const Device = require('../models/Device');
const EventLog = require('../models/EventLog');
const { checkStaleDevices, getStaleThresholdMs } = require('../services/staleStateChecker');

async function createDevice(overrides = {}) {
  return Device.create({
    name: 'Test Sensor',
    owner: new mongoose.Types.ObjectId(),
    type: 'esphome_motion_sensor',
    protocol: 'mqtt',
    identifier: 'motion-1',
    ...overrides,
  });
}

describe('staleStateChecker', () => {
  beforeAll(async () => {
    await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  it('demotes an online device whose lastSeen is past the threshold to unknown', async () => {
    const staleCutoff = new Date(Date.now() - getStaleThresholdMs() - 1000);
    const device = await createDevice({ status: 'online', lastSeen: staleCutoff });

    const count = await checkStaleDevices();

    expect(count).toBe(1);
    const updated = await Device.findById(device._id);
    expect(updated.status).toBe('unknown');

    const events = await EventLog.find({ device: device._id });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
    expect(events[0].source).toBe('mqtt');
  });

  it('leaves an online device with a recent lastSeen untouched', async () => {
    const device = await createDevice({ status: 'online', lastSeen: new Date() });

    const count = await checkStaleDevices();

    expect(count).toBe(0);
    const updated = await Device.findById(device._id);
    expect(updated.status).toBe('online');
    expect(await EventLog.countDocuments()).toBe(0);
  });

  it('does not touch a device already offline, even if stale', async () => {
    const staleCutoff = new Date(Date.now() - getStaleThresholdMs() - 1000);
    const device = await createDevice({ status: 'offline', lastSeen: staleCutoff });

    const count = await checkStaleDevices();

    expect(count).toBe(0);
    const updated = await Device.findById(device._id);
    expect(updated.status).toBe('offline');
  });

  it('does not touch a device that has never reported (lastSeen null, status unknown)', async () => {
    const device = await createDevice({ status: 'unknown', lastSeen: null });

    const count = await checkStaleDevices();

    expect(count).toBe(0);
    const updated = await Device.findById(device._id);
    expect(updated.status).toBe('unknown');
  });

  it('respects a custom STALE_THRESHOLD_MS from the environment', async () => {
    const original = process.env.STALE_THRESHOLD_MS;
    process.env.STALE_THRESHOLD_MS = '1000'; // 1 second
    try {
      const device = await createDevice({ status: 'online', lastSeen: new Date(Date.now() - 5000) });
      const count = await checkStaleDevices();
      expect(count).toBe(1);
      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('unknown');
    } finally {
      if (original === undefined) delete process.env.STALE_THRESHOLD_MS;
      else process.env.STALE_THRESHOLD_MS = original;
    }
  });
});