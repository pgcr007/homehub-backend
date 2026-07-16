const mqtt = require('mqtt');

let client = null;

/**
 * Phase 1 goal: prove the broker works end to end.
 * Phase 3 will replace the bare console.log in the message handler with
 * real state-write + normalization + republish logic.
 */
function connectMQTT() {
  const url = process.env.MQTT_BROKER_URL;
  if (!url) {
    console.warn('[mqtt] MQTT_BROKER_URL not set, skipping MQTT connection');
    return null;
  }

  client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
  });

  client.on('connect', () => {
    console.log('[mqtt] connected to broker');
    // Phase 1 sanity check topic — safe to remove once real device topics exist
    client.subscribe('homehub/test/#', (err) => {
      if (err) console.error('[mqtt] subscribe error:', err.message);
      else console.log('[mqtt] subscribed to homehub/test/#');
    });
  });

  client.on('message', (topic, payload) => {
    console.log(`[mqtt] message on ${topic}: ${payload.toString()}`);
  });

  client.on('error', (err) => {
    console.error('[mqtt] connection error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[mqtt] reconnecting...');
  });

  return client;
}

function getMQTTClient() {
  return client;
}

/** Quick helper for the Phase 1 "prove pub/sub works" test. */
function publishTest(message = 'hello from homehub-backend') {
  if (!client || !client.connected) {
    throw new Error('MQTT client is not connected yet');
  }
  client.publish('homehub/test/ping', message);
}

function publishNormalizedEvent(device, normalizedState) {
  if (!client || !client.connected) {
    console.warn('[mqtt] not connected, skipping republish of normalized event');
    return;
  }
  const topic = `home/${device.owner}/${device._id}/normalized`;
  client.publish(topic, JSON.stringify(normalizedState), { retain: true });
}

module.exports = { connectMQTT, getMQTTClient, publishTest, publishNormalizedEvent };
