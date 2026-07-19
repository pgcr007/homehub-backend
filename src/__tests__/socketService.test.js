const http = require('http');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');
const { connectTestDB, clearTestDB, disconnectTestDB } = require('../testUtils/testDb');
const { createAuthedHousehold, tokenFor } = require('../testUtils/authHelpers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { initSocket, emitDeviceEvent } = require('../services/socketService');
const Household = require('../models/Household');

describe('socketService', () => {
  let httpServer;
  let port;

  beforeAll(async () => {
    await connectTestDB();
    httpServer = http.createServer();
    initSocket(httpServer);
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  }, 30000); // first run downloads a real mongod binary — can exceed Jest's 5s default

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
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

  it('rejects a connection with a token but no householdId', async () => {
    const auth = await createAuthedHousehold();
    await new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        auth: { token: auth.token },
        reconnection: false,
      });
      client.on('connect_error', (err) => {
        expect(err.message).toMatch(/missing householdId/);
        client.close();
        resolve();
      });
      client.on('connect', () => {
        client.close();
        reject(new Error('should not have connected without a householdId'));
      });
    });
  });

  it('rejects a connection with an invalid token', (done) => {
    const client = ioClient(`http://localhost:${port}`, {
      auth: { token: 'not-a-real-token', householdId: 'irrelevant' },
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

  it('rejects a connection when the user is not a member of the given household', async () => {
    const auth = await createAuthedHousehold();
    const otherHousehold = await Household.create({
      name: 'Someone Elses Household',
      members: [{ user: new mongoose.Types.ObjectId(), role: 'owner' }],
    });

    await new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        auth: { token: auth.token, householdId: otherHousehold._id.toString() },
        reconnection: false,
      });
      client.on('connect_error', (err) => {
        expect(err.message).toMatch(/not a member of that household/);
        client.close();
        resolve();
      });
      client.on('connect', () => {
        client.close();
        reject(new Error('should not have connected to a household the user is not a member of'));
      });
    });
  });

  it('accepts a connection with a valid token+householdId and delivers device events scoped to that household', async () => {
    const auth = await createAuthedHousehold();

    await new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        auth: { token: auth.token, householdId: auth.householdId },
        reconnection: false,
      });

      client.on('connect', () => {
        client.on('device:event', (event) => {
          expect(event).toEqual({ deviceId: 'device-1', state: { power: 'on' } });
          client.close();
          resolve();
        });
        // Give the server a tick to finish the join() before we emit.
        setTimeout(() => {
          emitDeviceEvent(auth.householdId, { deviceId: 'device-1', state: { power: 'on' } });
        }, 50);
      });

      client.on('connect_error', (err) => {
        client.close();
        reject(err);
      });
    });
  });

  it("does not deliver another household's device events", async () => {
    const auth = await createAuthedHousehold();
    const otherAuth = await createAuthedHousehold();

    await new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        auth: { token: auth.token, householdId: auth.householdId },
        reconnection: false,
      });

      const received = [];
      client.on('connect', () => {
        client.on('device:event', (event) => received.push(event));
        setTimeout(() => {
          emitDeviceEvent(otherAuth.householdId, { deviceId: 'device-2', state: { power: 'off' } });
          // Give it a moment to (not) arrive, then assert nothing came through.
          setTimeout(() => {
            expect(received).toHaveLength(0);
            client.close();
            resolve();
          }, 100);
        }, 50);
      });

      client.on('connect_error', (err) => {
        client.close();
        reject(err);
      });
    });
  });

  it('switchHousehold moves a connected socket to a different household it belongs to', async () => {
    const auth = await createAuthedHousehold();
    // Add the same user to a second household so switching is legitimate.
    const secondHousehold = await Household.create({
      name: 'Second Unit',
      members: [
        { user: new mongoose.Types.ObjectId(), role: 'owner' },
        { user: auth.userId, role: 'manager' },
      ],
    });

    await new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        auth: { token: auth.token, householdId: auth.householdId },
        reconnection: false,
      });

      client.on('connect', () => {
        client.emit('switchHousehold', secondHousehold._id.toString(), (ack) => {
          expect(ack.status).toBe('ok');

          client.on('device:event', (event) => {
            expect(event).toEqual({ deviceId: 'device-3', state: { power: 'on' } });
            client.close();
            resolve();
          });

          setTimeout(() => {
            emitDeviceEvent(secondHousehold._id.toString(), { deviceId: 'device-3', state: { power: 'on' } });
          }, 50);
        });
      });

      client.on('connect_error', (err) => {
        client.close();
        reject(err);
      });
    });
  });
});