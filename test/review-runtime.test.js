const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setTimeout: wait } = require('node:timers/promises');
const fixture = require('./helpers/hue-runtime.cjs');

async function until(check) {
    const end = Date.now() + 4000;
    while (!check()) { assert.ok(Date.now() < end, 'condition timed out'); await wait(5); }
}

test('SSE cannot mutate Object.prototype even with an unsafe legacy mapping', async t => {
    const stream = new PassThrough();
    const f = fixture(t, { stream, mapping: [{ hue_uuid: 'one', hue_type: 'light', loxone_name: '__proto__' }],
        get: () => ({ data: { data: [] } }) });
    await f.hue.startEventStream();
    stream.write('data: [{"type":"update","data":[{"id":"one","type":"light","on":{"on":true},"dimming":{"brightness":31}}]}]\n\n');
    assert.equal(Object.prototype.on, undefined);
    assert.equal(Object.prototype.bri, undefined);
    assert.equal(Object.hasOwn(f.config.statusCache, '__proto__'), true);
    assert.equal(f.config.statusCache.__proto__.bri, 31);
});

test('Grouped-light retries honor the resource interval, including short Retry-After', async t => {
    const f = fixture(t, { put: n => {
        if (n === 1) throw Object.assign(new Error('rate limit'), { response: { status: 429, headers: { 'retry-after': '0.1' } } });
        return { data: {} };
    } });
    f.hue.HUE_RESOURCE_DELAYS.grouped_light.delayMs = 1000;
    await f.hue._internals.putHueWithRateLimitRetry('https://fixture.invalid/clip/v2/resource/grouped_light/one', {}, { resourceType: 'grouped_light' });
    assert.equal(f.calls.puts.length, 2);
    assert.ok(f.calls.puts[1].at - f.calls.puts[0].at >= 1000);
});

test('Superseded grouped-light retry is not sent', async t => {
    let current = true;
    const f = fixture(t, { put: () => { throw Object.assign(new Error('rate limit'), { response: { status: 429 } }); } });
    const pending = f.hue._internals.putHueWithRateLimitRetry('https://fixture.invalid/grouped_light/one', {}, {
        resourceType: 'grouped_light', isCurrent: () => current
    });
    await until(() => f.calls.puts.length === 1);
    current = false;
    assert.equal(await pending, null);
    assert.equal(f.calls.puts.length, 1);
});

const verifiedLamp = { hue_uuid: 'one', hue_type: 'light', loxone_name: 'one', verify_state: true };

test('Ordinary verification updates status from the reported value, not the requested value', async t => {
    const f = fixture(t, { mapping: [verifiedLamp], get: () => ({ data: { data: [{ on: { on: true }, dimming: { brightness: 30.8 } }] } }) });
    f.config.statusCache.one = { on: 1, bri: 0 };
    await f.hue.executeCommand(f.entry, '31');
    await until(() => f.hue.getLampDiagnostics()[0]?.bestaetigt === 1);
    assert.equal(f.config.statusCache.one.bri, 30.8);
    assert.equal(f.calls.puts.length, 1);
});

test('Ordinary verification cannot overwrite a newer SSE report', async t => {
    const stream = new PassThrough();
    let release;
    const f = fixture(t, { stream, mapping: [verifiedLamp], get: url => {
        if (!url.endsWith('/light/one')) return { data: { data: [] } };
        return new Promise(resolve => { release = () => resolve({ data: { data: [{ on: { on: true }, dimming: { brightness: 31 } }] } }); });
    } });
    f.hue._internals.setReliabilityTimingsForTests({ verifyDelaysMs: [20] });
    f.config.statusCache.one = { on: 1, bri: 0 };
    await f.hue.startEventStream();
    await f.hue.executeCommand(f.entry, '31');
    await until(() => release);
    stream.write('data: [{"type":"update","data":[{"id":"one","type":"light","dimming":{"brightness":0}}]}]\n\n');
    release();
    await until(() => f.calls.puts.length === 2);
    assert.equal(f.config.statusCache.one.bri, 0);
    assert.equal(f.hue.getLampDiagnostics()[0].bestaetigt, 0);
});

test('A verification response overtaken by OFF is discarded', async t => {
    let release;
    const f = fixture(t, { mapping: [verifiedLamp], get: () => new Promise(resolve => {
        release = () => resolve({ data: { data: [{ on: { on: true }, dimming: { brightness: 31 } }] } });
    }) });
    f.hue._internals.setReliabilityTimingsForTests({ verifyDelaysMs: [20] });
    f.config.statusCache.one = { on: 0, bri: 0 };
    await f.hue.executeCommand(f.entry, '31');
    await until(() => release);
    await f.hue.executeCommand(f.entry, '0');
    release();
    await wait(10);
    assert.deepEqual(f.config.statusCache.one, { on: 0, bri: 0 });
    assert.deepEqual(f.calls.puts.map(p => p.payload.on.on), [true, false]);
});

test('Overlapping verifications do not replace a newer completed readback', async t => {
    const releases = [];
    const f = fixture(t, { mapping: [verifiedLamp], get: () => new Promise(resolve => releases.push(bri => resolve({
        data: { data: [{ on: { on: true }, dimming: { brightness: bri } }] }
    }))) });
    await f.hue.executeCommand(f.entry, '31');
    await until(() => releases.length === 2);
    releases[1](31);
    await until(() => f.config.statusCache.one?.bri === 31);
    releases[0](0);
    await wait(20);
    assert.equal(f.config.statusCache.one.bri, 31);
    assert.equal(f.calls.puts.length, 1);
});

test('Power-managed OFF retries a 429 and remains an OFF command', async t => {
    const f = fixture(t, { put: n => {
        if (n === 1) throw Object.assign(new Error('rate limit'), { response: { status: 429 } });
        return { data: {} };
    } });
    await f.hue.executeCommand(f.entry, '0');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'off');
    assert.deepEqual(f.calls.puts.map(p => p.payload.on.on), [false, false]);
    assert.ok(f.calls.puts[1].at - f.calls.puts[0].at >= 250);
});
