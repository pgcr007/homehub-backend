const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'test-webhook-secret';

const app = require('../app');

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET);
}

describe('Device API', () => {
  let userId;
  let auth;

  beforeAll(async () => {
  await connectTestDB();
}, 30000); // first run downloads a real mongod binary — can exceed Jest's 5s default

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    userId = new mongoose.Types.ObjectId().toString();
    auth = { Authorization: `Bearer ${tokenFor(userId)}` };
  });

  it('rejects an unsupported device type', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Mystery Gadget', type: 'not_real', identifier: 'x1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type must be one of/);
  });

  it('creates an MQTT-protocol device with derived capabilities', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Living Room Plug', type: 'tasmota_plug', identifier: 'lr-plug-1' });

    expect(res.status).toBe(201);
    expect(res.body.device.protocol).toBe('mqtt');
    expect(res.body.device.capabilities).toEqual(['power']);
    expect(res.body.webhookUrl).toBeUndefined();
  });

  it('creates a webhook-protocol device and returns a derivable secret', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Living Room Thermostat', type: 'webhook_thermostat', identifier: 'thermo-1' });

    expect(res.status).toBe(201);
    expect(res.body.device.protocol).toBe('webhook');
    expect(res.body.webhookUrl).toBe(`/api/webhooks/${res.body.device._id}`);
    expect(res.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    // The secret is re-derivable via a dedicated endpoint, not just returned once.
    const secretFetch = await request(app)
      .get(`/api/devices/${res.body.device._id}/webhook-secret`)
      .set(auth);
    expect(secretFetch.body.webhookSecret).toBe(res.body.webhookSecret);
  });

  it('rejects a duplicate identifier for the same owner', async () => {
    await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Plug A', type: 'tasmota_plug', identifier: 'dupe-1' });
    const dupe = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Plug B', type: 'tasmota_plug', identifier: 'dupe-1' });
    expect(dupe.status).toBe(409);
  });

  it('rejects assigning a device to a room owned by someone else', async () => {
    const otherAuth = { Authorization: `Bearer ${tokenFor(new mongoose.Types.ObjectId().toString())}` };
    const otherRoom = await request(app).post('/api/rooms').set(otherAuth).send({ name: 'Their Room' });

    const res = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Plug', type: 'tasmota_plug', identifier: 'p1', room: otherRoom.body.room._id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/room not found/);
  });

  it('scopes list/get/delete to the owner', async () => {
    const mine = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Mine', type: 'tasmota_plug', identifier: 'mine-1' });

    const otherAuth = { Authorization: `Bearer ${tokenFor(new mongoose.Types.ObjectId().toString())}` };
    await request(app)
      .post('/api/devices')
      .set(otherAuth)
      .send({ name: 'Theirs', type: 'tasmota_plug', identifier: 'theirs-1' });

    const list = await request(app).get('/api/devices').set(auth);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0].name).toBe('Mine');

    const getOther = await request(app)
      .get(`/api/devices/${mine.body.device._id}`)
      .set(otherAuth);
    expect(getOther.status).toBe(404);

    const del = await request(app).delete(`/api/devices/${mine.body.device._id}`).set(otherAuth);
    expect(del.status).toBe(404);
  });

  it('renames a device but rejects changing its type/identifier via PATCH', async () => {
    const created = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Old Name', type: 'tasmota_plug', identifier: 'immutable-1' });

    const patch = await request(app)
      .patch(`/api/devices/${created.body.device._id}`)
      .set(auth)
      .send({ name: 'New Name', type: 'esphome_motion_sensor', identifier: 'hijacked' });

    expect(patch.status).toBe(200);
    expect(patch.body.device.name).toBe('New Name');
    expect(patch.body.device.type).toBe('tasmota_plug'); // unchanged
    expect(patch.body.device.identifier).toBe('immutable-1'); // unchanged
  });
});