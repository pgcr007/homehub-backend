require('dotenv').config();
const mqtt = require('mqtt');

const OWNER_ID = process.argv[2];
const IDENTIFIER = process.argv[3];
const TOPIC_SUFFIX = process.argv[4];
const PAYLOAD = process.argv[5];

if (!OWNER_ID || !IDENTIFIER || !TOPIC_SUFFIX || !PAYLOAD) {
  console.error('Usage: node scripts/test-mqtt-publish.js <ownerId> <identifier> <state|status> <payload>');
  process.exit(1);
}

const client = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
});

client.on('connect', () => {
  const topic = `home/${OWNER_ID}/${IDENTIFIER}/${TOPIC_SUFFIX}`;
  console.log(`Publishing to: ${topic}`);
  console.log(`Payload: ${PAYLOAD}`);
  client.publish(topic, PAYLOAD, { qos: 1 }, (err) => {
    if (err) console.error('Publish failed:', err.message);
    else console.log('Published successfully.');
    client.end();
  });
});

client.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});