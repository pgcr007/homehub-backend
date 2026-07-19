const request = require('supertest');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');
const { createAuthedHousehold } = require('../testUtils/authHelpers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = require('../app');

describe('Room API', () => {
  let auth; // { headers, householdId, userId, ... } for the primary test household

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

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(401);
  });

  it('rejects requests missing the X-Household-Id header', async () => {
    const res = await request(app).get('/api/rooms').set({ Authorization: auth.headers.Authorization });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Household-Id/);
  });

  it('rejects requests with a household the user is not a member of', async () => {
    const otherHousehold = await createAuthedHousehold('Someone Elses Household');
    const res = await request(app)
      .get('/api/rooms')
      .set({ Authorization: auth.headers.Authorization, 'X-Household-Id': otherHousehold.householdId });
    expect(res.status).toBe(404);
  });

  it('creates and lists rooms scoped to the household', async () => {
    const create = await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Living Room' });
    expect(create.status).toBe(201);
    expect(create.body.room.name).toBe('Living Room');

    const otherAuth = await createAuthedHousehold();
    await request(app).post('/api/rooms').set(otherAuth.headers).send({ name: 'Someone Elses Room' });

    const list = await request(app).get('/api/rooms').set(auth.headers);
    expect(list.status).toBe(200);
    expect(list.body.rooms).toHaveLength(1);
    expect(list.body.rooms[0].name).toBe('Living Room');
  });

  it('rejects duplicate room names for the same household', async () => {
    await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Kitchen' });
    const dupe = await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Kitchen' });
    expect(dupe.status).toBe(409);
  });

  it('allows the same room name across two different households', async () => {
    await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Kitchen' });
    const otherAuth = await createAuthedHousehold();
    const res = await request(app).post('/api/rooms').set(otherAuth.headers).send({ name: 'Kitchen' });
    expect(res.status).toBe(201);
  });

  it('renames a room', async () => {
    const create = await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Old Name' });
    const update = await request(app)
      .patch(`/api/rooms/${create.body.room._id}`)
      .set(auth.headers)
      .send({ name: 'New Name' });
    expect(update.status).toBe(200);
    expect(update.body.room.name).toBe('New Name');
  });

  it('unassigns devices when their room is deleted', async () => {
    const room = await request(app).post('/api/rooms').set(auth.headers).send({ name: 'Garage' });
    const device = await request(app)
      .post('/api/devices')
      .set(auth.headers)
      .send({ name: 'Garage Plug', type: 'tasmota_plug', identifier: 'garage-plug-1', room: room.body.room._id });
    expect(device.body.device.room).toBe(room.body.room._id);

    const del = await request(app).delete(`/api/rooms/${room.body.room._id}`).set(auth.headers);
    expect(del.status).toBe(200);

    const getDevice = await request(app).get(`/api/devices/${device.body.device._id}`).set(auth.headers);
    expect(getDevice.body.device.room).toBe(null);
  });
});