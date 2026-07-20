const request = require('supertest');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');
const { createAuthedHousehold } = require('../testUtils/authHelpers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = require('../app');

describe('Household broker-info API (Phase 6 Step 3)', () => {
  let auth;

  beforeAll(async () => {
    await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    auth = await createAuthedHousehold();
  });

  describe('GET /current/broker-info', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/households/current/broker-info');
      expect(res.status).toBe(401);
    });

    it('returns the topic prefix, filled-in topic shapes, and unconfigured ACL status by default', async () => {
      const res = await request(app)
        .get('/api/households/current/broker-info')
        .set(auth.headers);

      expect(res.status).toBe(200);
      expect(res.body.householdId).toBe(auth.householdId);
      expect(res.body.topicPrefix).toBe(`home/${auth.householdId}`);
      expect(res.body.topics.state).toBe(`home/${auth.householdId}/{identifier}/state`);
      expect(res.body.topics.status).toBe(`home/${auth.householdId}/{identifier}/status`);
      expect(res.body.topics.normalized).toBe(`home/${auth.householdId}/{deviceId}/normalized`);
      expect(res.body.topics.cmd).toBe(`home/${auth.householdId}/{identifier}/cmd`);
      expect(res.body.mqttAcl).toEqual({ configured: false, brokerUsername: null, configuredAt: null });
      expect(res.body.setupInstructions).toMatch(new RegExp(`home/${auth.householdId}/#`));
    });

    it('is accessible to a plain member, not just manager+', async () => {
      // createAuthedHousehold's user is an 'owner'; this just asserts the
      // route has no requireRole gate at all (any member context works).
      const res = await request(app)
        .get('/api/households/current/broker-info')
        .set(auth.headers);
      expect(res.status).toBe(200);
    });

    it('rejects a household the caller is not a member of', async () => {
      const other = await createAuthedHousehold('Someone Elses Household');
      const res = await request(app)
        .get('/api/households/current/broker-info')
        .set({ Authorization: auth.headers.Authorization, 'X-Household-Id': other.householdId });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /current/broker-info/confirm', () => {
    it('requires brokerUsername', async () => {
      const res = await request(app)
        .post('/api/households/current/broker-info/confirm')
        .set(auth.headers)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/brokerUsername/);
    });

    it('records the confirmation and it shows up on a subsequent GET', async () => {
      const confirmRes = await request(app)
        .post('/api/households/current/broker-info/confirm')
        .set(auth.headers)
        .send({ brokerUsername: 'household-abc123' });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.mqttAcl.configured).toBe(true);
      expect(confirmRes.body.mqttAcl.brokerUsername).toBe('household-abc123');
      expect(confirmRes.body.mqttAcl.configuredAt).toBeTruthy();

      const getRes = await request(app)
        .get('/api/households/current/broker-info')
        .set(auth.headers);
      expect(getRes.body.mqttAcl.configured).toBe(true);
      expect(getRes.body.mqttAcl.brokerUsername).toBe('household-abc123');
    });

    it('is manager+ only — a plain member is rejected', async () => {
      const Household = require('../models/Household');
      const mongoose = require('mongoose');
      const jwt = require('jsonwebtoken');

      const memberUserId = new mongoose.Types.ObjectId().toString();
      const household = await Household.findById(auth.householdId);
      household.members.push({ user: memberUserId, role: 'member' });
      await household.save();

      const memberToken = jwt.sign({ sub: memberUserId }, process.env.JWT_SECRET);
      const res = await request(app)
        .post('/api/households/current/broker-info/confirm')
        .set({ Authorization: `Bearer ${memberToken}`, 'X-Household-Id': auth.householdId })
        .send({ brokerUsername: 'household-abc123' });

      expect(res.status).toBe(403);
    });
  });
});