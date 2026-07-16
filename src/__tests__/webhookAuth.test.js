const { deriveDeviceSecret, computeSignature, verifySignature } = require('../services/webhookAuth');

describe('webhookAuth', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, WEBHOOK_SIGNING_SECRET: 'test-master-secret' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('derives the same secret for the same deviceKey', () => {
    const a = deriveDeviceSecret('device-123');
    const b = deriveDeviceSecret('device-123');
    expect(a).toBe(b);
  });

  it('derives different secrets for different deviceKeys', () => {
    const a = deriveDeviceSecret('device-123');
    const b = deriveDeviceSecret('device-456');
    expect(a).not.toBe(b);
  });

  it('throws if WEBHOOK_SIGNING_SECRET is unset', () => {
    delete process.env.WEBHOOK_SIGNING_SECRET;
    expect(() => deriveDeviceSecret('device-123')).toThrow(/WEBHOOK_SIGNING_SECRET/);
  });

  it('verifies a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ temp: 21.5 }));
    const sig = computeSignature('device-123', body);
    expect(verifySignature('device-123', body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ temp: 21.5 }));
    const sig = computeSignature('device-123', body);
    const tampered = Buffer.from(JSON.stringify({ temp: 99 }));
    expect(verifySignature('device-123', tampered, sig)).toBe(false);
  });

  it('rejects a signature computed for a different device', () => {
    const body = Buffer.from(JSON.stringify({ temp: 21.5 }));
    const sig = computeSignature('device-123', body);
    expect(verifySignature('device-999', body, sig)).toBe(false);
  });

  it('rejects a missing signature', () => {
    const body = Buffer.from(JSON.stringify({ temp: 21.5 }));
    expect(verifySignature('device-123', body, undefined)).toBe(false);
  });

  it('rejects malformed hex in the signature header', () => {
    const body = Buffer.from(JSON.stringify({ temp: 21.5 }));
    expect(verifySignature('device-123', body, 'not-hex-!!')).toBe(false);
  });
});