const test = require('node:test');
const assert = require('node:assert/strict');
const PowerStart = require('../lib/power-start');

function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const controller = new PowerStart();
    const calls = [];
    const phases = [];
    t.after(() => controller.close());
    const request = overrides => ({
        isOn: true, delayMs: 0, windowMs: 15000, verifyDelayMs: 300,
        isCurrent: () => true, shouldRetry: () => true,
        send: async attempt => { calls.push(attempt); }, verify: async () => true,
        onState: phase => phases.push(phase), ...overrides
    });
    const advance = async (ms = 0) => {
        t.mock.timers.tick(ms);
        for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    return { controller, calls, phases, request, advance };
}

test('Netzstart: sofortiger Erstversuch, warme Lampe ohne weitere Wartezeit', async t => {
    const f = fixture(t);
    f.controller.submit('lamp', f.request());
    await f.advance();
    assert.deepEqual(f.calls, [1]);
    await f.advance(300);
    assert.equal(f.phases.at(-1), 'confirmed');
    f.controller.submit('lamp', f.request({ delayMs: 5000 }));
    await f.advance();
    assert.deepEqual(f.calls, [1, 1]);
    assert.equal(f.phases.at(-1), 'checking');
    await f.advance(300);
    assert.equal(f.phases.at(-1), 'confirmed');
});

test('Netzstart: OFF bricht Anlaufwartezeit ab und sendet sofort', async t => {
    const f = fixture(t);
    f.controller.submit('lamp', f.request({ delayMs: 2000 }));
    await f.advance(100);
    assert.equal(f.calls.length, 0);
    f.controller.submit('lamp', f.request({ isOn: false, delayMs: 2000 }));
    await f.advance();
    await f.advance(30000);
    assert.deepEqual(f.calls, [1]);
    assert.equal(f.phases.at(-1), 'off');
});

test('Netzstart: OFF ersetzt laufendes ON, keine spaete Einschaltwiederholung', async t => {
    const f = fixture(t);
    let release;
    f.controller.submit('lamp', f.request({ send: () => new Promise(resolve => { release = resolve; }) }));
    await f.advance();
    f.controller.submit('lamp', f.request({ isOn: false }));
    release();
    await f.advance();
    await f.advance();
    await f.advance(30000);
    assert.deepEqual(f.calls, [1]);
    assert.equal(f.phases.at(-1), 'off');
});

test('Netzstart: neue Szene ersetzt alten Sollwert ohne Anlauffrist zu verlaengern', async t => {
    const f = fixture(t);
    f.controller.submit('lamp', f.request({ delayMs: 2000 }));
    const deadline = f.controller.state('lamp').job.deadline;
    await f.advance(1000);
    f.controller.submit('lamp', f.request({ delayMs: 2000, send: async () => f.calls.push('new') }));
    assert.equal(f.controller.state('lamp').job.deadline, deadline);
    await f.advance(1000);
    assert.deepEqual(f.calls, ['new']);
});

test('Netzstart: Wiederanschluss beendet Anlaufwartezeit vorzeitig', async t => {
    const f = fixture(t);
    f.controller.connectivity('lamp', false);
    f.controller.submit('lamp', f.request({ delayMs: 2000 }));
    await f.advance(100);
    f.controller.connectivity('lamp', true);
    await f.advance();
    assert.equal(f.calls.length, 1);
});

test('Netzstart: bestaetigter Sollwert verhindert bereits geplante Wiederholung', async t => {
    const f = fixture(t);
    let confirmed = false;
    f.controller.submit('lamp', f.request({
        send: async attempt => { f.calls.push(attempt); throw new Error('offline'); },
        isConfirmed: () => confirmed
    }));
    await f.advance();
    assert.equal(f.phases.at(-1), 'retrying');
    confirmed = true;
    await f.advance(250);
    assert.deepEqual(f.calls, [1]);
    assert.equal(f.phases.at(-1), 'confirmed');
});

test('Netzstart: maximal acht Versuche und kein endloser Offline-Verkehr', async t => {
    const f = fixture(t);
    f.controller.submit('lamp', f.request({ send: async attempt => { f.calls.push(attempt); throw new Error('offline'); } }));
    await f.advance();
    for (let i = 0; i < 20; i++) await f.advance(1000);
    assert.equal(f.calls.length, 8);
    assert.equal(f.phases.at(-1), 'expired');
});

test('Netzstart: Zeitlimit, permanente Fehler und Shutdown beenden Wiederholungen', async t => {
    const f = fixture(t);
    f.controller.submit('lamp', f.request({ windowMs: 2000, delayMs: 2000 }));
    await f.advance(2000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.phases.at(-1), 'expired');
    f.controller.submit('lamp', f.request({ shouldRetry: () => false, send: async () => { throw new Error('401'); } }));
    await f.advance();
    assert.equal(f.phases.at(-1), 'failed');
    f.controller.submit('lamp', f.request({ delayMs: 1000 }));
    f.controller.close();
    await f.advance(30000);
    assert.equal(f.calls.length, 0);
});
