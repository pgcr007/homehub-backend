const Device = require('../models/Device');

/**
 * This is the single place raw device payloads become HomeHub's internal
 * event shape. Both the MQTT subscriber (Phase 3) and the webhook ingestion
 * endpoint (Phase 2, below) call `normalizeEvent()` so the rest of the system
 * — state storage, the activity feed, and eventually the rules engine — only
 * ever deals with normalized events, never vendor-specific payload shapes.
 *
 * Each raw→normalized mapping corresponds 1:1 with a row in
 * docs/DEVICE_SHORTLIST.md. Adding a device type means adding a branch here
 * AND a row there — the two must stay in sync.
 */

function normalizeTasmotaPlug(raw) {
  if (typeof raw.POWER !== 'string') {
    throw new Error("tasmota_plug payload missing string 'POWER' field");
  }
  return { power: raw.POWER.toUpperCase() === 'ON' ? 'on' : 'off' };
}

function normalizeTasmotaBulb(raw) {
  const state = normalizeTasmotaPlug(raw); // same POWER field
  if (raw.Dimmer !== undefined) {
    const brightness = Number(raw.Dimmer);
    if (Number.isNaN(brightness) || brightness < 0 || brightness > 100) {
      throw new Error("tasmota_bulb 'Dimmer' must be a number between 0 and 100");
    }
    state.brightness = brightness;
  }
  return state;
}

function normalizeContactSensor(raw) {
  if (typeof raw.contact !== 'string') {
    throw new Error("esphome_contact_sensor payload missing string 'contact' field");
  }
  return { contact: raw.contact.toUpperCase() === 'OPEN' ? 'open' : 'closed' };
}

function normalizeMotionSensor(raw) {
  if (typeof raw.motion !== 'string') {
    throw new Error("esphome_motion_sensor payload missing string 'motion' field");
  }
  return { motion: raw.motion.toUpperCase() === 'DETECTED' ? 'detected' : 'clear' };
}

function normalizeWebhookThermostat(raw) {
  const state = {};
  if (raw.temp !== undefined) {
    const temperature = Number(raw.temp);
    if (Number.isNaN(temperature)) throw new Error("webhook_thermostat 'temp' must be a number");
    state.temperature = temperature;
  }
  if (raw.target !== undefined) {
    const target = Number(raw.target);
    if (Number.isNaN(target)) throw new Error("webhook_thermostat 'target' must be a number");
    state.targetTemperature = target;
  }
  if (raw.mode !== undefined) {
    if (!['heat', 'cool', 'off'].includes(raw.mode)) {
      throw new Error("webhook_thermostat 'mode' must be one of heat|cool|off");
    }
    state.mode = raw.mode;
  }
  if (Object.keys(state).length === 0) {
    throw new Error('webhook_thermostat payload had none of temp/target/mode');
  }
  return state;
}

const NORMALIZERS = {
  tasmota_plug: normalizeTasmotaPlug,
  tasmota_bulb: normalizeTasmotaBulb,
  esphome_contact_sensor: normalizeContactSensor,
  esphome_motion_sensor: normalizeMotionSensor,
  webhook_thermostat: normalizeWebhookThermostat,
};

/**
 * @param {object} device - a Device document (must have `type` and `capabilities`)
 * @param {object} rawPayload - the raw, parsed JSON payload from MQTT or webhook
 * @returns {{ normalizedState: object }}
 * @throws {Error} if the device type is unsupported or the payload doesn't match its shape
 */
function normalizeEvent(device, rawPayload) {
  if (!device || !device.type) {
    throw new Error('normalizeEvent requires a device with a type');
  }
  const normalizer = NORMALIZERS[device.type];
  if (!normalizer) {
    throw new Error(`no normalizer registered for device type '${device.type}'`);
  }
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new Error('rawPayload must be a JSON object');
  }

  const normalizedState = normalizer(rawPayload);

  // Defense in depth: never let a normalized event report a capability the
  // device's type doesn't declare, even if a mapping function above has a bug.
  const allowedCapabilities = Device.DEVICE_TYPES[device.type].capabilities;
  for (const key of Object.keys(normalizedState)) {
    if (!allowedCapabilities.includes(key)) {
      throw new Error(`normalizer produced unexpected capability '${key}' for type '${device.type}'`);
    }
  }

  return { normalizedState };
}

module.exports = { normalizeEvent, NORMALIZERS };