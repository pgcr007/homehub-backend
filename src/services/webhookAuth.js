const crypto = require('crypto');

/**
 * Per-device webhook secrets are *derived*, not stored. Each device's secret
 * is HMAC(WEBHOOK_SIGNING_SECRET, deviceKey), where deviceKey is the Device's
 * Mongo _id (globally unique, known at registration time, never reused).
 * This means:
 *   - nothing sensitive lives in the Device document or the DB at all
 *   - the secret is recomputable server-side any time, so "I lost the secret
 *     I gave the vendor" is a re-fetch, not a re-provision
 *   - compromising the DB alone doesn't leak per-device secrets, since the
 *     master WEBHOOK_SIGNING_SECRET lives only in env vars
 */
function deriveDeviceSecret(deviceKey) {
  const master = process.env.WEBHOOK_SIGNING_SECRET;
  if (!master) {
    throw new Error('WEBHOOK_SIGNING_SECRET is not set');
  }
  return crypto.createHmac('sha256', master).update(String(deviceKey)).digest('hex');
}

function computeSignature(deviceKey, rawBody) {
  const secret = deriveDeviceSecret(deviceKey);
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * @param {string} deviceKey - the Device's _id
 * @param {Buffer} rawBody - the exact bytes received (must be pre-JSON-parse)
 * @param {string} providedSignatureHex - value of the X-HomeHub-Signature header
 */
function verifySignature(deviceKey, rawBody, providedSignatureHex) {
  if (!providedSignatureHex || typeof providedSignatureHex !== 'string') return false;

  let expectedBuf;
  let providedBuf;
  try {
    expectedBuf = Buffer.from(computeSignature(deviceKey, rawBody), 'hex');
    providedBuf = Buffer.from(providedSignatureHex, 'hex');
  } catch {
    return false; // malformed hex in the header
  }

  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = { deriveDeviceSecret, computeSignature, verifySignature };