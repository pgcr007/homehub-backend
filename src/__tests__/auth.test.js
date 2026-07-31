const request = require('supertest');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = require('../app');

describe('Auth API', () => {
  beforeAll(async () => {
    await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  // createAuthedHousehold (used elsewhere) signs a token for a synthetic
  // ObjectId with no backing User document — fine for household-scoped
  // routes that only care about the id, but /me and /password both load
  // the actual User doc, so these need a real registered account.
  async function registerUser() {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'profile-test@homehub.dev', password: 'testpass123', name: 'Profile Tester' });
    return {
      token: res.body.token,
      headers: { Authorization: `Bearer ${res.body.token}` },
    };
  }

  it('GET /me returns the signed-in user without a password hash', async () => {
    const auth = await registerUser();
    const res = await request(app).get('/api/auth/me').set(auth.headers);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('profile-test@homehub.dev');
    expect(res.body.user.name).toBe('Profile Tester');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.createdAt).toBeDefined();
  });

  it('changes the password when the current password is correct', async () => {
    const auth = await registerUser();

    const change = await request(app)
      .patch('/api/auth/password')
      .set(auth.headers)
      .send({ currentPassword: 'testpass123', newPassword: 'newpass456' });
    expect(change.status).toBe(200);

    // Old password should no longer work, new one should.
    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'profile-test@homehub.dev', password: 'testpass123' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'profile-test@homehub.dev', password: 'newpass456' });
    expect(newLogin.status).toBe(200);
  });

  it('rejects a password change with the wrong current password', async () => {
    const auth = await registerUser();
    const res = await request(app)
      .patch('/api/auth/password')
      .set(auth.headers)
      .send({ currentPassword: 'wrongpassword', newPassword: 'newpass456' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/current password is incorrect/);
  });

  it('rejects a new password under 8 characters', async () => {
    const auth = await registerUser();
    const res = await request(app)
      .patch('/api/auth/password')
      .set(auth.headers)
      .send({ currentPassword: 'testpass123', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/);
  });
});