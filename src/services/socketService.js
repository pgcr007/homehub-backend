const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

/**
 * Phase 3's live-state push layer. The HTTP server in server.js was already
 * created via http.createServer specifically so this could attach without
 * rewiring (see the Phase 2 handoff note).
 *
 * Auth mirrors requireAuth.js: same JWT, same `sub` claim as userId, just
 * carried over Socket.IO's handshake instead of an Authorization header,
 * since there's no per-request header to hook into here.
 *
 * Clients join a room named `owner:{userId}` on connect. Device events are
 * scoped to that room so one tenant's phone never receives another
 * tenant's device state, mirroring the per-owner data scoping used
 * everywhere else in the backend (and standing in for the ACL-level
 * namespacing Phase 6 will enforce at the broker itself).
 */
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

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('missing auth token'));
    }
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`owner:${socket.userId}`);
    console.log(`[socket] client connected for owner ${socket.userId} (${socket.id})`);

    socket.on('disconnect', (reason) => {
      console.log(`[socket] client disconnected (${socket.id}): ${reason}`);
    });
  });

  return io;
}

/**
 * Pushes a normalized device event to every connected client for the given owner.
 * Called from mqttSubscriber.js when a message arrives on
 * `home/{ownerId}/{deviceId}/normalized` — the single convergence point for both
 * webhook-sourced and native-MQTT-sourced device events (see Phase 2/3 notes).
 * Non-throwing and a no-op before initSocket() has run, same defensive style as
 * mqttService's publish functions — a missing/late socket layer shouldn't break
 * the DB-write path that already happened upstream.
 */
function emitDeviceEvent(ownerId, event) {
  if (!io) {
    return;
  }
  io.to(`owner:${ownerId}`).emit('device:event', event);
}

function getIO() {
  return io;
}

module.exports = { initSocket, emitDeviceEvent, getIO };