const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = require('../app');

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET);
}

describe('Room API', () => {
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

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(401);
  });

  it('creates and lists rooms scoped to the owner', async () => {
    const create = await request(app).post('/api/rooms').set(auth).send({ name: 'Living Room' });
    expect(create.status).toBe(201);
    expect(create.body.room.name).toBe('Living Room');

    const otherAuth = { Authorization: `Bearer ${tokenFor(new mongoose.Types.ObjectId().toString())}` };
    await request(app).post('/api/rooms').set(otherAuth).send({ name: 'Someone Elses Room' });

    const list = await request(app).get('/api/rooms').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.rooms).toHaveLength(1);
    expect(list.body.rooms[0].name).toBe('Living Room');
  });

  it('rejects duplicate room names for the same owner', async () => {
    await request(app).post('/api/rooms').set(auth).send({ name: 'Kitchen' });
    const dupe = await request(app).post('/api/rooms').set(auth).send({ name: 'Kitchen' });
    expect(dupe.status).toBe(409);
  });

  it('renames a room', async () => {
    const create = await request(app).post('/api/rooms').set(auth).send({ name: 'Old Name' });
    const update = await request(app)
      .patch(`/api/rooms/${create.body.room._id}`)
      .set(auth)
      .send({ name: 'New Name' });
    expect(update.status).toBe(200);
    expect(update.body.room.name).toBe('New Name');
  });

  it('unassigns devices when their room is deleted', async () => {
    const room = await request(app).post('/api/rooms').set(auth).send({ name: 'Garage' });
    const device = await request(app)
      .post('/api/devices')
      .set(auth)
      .send({ name: 'Garage Plug', type: 'tasmota_plug', identifier: 'garage-plug-1', room: room.body.room._id });
    expect(device.body.device.room).toBe(room.body.room._id);

    const del = await request(app).delete(`/api/rooms/${room.body.room._id}`).set(auth);
    expect(del.status).toBe(200);

    const getDevice = await request(app).get(`/api/devices/${device.body.device._id}`).set(auth);
    expect(getDevice.body.device.room).toBe(null);
  });
});