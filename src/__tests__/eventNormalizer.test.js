const { normalizeEvent } = require('../services/eventNormalizer');

describe('normalizeEvent', () => {
  it('normalizes a tasmota_plug payload', () => {
    const device = { type: 'tasmota_plug' };
    expect(normalizeEvent(device, { POWER: 'ON' })).toEqual({
      normalizedState: { power: 'on' },
    });
    expect(normalizeEvent(device, { POWER: 'OFF' })).toEqual({
      normalizedState: { power: 'off' },
    });
  });

  it('normalizes a tasmota_bulb payload including brightness', () => {
    const device = { type: 'tasmota_bulb' };
    expect(normalizeEvent(device, { POWER: 'ON', Dimmer: 42 })).toEqual({
      normalizedState: { power: 'on', brightness: 42 },
    });
  });

  it('rejects an out-of-range Dimmer value', () => {
    const device = { type: 'tasmota_bulb' };
    expect(() => normalizeEvent(device, { POWER: 'ON', Dimmer: 150 })).toThrow(/between 0 and 100/);
  });

  it('normalizes a contact sensor payload', () => {
    const device = { type: 'esphome_contact_sensor' };
    expect(normalizeEvent(device, { contact: 'OPEN' })).toEqual({
      normalizedState: { contact: 'open' },
    });
  });

  it('normalizes a motion sensor payload', () => {
    const device = { type: 'esphome_motion_sensor' };
    expect(normalizeEvent(device, { motion: 'DETECTED' })).toEqual({
      normalizedState: { motion: 'detected' },
    });
  });

  it('normalizes a webhook thermostat payload', () => {
    const device = { type: 'webhook_thermostat' };
    expect(normalizeEvent(device, { temp: 21.5, target: 22, mode: 'heat' })).toEqual({
      normalizedState: { temperature: 21.5, targetTemperature: 22, mode: 'heat' },
    });
  });

  it('rejects an invalid thermostat mode', () => {
    const device = { type: 'webhook_thermostat' };
    expect(() => normalizeEvent(device, { mode: 'nuke' })).toThrow(/mode/);
  });

  it('rejects a payload missing the required field', () => {
    const device = { type: 'tasmota_plug' };
    expect(() => normalizeEvent(device, {})).toThrow(/POWER/);
  });

  it('rejects an unsupported device type', () => {
    expect(() => normalizeEvent({ type: 'not_a_real_type' }, {})).toThrow(/no normalizer registered/);
  });

  it('rejects a non-object payload', () => {
    expect(() => normalizeEvent({ type: 'tasmota_plug' }, null)).toThrow(/must be a JSON object/);
  });
});