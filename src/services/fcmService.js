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

/**
 * Looks up a user's tokens, sends, and prunes stale tokens in one call —
 * the exact sequence app.js's /health/fcm-test route already does by hand.
 * Added for Phase 5's rule engine `notify` action, but generic enough for
 * any future caller that just wants "push this user a notification."
 */
async function sendToUser(userId, notification) {
  const User = require('../models/User');
  const user = await User.findById(userId);
  if (!user || !user.fcmTokens?.length) return null;

  const result = await sendToTokens(user.fcmTokens, notification);

  const staleTokens = getStaleTokens(user.fcmTokens, result);
  if (staleTokens.length) {
    await User.findByIdAndUpdate(user._id, { $pullAll: { fcmTokens: staleTokens } });
  }

  return result;
}

module.exports = { initFirebase, sendToTokens, getStaleTokens, sendToUser };