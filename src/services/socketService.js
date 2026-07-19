const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Household = require('../models/Household');

let io = null;

/**
 * Live-state push layer. The HTTP server in server.js was already created
 * via http.createServer specifically so this could attach without rewiring.
 *
 * Auth mirrors requireAuth.js/requireHousehold.js: same JWT (`sub` claim as
 * userId) carried over the handshake instead of an Authorization header,
 * PLUS a householdId (also in the handshake auth payload) that's verified
 * against Household.members the same way requireHousehold does for HTTP
 * requests — a socket connection is scoped to exactly one active household
 * at a time, matching how the Android app shows one unit's dashboard at a
 * time even for a manager who belongs to several.
 *
 * Clients join a room named `household:{householdId}` on connect. Device
 * events are scoped to that room so one household's members never receive
 * another household's device state — this is the app-level analogue of the
 * broker-ACL namespacing that should also be configured on the HiveMQ Cloud
 * side directly (see the Phase 6 MQTT/broker step).
 */
async function verifyHouseholdMembership(userId, householdId) {
  if (!householdId) return false;
  try {
    const household = await Household.findById(householdId);
    return household ? household.isMember(userId) : false;
  } catch {
    return false; // malformed householdId
  }
}

function initSocket(httpServer) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins.length ? allowedOrigins : true,
    },
  });

  io.use(async (socket, next) => {
    const { token, householdId } = socket.handshake.auth || {};
    if (!token) {
      return next(new Error('missing auth token'));
    }
    if (!householdId) {
      return next(new Error('missing householdId'));
    }

    let userId;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      userId = payload.sub;
    } catch {
      return next(new Error('invalid or expired token'));
    }

    const isMember = await verifyHouseholdMembership(userId, householdId);
    if (!isMember) {
      return next(new Error('not a member of that household'));
    }

    socket.userId = userId;
    socket.householdId = householdId;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`household:${socket.householdId}`);
    console.log(`[socket] client connected for household ${socket.householdId} (${socket.id})`);

    // Lets a manager app switch which unit's live feed it's watching without
    // tearing down and re-establishing the whole socket connection. Still
    // re-verifies membership — a socket authenticated for household A can't
    // just ask to join household B it isn't part of.
    socket.on('switchHousehold', async (newHouseholdId, ack) => {
      const isMember = await verifyHouseholdMembership(socket.userId, newHouseholdId);
      if (!isMember) {
        if (typeof ack === 'function') ack({ error: 'not a member of that household' });
        return;
      }
      socket.leave(`household:${socket.householdId}`);
      socket.householdId = newHouseholdId;
      socket.join(`household:${socket.householdId}`);
      if (typeof ack === 'function') ack({ status: 'ok', householdId: newHouseholdId });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] client disconnected (${socket.id}): ${reason}`);
    });
  });

  return io;
}

/**
 * Pushes a normalized device event to every connected client for the given
 * household. Called from mqttSubscriber.js when a message arrives on
 * `home/{householdId}/{deviceId}/normalized` — the single convergence point
 * for both webhook-sourced and native-MQTT-sourced device events. Non-throwing
 * and a no-op before initSocket() has run, same defensive style as
 * mqttService's publish functions — a missing/late socket layer shouldn't
 * break the DB-write path that already happened upstream.
 */
function emitDeviceEvent(householdId, event) {
  if (!io) {
    return;
  }
  io.to(`household:${householdId}`).emit('device:event', event);
}

function getIO() {
  return io;
}

module.exports = { initSocket, emitDeviceEvent, getIO };