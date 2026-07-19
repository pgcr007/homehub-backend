const request = require('supertest');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');
const { createAuthedHousehold } = require('../testUtils/authHelpers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'test-webhook-secret';

const app = require('../app');

describe('Device API', () => {
  let auth;

  beforeAll(async () => {
    await connectTestDB();
  }, 30000); // first run downloads a real mongod binary — can exceed Jest's 5s default

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    auth = await createAuthedHousehold();
  });

  it('rejects an unsupported device type', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Mystery Gadget', type: 'not_real', identifier: 'x1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type must be one of/);
  });

  it('creates an MQTT-protocol device with derived capabilities', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Living Room Plug', type: 'tasmota_plug', identifier: 'lr-plug-1' });

    expect(res.status).toBe(201);
    expect(res.body.device.protocol).toBe('mqtt');
    expect(res.body.device.capabilities).toEqual(['power']);
    expect(res.body.device.household).toBe(auth.householdId);
    expect(res.body.webhookUrl).toBeUndefined();
  });

  it('creates a webhook-protocol device and returns a derivable secret', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Living Room Thermostat', type: 'webhook_thermostat', identifier: 'thermo-1' });

    expect(res.status).toBe(201);
    expect(res.body.device.protocol).toBe('webhook');
    expect(res.body.webhookUrl).toBe(`/api/webhooks/${res.body.device._id}`);
    expect(res.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    // The secret is re-derivable via a dedicated endpoint, not just returned once.
    const secretFetch = await request(app)
      .get(`/api/devices/${res.body.device._id}/webhook-secret`)
      .set(auth.headers);
    expect(secretFetch.body.webhookSecret).toBe(res.body.webhookSecret);
  });

  it('rejects a duplicate identifier for the same household', async () => {
    await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Plug A', type: 'tasmota_plug', identifier: 'dupe-1' });
    const dupe = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Plug B', type: 'tasmota_plug', identifier: 'dupe-1' });
    expect(dupe.status).toBe(409);
  });

  it('allows the same identifier across two different households', async () => {
    await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Plug A', type: 'tasmota_plug', identifier: 'shared-id' });
    const otherAuth = await createAuthedHousehold();
    const res = await request(app)
      .post('/api/devices')
      .set(otherAuth.headers)
      .send({ name: 'Plug B', type: 'tasmota_plug', identifier: 'shared-id' });
    expect(res.status).toBe(201);
  });

  it('rejects assigning a device to a room belonging to a different household', async () => {
    const otherAuth = await createAuthedHousehold();
    const otherRoom = await request(app).post('/api/rooms').set(otherAuth.headers).send({ name: 'Their Room' });

    const res = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Plug', type: 'tasmota_plug', identifier: 'p1', room: otherRoom.body.room._id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/room not found/);
  });

  it('scopes list/get/delete to the household', async () => {
    const mine = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Mine', type: 'tasmota_plug', identifier: 'mine-1' });

    const otherAuth = await createAuthedHousehold();
    await request(app)
      .post('/api/devices')
      .set(otherAuth.headers)
      .send({ name: 'Theirs', type: 'tasmota_plug', identifier: 'theirs-1' });

    const list = await request(app).get('/api/devices').set(auth.headers);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].name).toBe('Mine');

    const getOther = await request(app)
      .get(`/api/devices/${mine.body.device._id}`)
      .set(otherAuth.headers);
    expect(getOther.status).toBe(404);

    const del = await request(app).delete(`/api/devices/${mine.body.device._id}`).set(otherAuth.headers);
    expect(del.status).toBe(404);
  });

  it('a second member of the same household can see a device the first member created', async () => {
    const created = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Shared Plug', type: 'tasmota_plug', identifier: 'shared-plug-1' });

    // Simulate a second member joining the same household directly via the model.
    const Household = require('../models/Household');
    const mongoose = require('mongoose');
    const secondUserId = new mongoose.Types.ObjectId().toString();
    await Household.findByIdAndUpdate(auth.householdId, {
      $push: { members: { user: secondUserId, role: 'member' } },
    });
    const { tokenFor } = require('../testUtils/authHelpers');
    const secondHeaders = {
      Authorization: `Bearer ${tokenFor(secondUserId)}`,
      'X-Household-Id': auth.householdId,
    };

    const get = await request(app).get(`/api/devices/${created.body.device._id}`).set(secondHeaders);
    expect(get.status).toBe(200);
    expect(get.body.device.name).toBe('Shared Plug');
  });

  it('renames a device but rejects changing its type/identifier via PATCH', async () => {
    const created = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Old Name', type: 'tasmota_plug', identifier: 'immutable-1' });

    const patch = await request(app)
      .patch(`/api/devices/${created.body.device._id}`)
      .set(auth.headers)
      .send({ name: 'New Name', type: 'esphome_motion_sensor', identifier: 'hijacked' });

    expect(patch.status).toBe(200);
    expect(patch.body.device.name).toBe('New Name');
    expect(patch.body.device.type).toBe('tasmota_plug'); // unchanged
    expect(patch.body.device.identifier).toBe('immutable-1'); // unchanged
  });
});