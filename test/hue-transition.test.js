const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const fixture = require('./helpers/hue-runtime.cjs');

const lamp = { hue_uuid: 'fade-id', hue_type: 'light', loxone_name: 'fade' };
async function until(check) {
    const end = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < end, 'condition timed out'); await wait(5); }
}
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

test('Transition: per-light value overrides global, blank inherits live global, zero remains zero', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, transition_time_ms: 1800 }], config: { transitionTime: 400 } });
    await f.hue.executeCommand(f.entry, '80');
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 1800);
    f.entry.transition_time_ms = null;
    await f.hue.executeCommand(f.entry, '70');
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 400);
    f.config.config.transitionTime = 900;
    await f.hue.executeCommand(f.entry, '60');
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 900);
    delete f.entry.transition_time_ms;
    await f.hue.executeCommand(f.entry, '50');
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 900);
    f.entry.transition_time_ms = 0;
    await f.hue.executeCommand(f.entry, '40');
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 0);
    await f.hue.executeCommand(f.entry, '0');
    assert.deepEqual(f.calls.puts.at(-1).payload, { on: { on: false }, dynamics: { duration: 0 } });
});

test('Transition: colors and off use override, ignore and explicit command duration keep precedence', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, transition_time_ms: 2000 }] });
    for (const value of ['50063080', '200502700', '0']) {
        await f.hue.executeCommand(f.entry, value);
        assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 2000);
    }
    await f.hue.executeCommand(f.entry, '80', 600);
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 600);
    f.entry.ignore_dynamics = true;
    await f.hue.executeCommand(f.entry, '70', 600);
    assert.equal(f.calls.puts.at(-1).payload.dynamics.duration, 0);
    assert.equal(f.entry.transition_time_ms, 2000);
});

test('Transition: digital on, nondimmable devices and effects remain unchanged', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, transition_time_ms: 2000 }] });
    await f.hue.executeCommand(f.entry, '1');
    assert.deepEqual(f.calls.puts.at(-1).payload, { on: { on: true } });
    for (const effect of [{ effects: { effect: 'candle' } }, { timed_effects: { effect: 'sunrise', duration: 30000 } }]) {
        await f.hue._internals.updateLightWithQueue(lamp.hue_uuid, 'light', effect, lamp.loxone_name);
        assert.deepEqual(f.calls.puts.at(-1).payload, effect);
    }
    f.hue.getLightCapabilities()[lamp.hue_uuid] = { supportsDimming: false };
    await f.hue.executeCommand(f.entry, '80');
    assert.deepEqual(f.calls.puts.at(-1).payload, { on: { on: true } });
});

test('Transition: native grouped-light command stays single and uses global duration', async t => {
    const f = fixture(t, { mapping: [lamp, { hue_uuid: 'group-id', loxone_name: 'room', hue_type: 'group' }], config: { transitionTime: 400 } });
    f.entry.transition_time_ms = 1800;
    await f.hue._internals.updateLightWithQueue('group-id', 'grouped_light', { on: { on: true }, dimming: { brightness: 80 } }, 'room');
    assert.equal(f.calls.puts.length, 1);
    assert.equal(f.calls.puts[0].uuid, 'group-id');
    assert.equal(f.calls.puts[0].payload.dynamics.duration, 400);
});

test('Transition: multi-sync keeps separate lamp durations and does not wait for fades', async t => {
    const mapping = [1800, null, 0].map((transition_time_ms, i) => ({
        ...lamp, hue_uuid: `lamp-${i}`, loxone_name: `lamp_${i}`, multi_sync: true, multi_sync_group: 'a', transition_time_ms
    }));
    const f = fixture(t, { mapping, config: { transitionTime: 400,
        multiLightControl: { bridgeMaxCommandsPerSecond: 100, groups: [{ id: 'a', syncWindowMs: 20, maxCommandsPerSecond: 50, batchSize: 10, batchDelayMs: 0 }] }
    } });
    for (const entry of mapping) await f.hue.executeCommand(entry, '80');
    await until(() => f.calls.puts.length === 3);
    for (const [i, duration] of [1800, 400, 0].entries()) {
        assert.equal(f.calls.puts.find(p => p.uuid === `lamp-${i}`).payload.dynamics.duration, duration);
    }
    assert.ok(f.calls.puts.at(-1).at - f.calls.puts[0].at < 1000);
});

test('Transition: power-start verification waits for this lamp, not the global fade', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, power_switched: true, transition_time_ms: 800 }], config: { transitionTime: 100 } });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
    await f.hue.executeCommand(f.entry, '80');
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.calls.puts[0].payload.dynamics.duration, 800);
    t.mock.timers.tick(799);
    await flush();
    assert.equal(f.calls.gets.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.calls.gets.length, 1);
    assert.equal(f.hue.getLampDiagnostics()[0].startupStatus, 'confirmed');
});

test('Transition: normal verification and mismatch diagnostics respect the individual fade', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, verify_state: true, transition_time_ms: 800 }] });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
    await f.hue.executeCommand(f.entry, '80');
    f.hue._internals.recordLampEvent(lamp.hue_uuid, { on: { on: true }, dimming: { brightness: 20 } });
    assert.equal(f.hue.getLampDiagnostics()[0].widersprueche, 0);
    t.mock.timers.tick(799);
    await flush();
    assert.equal(f.calls.gets.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.ok(f.calls.gets.length > 0);
    assert.equal(f.calls.puts.length, 1);
});

test('Transition: power-start group verification does not interrupt a longer native group fade', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, power_switched: true, transition_time_ms: 0 }] });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
    await f.hue._internals.updateLightWithQueue(lamp.hue_uuid, 'light', {
        on: { on: true }, dimming: { brightness: 80 }, dynamics: { duration: 1200 }
    }, lamp.loxone_name, null, { powerVerifyFirst: true });
    t.mock.timers.tick(1199);
    await flush();
    assert.equal(f.calls.gets.length, 0);
    assert.equal(f.calls.puts.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.calls.gets.length, 1);
    assert.equal(f.calls.puts.length, 0);
    assert.equal(f.hue.getLampDiagnostics()[0].startupStatus, 'confirmed');
});

test('Transition: repeat follow-up retains the individual duration', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, repeat_command: true, transition_time_ms: 1200 }] });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.calls.puts.length === 2);
    assert.deepEqual(f.calls.puts.map(p => p.payload.dynamics.duration), [1200, 1200]);
});

test('Transition: split-on applies the individual fade only to the second payload', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, split_on: true, transition_time_ms: 1200 }] });
    f.hue._internals.setReliabilityTimingsForTests({ splitDelayMs: 20 });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.calls.puts.length === 2);
    assert.deepEqual(f.calls.puts[0].payload, { on: { on: true } });
    assert.deepEqual(f.calls.puts[1].payload, { dimming: { brightness: 80 }, dynamics: { duration: 1200 } });
});

test('Transition: 429 retry preserves the individual duration', async t => {
    const f = fixture(t, { mapping: [{ ...lamp, transition_time_ms: 1700 }], put: n => {
        if (n === 1) throw Object.assign(new Error('rate limit'), { response: { status: 429 } });
        return { data: {} };
    } });
    await f.hue.executeCommand(f.entry, '80');
    assert.deepEqual(f.calls.puts.map(p => p.payload.dynamics.duration), [1700, 1700]);
});
