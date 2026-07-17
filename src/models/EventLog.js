const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema(
  {
    device: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Device',
      required: true,
    },
    // Denormalized so the activity feed (Phase 4) can query by owner without
    // an extra join/populate on every request.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    source: {
      type: String,
      enum: ['mqtt', 'webhook', 'rule'],
      required: true,
    },
    // 'state_change' covers most events; 'online'/'offline' are Phase 3's
    // LWT/heartbeat handling (explicit broker-detected connect/disconnect);
    // 'unknown' is Phase 3's separate stale-state sweep (lastSeen threshold
    // exceeded with no explicit LWT ever received — a distinct claim from
    // "offline", see staleStateChecker.js); 'rule_fired' is reserved for Phase 5.
    type: {
      type: String,
      enum: ['state_change', 'online', 'offline', 'unknown', 'rule_fired'],
      required: true,
    },
    // The normalized { capability: value } diff that produced this entry —
    // output of eventNormalizer.js, not the raw device payload.
    normalizedState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Raw payload as received, kept for debugging real-device payload-shape
    // surprises per the Phase 3 risk note.
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

eventLogSchema.index({ owner: 1, createdAt: -1 });
eventLogSchema.index({ device: 1, createdAt: -1 });

module.exports = mongoose.model('EventLog', eventLogSchema);