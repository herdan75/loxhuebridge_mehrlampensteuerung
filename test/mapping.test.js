const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMappings } = require('../lib/mapping');
const lamp = { hue_type: 'light', hue_uuid: 'light-1', loxone_name: 'living' };

test('Mapping rejects object prototype names and resource identifiers', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
        assert.throws(() => validateMappings([{ ...lamp, loxone_name: name }]), { statusCode: 400 });
        assert.throws(() => validateMappings([{ ...lamp, hue_uuid: name }]), { statusCode: 400 });
    }
});

test('Review F10: Mapping rejects duplicates, reserved names, paths and conflicting options', () => {
    for (const items of [
        [lamp, { ...lamp, loxone_name: 'LIVING' }], [{ ...lamp, loxone_name: 'all' }],
        [{ ...lamp, loxone_name: 'api' }], [{ ...lamp, loxone_name: '../bad' }],
        [{ ...lamp, hue_uuid: '../other' }], [{ ...lamp, hue_type: 'unsupported' }],
        [{ ...lamp, verify_state: true, repeat_command: true }], [{ ...lamp, multi_sync_group: 'z' }]
    ]) assert.throws(() => validateMappings(items), e => e.statusCode === 400);
});

test('Review F10: Legacy defaults and explicit global target remain supported', () => {
    const result = validateMappings([lamp, { hue_type: 'group', hue_uuid: 'pseudo-all', loxone_name: 'all' }]);
    assert.equal(result.length, 2);
    assert.equal(result[0].multi_sync_group, 'a');
    assert.equal(result[0].sync_offset_ms, 0);
    assert.equal(result[0].power_switched, false);
    assert.equal(result[0].power_on_delay_ms, 0);
    assert.equal(result[0].power_retry_window_ms, 15000);
    assert.equal(result[0].transition_time_ms, null);
});

test('Per-light transition accepts inheritance, zero and bounded integer durations only', () => {
    for (const value of [undefined, null, '', '  ', 0, 1500, 60000]) {
        const [entry] = validateMappings([{ ...lamp, transition_time_ms: value }]);
        assert.equal(entry.transition_time_ms, typeof value === 'number' ? value : null);
    }
    for (const value of [-1, 60001, 1.5, NaN, Infinity, '500', true, {}, []]) {
        assert.throws(() => validateMappings([{ ...lamp, transition_time_ms: value }]), { statusCode: 400 });
    }
    for (const hue_type of ['group', 'sensor', 'button']) {
        assert.throws(() => validateMappings([{ ...lamp, hue_type, transition_time_ms: 0 }]), { statusCode: 400 });
        assert.equal(validateMappings([{ ...lamp, hue_type, transition_time_ms: null }])[0].transition_time_ms, null);
    }
});

test('Netzstart: validierte Einstellung nur pro Lampe, sinnvolle Grenzen und Zeitrelation', () => {
    const result = validateMappings([{ ...lamp, power_switched: true, power_on_delay_ms: 500, power_retry_window_ms: 10000 }]);
    assert.equal(result[0].power_switched, true);
    assert.equal(result[0].power_on_delay_ms, 500);
    for (const values of [
        { power_switched: 'true' }, { power_on_delay_ms: -1 }, { power_on_delay_ms: 10001 },
        { power_on_delay_ms: 1.5 }, { power_retry_window_ms: 1999 }, { power_retry_window_ms: 60001 },
        { power_on_delay_ms: 2000, power_retry_window_ms: 2000 },
        { power_switched: true, hue_type: 'group' }
    ]) assert.throws(() => validateMappings([{ ...lamp, ...values }]), e => e.statusCode === 400);
});
