const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');
const { computeSignature } = require('../services/webhookAuth');
const EventLog = require('../models/EventLog');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'test-webhook-secret';

const app = require('../app');

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET);
}

async function createThermostat(auth) {
  const res = await request(app)
    .post('/api/devices')
    .set(auth)
    .send({ name: 'Thermostat', type: 'webhook_thermostat', identifier: 'thermo-1' });
  return res.body.device;
}

describe('Webhook ingestion API', () => {
  let auth;

  beforeAll(async () => {
  await connectTestDB();
}, 30000); // first run downloads a real mongod binary — can exceed Jest's 5s default

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    auth = { Authorization: `Bearer ${tokenFor(new mongoose.Types.ObjectId().toString())}` };
  });

  it('rejects a request with no signature', async () => {
    const device = await createThermostat(auth);
    const body = JSON.stringify({ temp: 21 });

    const res = await request(app)
      .post(`/api/webhooks/${device._id}`)
      .set('Content-Type', 'application/json')
      .send(body.toString('utf8'))

    expect(res.status).toBe(401);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const device = await createThermostat(auth);
    const body = Buffer.from(JSON.stringify({ temp: 21 }));
    const badSignature = computeSignature('some-other-device-id', body);

    const res = await request(app)
      .post(`/api/webhooks/${device._id}`)
      .set('Content-Type', 'application/json')
      .set('X-HomeHub-Signature', badSignature)
      .send(body.toString('utf8'))

    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed payload, updates state, and logs the event', async () => {
    const device = await createThermostat(auth);
    const body = Buffer.from(JSON.stringify({ temp: 21.5, target: 22, mode: 'heat' }));
    const signature = computeSignature(device._id, body);

    const res = await request(app)
      .post(`/api/webhooks/${device._id}`)
      .set('Content-Type', 'application/json')
      .set('X-HomeHub-Signature', signature)
      .send(body.toString('utf8'))

    expect(res.status).toBe(200);
    expect(res.body.state).toEqual({ temperature: 21.5, targetTemperature: 22, mode: 'heat' });

    const getDevice = await request(app).get(`/api/devices/${device._id}`).set(auth);
    expect(getDevice.body.device.status).toBe('online');
    expect(getDevice.body.device.state.temperature).toBe(21.5);

    const events = await EventLog.find({ device: device._id });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('webhook');
    expect(events[0].normalizedState.mode).toBe('heat');
  });

  it('rejects a payload that fails normalization with 422, not 500', async () => {
    const device = await createThermostat(auth);
    const body = Buffer.from(JSON.stringify({ mode: 'nuke-it' }));
    const signature = computeSignature(device._id, body);

    const res = await request(app)
      .post(`/api/webhooks/${device._id}`)
      .set('Content-Type', 'application/json')
      .set('X-HomeHub-Signature', signature)
      .send(body.toString('utf8'))

    expect(res.status).toBe(422);
  });

  it('rejects a non-webhook-protocol device', async () => {
    const create = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Plug', type: 'tasmota_plug', identifier: 'plug-1' });
    const device = create.body.device;

    const body = Buffer.from(JSON.stringify({ POWER: 'ON' }));
    const signature = computeSignature(device._id, body);

    const res = await request(app)
      .post(`/api/webhooks/${device._id}`)
      .set('Content-Type', 'application/json')
      .set('X-HomeHub-Signature', signature)
      .send(body.toString('utf8'))

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown device id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const body = Buffer.from(JSON.stringify({ temp: 20 }));
    const signature = computeSignature(fakeId, body);

    const res = await request(app)
      .post(`/api/webhooks/${fakeId}`)
      .set('Content-Type', 'application/json')
      .set('X-HomeHub-Signature', signature)
      .send(body.toString('utf8'))

    expect(res.status).toBe(404);
  });
});