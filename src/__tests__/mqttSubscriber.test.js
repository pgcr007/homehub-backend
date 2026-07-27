const mongoose = require('mongoose');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'test-webhook-secret';

// mqttService and socketService are required lazily (inside function bodies) by
// mqttSubscriber.js specifically to dodge circular imports — jest.mock still
// intercepts those lazy requires the same way it would top-level ones.
jest.mock('../services/mqttService', () => ({
  publishNormalizedEvent: jest.fn(),
}));
jest.mock('../services/socketService', () => ({
  emitDeviceEvent: jest.fn(),
}));
// fcmService is required top-level by mqttSubscriber.js (no circular-import
// concern there, unlike mqttService/socketService), so this mock covers it.
jest.mock('../services/fcmService', () => ({
  sendToHousehold: jest.fn(),
}));

const Device = require('../models/Device');
const EventLog = require('../models/EventLog');
const Household = require('../models/Household');
const { publishNormalizedEvent } = require('../services/mqttService');
const { emitDeviceEvent } = require('../services/socketService');
const { sendToHousehold } = require('../services/fcmService');
const {
  handleIncomingMessage,
  handleStateTopic,
  handleStatusTopic,
  handleNormalizedTopic,
  householdExists,
} = require('../services/mqttSubscriber');

// Phase 6 Step 3's householdExists check means a device's `household` field
// now has to point at a real Household document, not just any ObjectId —
// otherwise handleStateTopic/handleStatusTopic will (correctly) treat it as
// an unknown/spoofed household and drop the message before ever looking up
// the device.
async function createDevice(overrides = {}) {
  const household = await Household.create({
    name: 'Test Household',
    members: [{ user: new mongoose.Types.ObjectId(), role: 'owner' }],
  });
  return Device.create({
    name: 'Test Plug',
    household: household._id,
    createdBy: new mongoose.Types.ObjectId(),
    type: 'tasmota_plug',
    protocol: 'mqtt',
    identifier: 'plug-1',
    ...overrides,
  });
}

describe('mqttSubscriber', () => {
  beforeAll(async () => {
    await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    jest.clearAllMocks();
  });

  describe('handleStateTopic', () => {
    it('normalizes a valid payload, updates device state/status/lastSeen, and logs an EventLog', async () => {
      const device = await createDevice();
      const payload = Buffer.from(JSON.stringify({ POWER: 'ON' }));

      await handleStateTopic(device.household.toString(), device.identifier, payload);

      const updated = await Device.findById(device._id);
      expect(updated.state).toEqual({ power: 'on' });
      expect(updated.status).toBe('online');
      expect(updated.lastSeen).not.toBeNull();

      const events = await EventLog.find({ device: device._id });
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('mqtt');
      expect(events[0].type).toBe('state_change');
      expect(events[0].normalizedState).toEqual({ power: 'on' });
      expect(events[0].household.toString()).toBe(device.household.toString());

      expect(publishNormalizedEvent).toHaveBeenCalledWith(
        expect.objectContaining({ _id: device._id }),
        { power: 'on' }
      );
    });

    it('drops the message silently when no device matches household+identifier', async () => {
      await handleStateTopic(new mongoose.Types.ObjectId().toString(), 'nonexistent', Buffer.from('{}'));
      expect(await EventLog.countDocuments()).toBe(0);
      expect(publishNormalizedEvent).not.toHaveBeenCalled();
    });

    it('drops the message when the device is webhook-protocol, not mqtt', async () => {
      const device = await createDevice({
        type: 'webhook_thermostat',
        protocol: 'webhook',
        identifier: 'thermo-1',
      });
      await handleStateTopic(device.household.toString(), device.identifier, Buffer.from(JSON.stringify({ temp: 20 })));

      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('unknown'); // untouched default
      expect(await EventLog.countDocuments()).toBe(0);
    });

    it('drops malformed JSON without throwing', async () => {
      const device = await createDevice();
      await expect(
        handleStateTopic(device.household.toString(), device.identifier, Buffer.from('not json'))
      ).resolves.toBeUndefined();
      expect(await EventLog.countDocuments()).toBe(0);
    });

    it('drops a payload that fails normalization without throwing', async () => {
      const device = await createDevice(); // tasmota_plug expects a POWER field
      await expect(
        handleStateTopic(device.household.toString(), device.identifier, Buffer.from(JSON.stringify({ nope: true })))
      ).resolves.toBeUndefined();
      expect(await EventLog.countDocuments()).toBe(0);
    });
  });

  describe('handleStatusTopic (LWT)', () => {
    it('marks a device offline on an "Offline" payload and logs it', async () => {
      const device = await createDevice({ status: 'online', lastSeen: new Date() });
      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('Offline'));

      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('offline');

      const events = await EventLog.find({ device: device._id });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('offline');
    });

    it('marks a device online on an "Online" payload, updates lastSeen, and logs it', async () => {
      const device = await createDevice({ status: 'offline' });
      const before = device.lastSeen;

      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('online'));

      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('online');
      expect(updated.lastSeen).not.toEqual(before);

      const events = await EventLog.find({ device: device._id });
      expect(events[0].type).toBe('online');
    });

    it('ignores an unrecognized status payload', async () => {
      const device = await createDevice({ status: 'online' });
      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('lol what'));

      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('online'); // unchanged
      expect(await EventLog.countDocuments()).toBe(0);
    });

    it('sends a push alert naming the device on a genuine online->offline transition', async () => {
      const device = await createDevice({ name: 'Front Door Sensor', status: 'online' });
      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('Offline'));

      expect(sendToHousehold).toHaveBeenCalledTimes(1);
      const [householdArg, notificationArg] = sendToHousehold.mock.calls[0];
      expect(householdArg.toString()).toBe(device.household.toString());
      expect(notificationArg.body).toContain('Front Door Sensor');
    });

    it('does not re-send an offline alert for a retained-LWT redelivery of the same status', async () => {
      const device = await createDevice({ status: 'offline' });
      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('Offline'));

      expect(sendToHousehold).not.toHaveBeenCalled();
    });

    it('does not send an offline alert on an online transition', async () => {
      const device = await createDevice({ status: 'offline' });
      await handleStatusTopic(device.household.toString(), device.identifier, Buffer.from('online'));

      expect(sendToHousehold).not.toHaveBeenCalled();
    });
  });

  describe('householdExists defense-in-depth check (Phase 6 Step 3)', () => {
    it('returns true for a real household id', async () => {
      const household = await Household.create({
        name: 'Real Household',
        members: [{ user: new mongoose.Types.ObjectId(), role: 'owner' }],
      });
      expect(await householdExists(household._id.toString())).toBe(true);
    });

    it('returns false for a well-formed but nonexistent household id', async () => {
      expect(await householdExists(new mongoose.Types.ObjectId().toString())).toBe(false);
    });

    it('returns false (not a throw) for a malformed household id', async () => {
      await expect(householdExists('not-an-object-id')).resolves.toBe(false);
    });

    it('drops a state message for an unknown household without looking up a device', async () => {
      const device = await createDevice();
      const fakeHouseholdId = new mongoose.Types.ObjectId().toString();

      await handleStateTopic(fakeHouseholdId, device.identifier, Buffer.from(JSON.stringify({ POWER: 'ON' })));

      // The real device (registered under a different, real household) must
      // be untouched — this message should never have reached the device lookup.
      const unchanged = await Device.findById(device._id);
      expect(unchanged.state).toEqual({});
      expect(await EventLog.countDocuments()).toBe(0);
    });

    it('drops a status message for an unknown household without updating any device', async () => {
      const device = await createDevice({ status: 'online' });
      const fakeHouseholdId = new mongoose.Types.ObjectId().toString();

      await handleStatusTopic(fakeHouseholdId, device.identifier, Buffer.from('Offline'));

      const unchanged = await Device.findById(device._id);
      expect(unchanged.status).toBe('online'); // unchanged, not flipped to offline
      expect(await EventLog.countDocuments()).toBe(0);
    });
  });

  describe('handleNormalizedTopic', () => {
    it('re-broadcasts the payload to Socket.IO without touching the DB', async () => {
      const householdId = new mongoose.Types.ObjectId().toString();
      const deviceId = new mongoose.Types.ObjectId().toString();
      const payload = Buffer.from(JSON.stringify({ power: 'on' }));

      await handleNormalizedTopic(householdId, deviceId, payload);

      expect(emitDeviceEvent).toHaveBeenCalledWith(householdId, { deviceId, state: { power: 'on' } });
      expect(await EventLog.countDocuments()).toBe(0);
    });

    it('drops malformed JSON without throwing', async () => {
      await expect(
        handleNormalizedTopic('household-1', 'device-1', Buffer.from('not json'))
      ).resolves.toBeUndefined();
      expect(emitDeviceEvent).not.toHaveBeenCalled();
    });
  });

  describe('handleIncomingMessage (topic dispatch)', () => {
    it('routes a /state topic to handleStateTopic', async () => {
      const device = await createDevice();
      await handleIncomingMessage(
        `home/${device.household}/${device.identifier}/state`,
        Buffer.from(JSON.stringify({ POWER: 'ON' }))
      );
      const updated = await Device.findById(device._id);
      expect(updated.state).toEqual({ power: 'on' });
    });

    it('routes a /status topic to handleStatusTopic', async () => {
      const device = await createDevice({ status: 'online' });
      await handleIncomingMessage(`home/${device.household}/${device.identifier}/status`, Buffer.from('Offline'));
      const updated = await Device.findById(device._id);
      expect(updated.status).toBe('offline');
    });

    it('routes a /normalized topic to handleNormalizedTopic', async () => {
      const householdId = new mongoose.Types.ObjectId().toString();
      await handleIncomingMessage(`home/${householdId}/someDeviceId/normalized`, Buffer.from(JSON.stringify({ motion: 'detected' })));
      expect(emitDeviceEvent).toHaveBeenCalledWith(householdId, { deviceId: 'someDeviceId', state: { motion: 'detected' } });
    });

    it('silently ignores an unrecognized topic shape', async () => {
      await expect(
        handleIncomingMessage('homehub/test/ping', Buffer.from('hello'))
      ).resolves.toBeUndefined();
      expect(publishNormalizedEvent).not.toHaveBeenCalled();
      expect(emitDeviceEvent).not.toHaveBeenCalled();
    });
  });
});