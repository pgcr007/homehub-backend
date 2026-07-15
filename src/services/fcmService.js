const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let initialized = false;
let messaging = null;

function initFirebase() {
  if (initialized) return;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT_B64 not set — FCM disabled');
    return;
  }

  let serviceAccount;
  try {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(json);
  } catch (err) {
    console.warn('[fcm] failed to decode/parse FIREBASE_SERVICE_ACCOUNT_B64 — FCM disabled', err.message);
    return;
  }

  const app = initializeApp({
    credential: cert(serviceAccount),
  });

  messaging = getMessaging(app);
  initialized = true;
  console.log('[fcm] Firebase initialized');
}

async function sendToTokens(tokens, notification, data = {}) {
  if (!initialized) {
    console.warn('[fcm] not initialized, skipping send');
    return null;
  }
  if (!tokens || tokens.length === 0) return null;

  return messaging.sendEachForMulticast({
    tokens,
    notification,
    data,
  });
}

function getStaleTokens(tokens, result) {
  if (!result || !result.responses) return [];
  return result.responses
    .map((resp, i) => ({ resp, token: tokens[i] }))
    .filter(
      ({ resp }) =>
        !resp.success &&
        (resp.error?.code === 'messaging/registration-token-not-registered' ||
          resp.error?.code === 'messaging/invalid-registration-token')
    )
    .map(({ token }) => token);
}

module.exports = { initFirebase, sendToTokens, getStaleTokens };