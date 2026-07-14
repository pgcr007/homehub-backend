const request = require('supertest');
const app = require('../app');

describe('GET /health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});