const mqtt = require('mqtt');

let client = null;

/**
 * Phase 1 proved the broker works end to end. Phase 3 subscribes to the real
 * device-topic wildcards and dispatches every message to mqttSubscriber.js -
 * the single place that turns raw MQTT traffic into DB writes, EventLogs, and
 * (for webhook-sourced events already republished here) Socket.IO pushes.
 *
 * Three wildcard subscriptions cover everything from docs/DEVICE_SHORTLIST.md:
 *   home/+/+/state       - raw device state (Tasmota/ESPHome payloads)
 *   home/+/+/status      - Last Will and Testament / availability
 *   home/+/+/normalized  - our own republished events, fanned out to Socket.IO
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
    const topics = ['home/+/+/state', 'home/+/+/status', 'home/+/+/normalized'];
    client.subscribe(topics, (err) => {
      if (err) console.error('[mqtt] subscribe error:', err.message);
      else console.log(`[mqtt] subscribed to ${topics.join(', ')}`);
    });
  });

  client.on('message', (topic, payload) => {
    // Lazy require to sidestep the mqttService <-> mqttSubscriber circular
    // import (mqttSubscriber calls back into mqttService's publishNormalizedEvent).
    const { handleIncomingMessage } = require('./mqttSubscriber');
    handleIncomingMessage(topic, payload).catch((err) => {
      console.error(`[mqtt] error handling message on ${topic}:`, err.message);
    });
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

/**
 * Republishes a normalized event onto the internal MQTT bus so that anything
 * subscribing to `home/{ownerId}/{deviceId}/normalized` (Socket.IO bridge in
 * Phase 3, rule engine in Phase 5) sees webhook-sourced events the same way
 * it sees native-MQTT ones. Best-effort and non-throwing, like the rest of
 * this service's Phase 1 connections — a webhook event should still be
 * accepted and stored even if the broker is unreachable.
 */
function publishNormalizedEvent(device, normalizedState) {
  if (!client || !client.connected) {
    console.warn('[mqtt] not connected, skipping republish of normalized event');
    return;
  }
  const topic = `home/${device.household}/${device._id}/normalized`;
  client.publish(topic, JSON.stringify(normalizedState), { retain: true });
}

function publishCommand(device, command) {
  if (!client || !client.connected) {
    throw new Error('MQTT client is not connected, cannot send command');
  }
  const topic = `home/${device.household}/${device.identifier}/cmd`;
  client.publish(topic, JSON.stringify(command));
  return topic;
}


module.exports = { connectMQTT, getMQTTClient, publishTest, publishNormalizedEvent, publishCommand };
