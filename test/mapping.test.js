const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMappings } = require('../lib/mapping');
const lamp = { hue_type: 'light', hue_uuid: 'light-1', loxone_name: 'living' };

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
});
