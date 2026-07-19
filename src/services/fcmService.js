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
 * Looks up a single user's tokens, sends, and prunes stale tokens in one
 * call. Kept around for /health/fcm-test and anywhere else that genuinely
 * means "push this one specific user."
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

/**
 * Phase 6: the rules engine's `notify` action pushes to every member of a
 * household, not just one user — a property manager and a tenant sharing a
 * unit should both hear about a rule firing in their space. Gathers all
 * member tokens into one multicast send (rather than one send per member)
 * so a household with several members doesn't multiply FCM calls, then
 * prunes stale tokens per-user same as sendToUser.
 */
async function sendToHousehold(householdId, notification) {
  const Household = require('../models/Household');
  const User = require('../models/User');

  const household = await Household.findById(householdId);
  if (!household) return null;

  const memberIds = household.members.map((m) => m.user);
  const users = await User.find({ _id: { $in: memberIds }, fcmTokens: { $exists: true, $ne: [] } });
  if (!users.length) return null;

  const tokenToUser = new Map();
  const allTokens = [];
  for (const user of users) {
    for (const token of user.fcmTokens) {
      tokenToUser.set(token, user._id);
      allTokens.push(token);
    }
  }
  if (!allTokens.length) return null;

  const result = await sendToTokens(allTokens, notification);
  const staleTokens = getStaleTokens(allTokens, result);

  if (staleTokens.length) {
    // Group stale tokens back by the user they belong to so each user's
    // fcmTokens array only gets the tokens that are actually theirs pulled.
    const staleByUser = new Map();
    for (const token of staleTokens) {
      const userId = tokenToUser.get(token)?.toString();
      if (!userId) continue;
      if (!staleByUser.has(userId)) staleByUser.set(userId, []);
      staleByUser.get(userId).push(token);
    }
    await Promise.all(
      Array.from(staleByUser.entries()).map(([userId, tokens]) =>
        User.findByIdAndUpdate(userId, { $pullAll: { fcmTokens: tokens } })
      )
    );
  }

  return result;
}

module.exports = { initFirebase, sendToTokens, getStaleTokens, sendToUser, sendToHousehold };