const http = require('http');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const { initSocket, emitDeviceEvent } = require('../services/socketService');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET);
}

describe('socketService', () => {
  let httpServer;
  let port;

  beforeAll((done) => {
    httpServer = http.createServer();
    initSocket(httpServer);
    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    httpServer.close(done);
  });

  it('rejects a connection with no auth token', (done) => {
    const client = ioClient(`http://localhost:${port}`, { auth: {}, reconnection: false });
    client.on('connect_error', (err) => {
      expect(err.message).toMatch(/missing auth token/);
      client.close();
      done();
    });
    client.on('connect', () => {
      client.close();
      done(new Error('should not have connected without a token'));
    });
  });

  it('rejects a connection with an invalid token', (done) => {
    const client = ioClient(`http://localhost:${port}`, {
      auth: { token: 'not-a-real-token' },
      reconnection: false,
    });
    client.on('connect_error', (err) => {
      expect(err.message).toMatch(/invalid or expired token/);
      client.close();
      done();
    });
    client.on('connect', () => {
      client.close();
      done(new Error('should not have connected with an invalid token'));
    });
  });

  it('accepts a connection with a valid token and delivers device events scoped to that owner', (done) => {
    const ownerId = 'owner-abc';
    const client = ioClient(`http://localhost:${port}`, {
      auth: { token: tokenFor(ownerId) },
      reconnection: false,
    });

    client.on('connect', () => {
      client.on('device:event', (event) => {
        expect(event).toEqual({ deviceId: 'device-1', state: { power: 'on' } });
        client.close();
        done();
      });
      // Give the server a tick to finish the join() before we emit.
      setTimeout(() => {
        emitDeviceEvent(ownerId, { deviceId: 'device-1', state: { power: 'on' } });
      }, 50);
    });

    client.on('connect_error', (err) => {
      client.close();
      done(err);
    });
  });

  it('does not deliver another owner\'s device events', (done) => {
    const client = ioClient(`http://localhost:${port}`, {
      auth: { token: tokenFor('owner-xyz') },
      reconnection: false,
    });

    const received = [];
    client.on('connect', () => {
      client.on('device:event', (event) => received.push(event));
      setTimeout(() => {
        emitDeviceEvent('some-other-owner', { deviceId: 'device-2', state: { power: 'off' } });
        // Give it a moment to (not) arrive, then assert nothing came through.
        setTimeout(() => {
          expect(received).toHaveLength(0);
          client.close();
          done();
        }, 100);
      }, 50);
    });

    client.on('connect_error', (err) => {
      client.close();
      done(err);
    });
  });
});