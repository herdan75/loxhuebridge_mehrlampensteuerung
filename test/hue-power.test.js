const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const fixture = require('./helpers/hue-runtime.cjs');

async function until(check) {
    const end = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < end, 'condition timed out'); await wait(5); }
}

test('Netzstart: langsames PUT blockiert normale Lampen nicht, gemeinsame Rate bleibt erhalten', async t => {
    let release;
    const f = fixture(t, {
        config: { multiLightControl: { bridgeMaxCommandsPerSecond: 20 } },
        put: n => n === 1 ? new Promise(resolve => { release = () => resolve({ data: {} }); }) : { data: {} }
    });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => release);
    await f.hue._internals.updateLightWithQueue('healthy', 'light', { on: { on: true } }, 'healthy');
    assert.deepEqual(f.calls.puts.map(p => p.uuid), ['power', 'healthy']);
    assert.ok(f.calls.puts[1].at - f.calls.puts[0].at >= 49);
    assert.ok(f.calls.puts[1].at - f.calls.puts[0].at < 500, 'healthy lamp did not wait for slow PUT');
    assert.equal(f.calls.puts[0].options.timeout, 1200);
    release();
    await wait(30);
});

test('Netzstart: hoechstens eine Netzstart-Anfrage neben normalen Befehlen', async t => {
    let release;
    const mapping = ['one', 'two'].map(name => ({ hue_uuid: name, hue_type: 'light', loxone_name: name, power_switched: true }));
    const f = fixture(t, { mapping, put: n => n === 1 ? new Promise(resolve => { release = () => resolve({ data: {} }); }) : { data: {} } });
    await f.hue.executeCommand(mapping[0], '80');
    await until(() => release);
    await f.hue.executeCommand(mapping[1], '80');
    await f.hue._internals.updateLightWithQueue('healthy', 'light', { on: { on: true } }, 'healthy');
    assert.deepEqual(f.calls.puts.map(p => p.uuid), ['one', 'healthy']);
    release();
    await until(() => f.calls.puts.length === 3);
    assert.equal(f.calls.puts[2].uuid, 'two');
});

test('Netzstart: fehlgeschlagenes ON wird wiederholt und GET bestaetigt unabhaengig von Debug', async t => {
    const f = fixture(t, { put: n => {
        if (n === 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        return { data: {} };
    } });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
    assert.equal(f.calls.puts.length, 2);
    const row = f.hue.getLampDiagnostics()[0];
    assert.equal(row.befehle, 1);
    assert.equal(row.bestaetigt, 1);
    assert.equal(row.requestErrors, 1);
    assert.equal(row.startupAttempts, 2);
    assert.equal(f.hue.httpsAgent.keepAlive, true);
});

test('Netzstart: OFF waehrend Wiederholung verhindert jedes spaetere ON', async t => {
    const f = fixture(t, { put: n => {
        if (n === 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        return { data: {} };
    } });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'retrying');
    await f.hue.executeCommand(f.entry, '0');
    await until(() => f.calls.puts.length === 2);
    await wait(800);
    assert.deepEqual(f.calls.puts.map(p => p.payload.on.on), [true, false]);
});

test('Netzstart: keine Zusatzverzoegerung bei warmer Lampe trotz konfigurierter Anlaufwartezeit', async t => {
    const f = fixture(t);
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
    f.entry.power_on_delay_ms = 1000;
    const start = Date.now();
    await f.hue.executeCommand(f.entry, '60');
    await until(() => f.calls.puts.length === 2);
    assert.ok(f.calls.puts[1].at - start < 300);
});

test('Netzstart: Hue-Fehler 400 wird nicht wiederholt', async t => {
    const f = fixture(t, { put: () => { throw Object.assign(new Error('bad payload'), { response: { status: 400 } }); } });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'failed');
    await wait(350);
    assert.equal(f.calls.puts.length, 1);
});

test('Netzstart: 429 bremst auch die andere Lane und wird nicht intern verdoppelt', async t => {
    const f = fixture(t, { put: n => {
        if (n === 1) throw Object.assign(new Error('rate limit'), { response: { status: 429, headers: { 'retry-after': '0.1' } } });
        return { data: {} };
    } });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'retrying');
    await f.hue._internals.updateLightWithQueue('healthy', 'light', { on: { on: true } }, 'healthy');
    assert.ok(f.calls.puts[1].at - f.calls.puts[0].at >= 99);
    assert.equal(f.calls.puts[1].uuid, 'healthy');
    await until(() => f.hue.getLampDiagnostics().find(row => row.uuid === 'power')?.startupStatus === 'confirmed');
    assert.equal(f.calls.puts.filter(p => p.uuid === 'power').length, 2);
});

for (const mode of ['verify_state', 'repeat_command']) {
    for (const error of ['communication_error', 'timeout']) {
        test(`Funkmassnahme ${mode}: auch nach initialem ${error}`, async t => {
            const f = fixture(t, {
                mapping: [{ hue_uuid: 'lamp', hue_type: 'light', loxone_name: 'lamp', [mode]: true }],
                get: () => ({ data: { data: [{ on: { on: false }, dimming: { brightness: 1 } }] } }),
                put: n => {
                    if (n !== 1) return { data: {} };
                    if (error === 'communication_error') return { data: { errors: [{ error_code: 'communication_error' }] } };
                    throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
                }
            });
            await f.hue.executeCommand(f.entry, '80');
            await until(() => f.calls.puts.length >= 2);
            assert.equal(f.hue.getLampDiagnostics()[0].requestErrors, 1);
        });
    }
}

test('Dynamics ignorieren sendet explizit duration=0 an dimmbare Lampe', async t => {
    const f = fixture(t, { mapping: [{ hue_uuid: 'lamp', hue_type: 'light', loxone_name: 'lamp', ignore_dynamics: true }], config: { transitionTime: 750 } });
    await f.hue.executeCommand(f.entry, '80');
    assert.deepEqual(f.calls.puts[0].payload.dynamics, { duration: 0 });
});

test('Netzstart: Offline-Status verhindert falsche Bestaetigung aus zwischengespeichertem Lichtzustand', async t => {
    let connected = false;
    const f = fixture(t, { get: url => {
        if (url.endsWith('/device')) return { data: { data: [{ id: 'device', services: [{ rid: 'power', rtype: 'light' }, { rid: 'radio', rtype: 'zigbee_connectivity' }] }] } };
        if (url.endsWith('/light')) return { data: { data: [{ id: 'power', owner: { rid: 'device' }, dimming: { brightness: 80 } }] } };
        if (url.includes('zigbee_connectivity')) return { data: { data: [{ id: 'radio', owner: { rid: 'device' }, status: connected ? 'connected' : 'connectivity_issue' }] } };
        return { data: { data: [{ on: { on: true }, dimming: { brightness: 80 } }] } };
    } });
    await f.hue.buildDeviceMap();
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.calls.puts.length >= 2);
    assert.equal(f.hue.getLampDiagnostics()[0].bestaetigt, 0);
    connected = true;
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
});

for (const matches of [true, false]) {
    test(`Netzstart: native Gruppe bleibt ein PUT, nur unerreichte Netzlampe wird korrigiert (${matches})`, async t => {
        const group = { hue_type: 'group', hue_uuid: 'group', loxone_name: 'room' };
        const f = fixture(t, { get: url => {
            if (url.endsWith('/room')) return { data: { data: [{ services: [{ rid: 'group', rtype: 'grouped_light' }], children: [{ rid: 'power', rtype: 'light' }, { rid: 'healthy', rtype: 'light' }] }] } };
            if (url.endsWith('/light/power')) return { data: { data: [{ on: { on: matches }, dimming: { brightness: matches ? 80 : 0 } }] } };
            return { data: { data: [] } };
        } });
        await f.hue.executeCommand(group, '80');
        assert.equal(f.calls.puts[0].uuid, 'group');
        if (matches) {
            await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
            assert.equal(f.calls.puts.length, 1);
        } else {
            await until(() => f.calls.puts.length === 2);
            assert.equal(f.calls.puts[1].uuid, 'power');
            assert.equal(f.calls.puts.some(p => p.uuid === 'healthy'), false);
            await f.hue.executeCommand(group, '0');
            await wait(1200);
            assert.equal(f.calls.puts.at(-1).payload.on.on, false);
        }
    });
}

test('Netzstart: Effekte bleiben light-Payloads und erhalten keine Dynamics', async t => {
    const f = fixture(t, { config: { transitionTime: 750 }, put: n => {
        if (n === 1) throw Object.assign(new Error('offline'), { code: 'ECONNABORTED' });
        return { data: {} };
    } });
    await f.hue.executeEffect(f.entry, 'candle');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'accepted');
    assert.equal(f.calls.puts.length, 2);
    assert.deepEqual(f.calls.puts[1].payload, { effects: { effect: 'candle' } });
});

test('Netzstart: Multi-Sync-Frist bleibt bestehen, neueste Szene gewinnt im laufenden Start', async t => {
    const f = fixture(t, { mapping: [{ hue_uuid: 'power', hue_type: 'light', loxone_name: 'power',
        power_switched: true, multi_sync: true, multi_sync_group: 'a', power_on_delay_ms: 300 }],
        config: { multiLightControl: { bridgeMaxCommandsPerSecond: 50, groups: [{ id: 'a', syncWindowMs: 10, maxCommandsPerSecond: 30, batchSize: 10, batchDelayMs: 0 }] } } });
    await f.hue.executeCommand(f.entry, '20');
    await wait(100);
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
    assert.equal(f.calls.puts.length, 1);
    assert.equal(f.calls.puts[0].payload.dimming.brightness, 80);
});

test('Ressourcenabruf: Hue-Fehler trotz HTTP 200 erhaelt bisherige Geraetefaehigkeiten', async t => {
    let fail = false;
    const f = fixture(t, { mapping: [], get: url => fail ? { data: { data: [], errors: [{ error_code: 'temporarily_unavailable' }] } }
        : { data: { data: url.endsWith('/light') ? [{ id: 'lamp', dimming: { brightness: 50 }, color: {} }] : [] } } });
    await f.hue.buildDeviceMap();
    assert.equal(f.hue.getLightCapabilities().lamp.supportsColor, true);
    fail = true;
    await f.hue.buildDeviceMap();
    assert.equal(f.hue.getLightCapabilities().lamp.supportsColor, true);
    assert.ok(f.calls.logs.some(log => log.level === 'warn'));
});

test('Zustandspruefung: fehlende Sollfelder gelten nicht als Bestaetigung', async t => {
    const f = fixture(t, { mapping: [{ hue_uuid: 'lamp', hue_type: 'light', loxone_name: 'lamp', verify_state: true }],
        get: () => ({ data: { data: [{ on: { on: true } }] } }) });
    await f.hue.executeCommand(f.entry, '80');
    await until(() => f.calls.puts.length >= 2);
    assert.equal(f.hue.getLampDiagnostics()[0].bestaetigt, 0);
    assert.ok(f.hue.getLampDiagnostics()[0].nachgesteuert >= 1);
});

test('Netzstart: echtes SSE-Reconnect-Ereignis verkuerzt konfigurierte Anlaufwartezeit', async t => {
    const { PassThrough } = require('node:stream');
    const stream = new PassThrough();
    const f = fixture(t, { stream, mapping: [{ hue_type: 'light', hue_uuid: 'power', loxone_name: 'power', power_switched: true, power_on_delay_ms: 2000 }],
        get: url => {
            const resources = {
                device: [{ id: 'device', services: [{ rid: 'power', rtype: 'light' }, { rid: 'radio', rtype: 'zigbee_connectivity' }] }],
                light: [{ id: 'power', type: 'light', owner: { rid: 'device' }, on: { on: false }, dimming: { brightness: 0 } }],
                zigbee_connectivity: [{ id: 'radio', owner: { rid: 'device' }, status: 'connectivity_issue' }]
            };
            return { data: { data: resources[url.split('/').pop()] || [] } };
        }
    });
    await f.hue.startEventStream();
    await f.hue.executeCommand(f.entry, '80');
    await wait(40);
    assert.equal(f.calls.puts.length, 0);
    const reconnectAt = Date.now();
    stream.write('data: [{"type":"update","data":[{"id":"radio","type":"zigbee_connectivity","owner":{"rid":"device"},"status":"connected"}]}]\n\n');
    await until(() => f.calls.puts.length === 1);
    assert.ok(f.calls.puts[0].at - reconnectAt < 500);
    stream.write('data: [{"type":"update","data":[{"id":"power","type":"light","on":{"on":true},"dimming":{"brightness":80}}]}]\n\n');
    await until(() => f.hue.getLampDiagnostics()[0]?.startupStatus === 'confirmed');
    assert.equal(f.calls.puts.length, 1);
});
