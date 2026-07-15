const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let initialized = false;
let messaging = null;

function initFirebase() {
  if (initialized) return;

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    console.warn('[fcm] Firebase env vars not set — FCM disabled');
    return;
  }

  const app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
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

module.exports = { initFirebase, sendToTokens };