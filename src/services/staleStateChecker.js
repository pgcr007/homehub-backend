const Device = require('../models/Device');
const EventLog = require('../models/EventLog');

/**
 * A device that's genuinely offline gets an explicit LWT message on its
 * `.../status` topic (handled in mqttSubscriber.js, flips status -> 'offline').
 * But a device can also just... stop talking, with no LWT ever firing (broker
 * connection quietly dies, device loses power ungracefully, WiFi drops without
 * a clean disconnect). Nothing tells us that happened, so we sweep periodically:
 * any device still marked 'online' whose lastSeen is older than the threshold
 * gets flipped to 'unknown' — deliberately NOT 'offline', because we don't have
 * a positive signal it's off (a contact sensor genuinely reporting 'closed' 5
 * minutes ago is not the same claim as "we don't know its state right now").
 *
 * Devices already 'offline' (explicit LWT) or already 'unknown' are left alone —
 * this only demotes stale 'online' devices, it never promotes anything.
 */

const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function getStaleThresholdMs() {
  const fromEnv = Number(process.env.STALE_THRESHOLD_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STALE_THRESHOLD_MS;
}

/**
 * Runs one sweep. Exported standalone (not just the interval starter) so it's
 * directly unit-testable without waiting on real timers.
 */
async function checkStaleDevices() {
  const thresholdMs = getStaleThresholdMs();
  const cutoff = new Date(Date.now() - thresholdMs);

  const staleDevices = await Device.find({
    status: 'online',
    lastSeen: { $lt: cutoff },
  });

  const { emitDeviceEvent } = require('./socketService');

  for (const device of staleDevices) {
    device.status = 'unknown';
    await device.save();

    await EventLog.create({
      device: device._id,
      household: device.household,
      source: 'mqtt',
      type: 'unknown',
      normalizedState: {},
      rawPayload: null,
    });

    emitDeviceEvent(device.household.toString(), { deviceId: device._id.toString(), status: 'unknown' });
  }

  return staleDevices.length;
}

let intervalHandle = null;

/** Starts the periodic sweep. Safe to call once at server startup. */
function startStaleStateChecker(intervalMs = DEFAULT_CHECK_INTERVAL_MS) {
  if (intervalHandle) {
    return intervalHandle;
  }
  intervalHandle = setInterval(() => {
    checkStaleDevices().catch((err) => {
      console.error('[stale-state] sweep failed:', err.message);
    });
  }, intervalMs);
  // Don't let this timer keep the process alive on its own (helps tests/shutdown exit cleanly).
  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

function stopStaleStateChecker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { checkStaleDevices, startStaleStateChecker, stopStaleStateChecker, getStaleThresholdMs };