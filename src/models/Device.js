const mongoose = require('mongoose');

// Locked shortlist — see docs/DEVICE_SHORTLIST.md. Each entry records its
// integration protocol and the capability keys it's allowed to report/accept,
// so both the normalization layer and the (future) rule builder can validate
// against a single source of truth instead of duplicating this knowledge.
const DEVICE_TYPES = {
  tasmota_plug: { protocol: 'mqtt', capabilities: ['power'] },
  tasmota_bulb: { protocol: 'mqtt', capabilities: ['power', 'brightness'] },
  esphome_contact_sensor: { protocol: 'mqtt', capabilities: ['contact'] },
  esphome_motion_sensor: { protocol: 'mqtt', capabilities: ['motion'] },
  webhook_thermostat: {
    protocol: 'webhook',
    capabilities: ['temperature', 'targetTemperature', 'mode'],
  },
};

const DEVICE_TYPE_NAMES = Object.keys(DEVICE_TYPES);

const deviceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      default: null,
    },
    type: {
      type: String,
      enum: DEVICE_TYPE_NAMES,
      required: true,
    },
    // Denormalized from DEVICE_TYPES[type].protocol at write time so queries
    // like "all MQTT devices" don't need to know the type→protocol mapping.
    protocol: {
      type: String,
      enum: ['mqtt', 'webhook'],
      required: true,
    },
    // MQTT devices: the {deviceId} segment of home/{householdId}/{deviceId}/...
    // Webhook devices: the {deviceId} segment of /api/webhooks/:deviceId.
    // Either way, this is what's used to derive/verify that device's signing
    // secret and to route inbound events to the right Device doc.
    identifier: {
      type: String,
      required: true,
      trim: true,
    },
    capabilities: {
      type: [String],
      default: function () {
        return DEVICE_TYPES[this.type]?.capabilities || [];
      },
    },
    // Free-form last-known-state bag, keyed by capability (e.g. { power: 'on',
    // brightness: 80 }). Phase 3 will keep this current from the MQTT
    // subscriber; the webhook path (built now) already keeps it current for
    // webhook-protocol devices.
    state: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['online', 'offline', 'unknown'],
      default: 'unknown',
    },
    lastSeen: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// A given owner can't register the same MQTT topic / webhook path twice.
deviceSchema.index({ owner: 1, identifier: 1 }, { unique: true });

deviceSchema.statics.DEVICE_TYPES = DEVICE_TYPES;
deviceSchema.statics.DEVICE_TYPE_NAMES = DEVICE_TYPE_NAMES;

module.exports = mongoose.model('Device', deviceSchema);