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
    // 'rule_blocked' is Phase 5's loop-protection record: a rule's trigger
    // matched, but it was reached via a chain that already hit that rule's
    // maxChainDepth, so it was logged and skipped rather than fired.
    type: {
      type: String,
      enum: ['state_change', 'online', 'offline', 'unknown', 'rule_fired', 'rule_blocked'],
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
    // Phase 5 loop-protection/tracing: null/0 for an organic, user- or
    // device-originated event. When a rule action causes a device to report
    // a new state, that resulting event (and any rule it triggers in turn)
    // shares the same chainId with chainDepth incremented by one hop, so a
    // whole A-caused-B-caused-C cascade can be reconstructed from the log.
    chainId: {
      type: String,
      default: null,
    },
    chainDepth: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true, minimize: false }
);

eventLogSchema.index({ owner: 1, createdAt: -1 });
eventLogSchema.index({ device: 1, createdAt: -1 });

module.exports = mongoose.model('EventLog', eventLogSchema);