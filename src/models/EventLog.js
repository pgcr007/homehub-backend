const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema(
  {
    device: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Device',
      required: true,
    },
    // Phase 6: denormalized household ref (was owner) so the activity feed
    // can query by household without an extra join/populate on every request.
    household: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Household',
      required: true,
    },
    source: {
      type: String,
      enum: ['mqtt', 'webhook', 'rule'],
      required: true,
    },
    // 'state_change' covers most events; 'online'/'offline' are LWT/heartbeat
    // handling (explicit broker-detected connect/disconnect); 'unknown' is
    // the stale-state sweep (lastSeen threshold exceeded with no explicit LWT
    // ever received); 'rule_fired'/'rule_blocked' are the rules engine's
    // execution and loop-protection records.
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
    // surprises.
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Loop-protection/tracing: null/0 for an organic, user- or
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

eventLogSchema.index({ household: 1, createdAt: -1 });
eventLogSchema.index({ device: 1, createdAt: -1 });

module.exports = mongoose.model('EventLog', eventLogSchema);