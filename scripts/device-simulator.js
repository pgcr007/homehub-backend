require('dotenv').config();
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

/**
 * MQTT device simulator (post-Phase 7, ahead of Phase 8 QA).
 *
 * Motivated directly by a manual-test session: bulk device actions
 * verified fine end-to-end via PowerShell (command published, correct
 * topic, correct payload), but the Android app kept showing devices as
 * "still on" / status "Unknown" — because there was no physical device or
 * simulator on the other end of the MQTT topic to ever publish a `state`
 * update back. Confirming that took manually publishing a raw message via
 * the HiveMQ web console, which only worked once the raw payload matched
 * the exact per-device-type shape normalizeEvent expects (e.g. Tasmota's
 * `{"POWER":"OFF"}`, not `{"power":"off"}`) — easy to get wrong by hand,
 * repeatedly, during QA.
 *
 * This script plays the part of one or more real devices for exactly
 * that: it subscribes to each configured device's `cmd` topic, tracks an
 * in-memory state per device, and — when the backend/app sends a command —
 * republishes the resulting state back in the correct vendor-specific
 * shape, going through the *same* normalizeEvent() code path a real
 * Tasmota/ESPHome device's own message would.
 *
 * Usage:
 *   1. Copy scripts/simulator.config.example.json to
 *      scripts/simulator.config.json and fill in real household id +
 *      device identifiers (from GET /api/devices) for the devices you
 *      want to simulate. This file is gitignored — it's local test data,
 *      not something to commit (same reasoning as .env).
 *   2. npm run simulate
 *   3. Toggle devices from the Android app or via the bulk-command
 *      endpoint — this script logs every command it receives and every
 *      state update it publishes back.
 *   4. Ctrl+C to stop; each simulated device publishes an "Offline"
 *      status on the way out, same as a real device's MQTT Last Will
 *      would on an ungraceful disconnect (this is a graceful one, so it's
 *      published explicitly rather than relying on the broker's LWT).
 */

const CONFIG_PATH = path.join(__dirname, 'simulator.config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `[simulator] ${CONFIG_PATH} not found.\n` +
      `Copy scripts/simulator.config.example.json to scripts/simulator.config.json ` +
      `and fill in your household id + device identifiers first.`
    );
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    console.error('[simulator] simulator.config.json must have a non-empty "devices" array');
    process.exit(1);
  }
  return config;
}

// Mirrors eventNormalizer.js's per-type expectations, in reverse: given the
// simulator's own in-memory state (already in HomeHub's normalized shape —
// power: "on"/"off", brightness: 0-100, etc.), produce the raw vendor
// payload a real device of this type would actually publish.
function toRawStatePayload(type, state) {
  switch (type) {
    case 'tasmota_plug':
      return { POWER: state.power === 'on' ? 'ON' : 'OFF' };
    case 'tasmota_bulb': {
      const payload = { POWER: state.power === 'on' ? 'ON' : 'OFF' };
      if (state.brightness !== undefined) payload.Dimmer = state.brightness;
      return payload;
    }
    case 'esphome_contact_sensor':
      return { contact: state.contact === 'open' ? 'OPEN' : 'CLOSED' };
    case 'esphome_motion_sensor':
      return { motion: state.motion === 'detected' ? 'DETECTED' : 'CLEAR' };
    default:
      throw new Error(`simulator has no raw-payload mapping for device type "${type}"`);
  }
}

// The reverse direction: a command arriving on .../cmd is already in
// HomeHub's normalized shape (that's what deviceController.sendCommand /
// bulkCommand publish) — e.g. {"power":"off"} or {"brightness":60} — so
// this just merges it into the simulator's tracked state directly, no
// translation needed. Only tasmota_plug/tasmota_bulb realistically accept
// commands (sensors are read-only in real life); a command aimed at a
// sensor type is logged and ignored rather than faked.
function applyCommand(type, state, command) {
  if (type !== 'tasmota_plug' && type !== 'tasmota_bulb') {
    console.warn(`[simulator] ignoring command for read-only sensor type "${type}":`, command);
    return state;
  }
  return { ...state, ...command };
}

function defaultStateFor(type) {
  switch (type) {
    case 'tasmota_plug':
      return { power: 'off' };
    case 'tasmota_bulb':
      return { power: 'off', brightness: 50 };
    case 'esphome_contact_sensor':
      return { contact: 'closed' };
    case 'esphome_motion_sensor':
      return { motion: 'clear' };
    default:
      throw new Error(`simulator has no default state for device type "${type}"`);
  }
}

function main() {
  const config = loadConfig();
  const url = process.env.MQTT_BROKER_URL;
  if (!url) {
    console.error('[simulator] MQTT_BROKER_URL is not set — check your .env file (same one the backend uses)');
    process.exit(1);
  }

  const client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  });

  // householdId/identifier -> { type, state }
  const devices = new Map();
  for (const d of config.devices) {
    devices.set(`${d.householdId}/${d.identifier}`, { type: d.type, state: defaultStateFor(d.type) });
  }

  function publishState(householdId, identifier) {
    const key = `${householdId}/${identifier}`;
    const { type, state } = devices.get(key);
    const topic = `home/${householdId}/${identifier}/state`;
    const raw = toRawStatePayload(type, state);
    client.publish(topic, JSON.stringify(raw));
    console.log(`[simulator] -> ${topic}`, raw);
  }

  client.on('connect', () => {
    console.log(`[simulator] connected, simulating ${devices.size} device(s)`);

    for (const d of config.devices) {
      const cmdTopic = `home/${d.householdId}/${d.identifier}/cmd`;
      const statusTopic = `home/${d.householdId}/${d.identifier}/status`;
      client.subscribe(cmdTopic, (err) => {
        if (err) console.error(`[simulator] failed to subscribe to ${cmdTopic}:`, err.message);
      });
      client.publish(statusTopic, 'Online');
      publishState(d.householdId, d.identifier);
    }
  });

  client.on('message', (topic, payloadBuffer) => {
    const match = topic.match(/^home\/([^/]+)\/([^/]+)\/cmd$/);
    if (!match) return;
    const [, householdId, identifier] = match;
    const key = `${householdId}/${identifier}`;
    const entry = devices.get(key);
    if (!entry) return; // cmd for a device this instance isn't simulating

    let command;
    try {
      command = JSON.parse(payloadBuffer.toString('utf8'));
    } catch {
      console.warn(`[simulator] ignoring malformed JSON command on ${topic}`);
      return;
    }

    console.log(`[simulator] <- ${topic}`, command);
    entry.state = applyCommand(entry.type, entry.state, command);
    publishState(householdId, identifier);
  });

  client.on('error', (err) => {
    console.error('[simulator] connection error:', err.message);
  });

  function shutdown() {
    console.log('\n[simulator] shutting down, publishing Offline status for all devices...');
    for (const d of config.devices) {
      client.publish(`home/${d.householdId}/${d.identifier}/status`, 'Offline');
    }
    setTimeout(() => {
      client.end();
      process.exit(0);
    }, 500); // give the Offline publishes a moment to actually flush before disconnecting
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();