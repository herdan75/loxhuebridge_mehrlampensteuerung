const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { setTimeout: wait } = require('node:timers/promises');
let puts = [], delay = 0, groupRateLimited = false, onGroupAttempt = null;
const resources = {
    room: [{ services: [{ rid: 'group-a', rtype: 'grouped_light' }], children: [{ rid: 'device-a', rtype: 'device' }] }],
    device: [{ id: 'device-a', services: [{ rid: 'light-a', rtype: 'light' }, { rid: 'light-b', rtype: 'light' }] }]
};
const axios = async () => ({ data: [] });
axios.get = async url => { await wait(delay); return { data: { data: resources[url.split('/').pop()] || [] } }; };
axios.put = async (url, payload) => {
    puts.push({ url, payload: structuredClone(payload) });
    if (url.endsWith('/group-a') && groupRateLimited) {
        groupRateLimited = false;
        onGroupAttempt?.();
        const error = new Error('429');
        error.response = { status: 429, headers: { 'retry-after': '0.1' } };
        throw error;
    }
    return { data: { errors: [] } };
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { return request === 'axios' ? axios : originalLoad(request, parent, isMain); };
const config = require('../lib/config');
const hue = require('../lib/hue');
Module._load = originalLoad;
const light = { hue_uuid: 'light-a', hue_type: 'light', loxone_name: 'lamp_a', multi_sync: true, multi_sync_group: 'a' };
const group = { hue_uuid: 'group-a', hue_type: 'group', loxone_name: 'room_a' };

test.beforeEach(() => {
    hue._internals.resetHueSchedulerForTests();
    config.config.multiLightControl = config.getDefaultMultiLightControl({ bridgeMaxCommandsPerSecond: 100,
        groups: [{ id: 'a', syncWindowMs: 60, batchSize: 10, batchDelayMs: 0, maxCommandsPerSecond: 50 }] });
    config.config.bridgeIp = 'fixture.invalid'; config.config.appKey = 'test'; config.config.transitionTime = 0;
    config.mapping = [light, group];
    hue.HUE_RESOURCE_DELAYS.light.delayMs = 0;
    hue.HUE_RESOURCE_DELAYS.grouped_light.delayMs = 0;
    puts = []; delay = 0; groupRateLimited = false; onGroupAttempt = null;
});
test.after(() => hue.close());

test('Review F03: Gruppen-Aus verwirft gepuffertes Ein, ohne andere Lampen zu verwerfen', async () => {
    await hue.executeCommand(light, '80');
    await hue.executeCommand({ ...light, hue_uuid: 'unrelated', loxone_name: 'other' }, '70');
    await hue.executeCommand(group, '0');
    await wait(150);
    assert.equal(puts.filter(p => p.url.endsWith('/light-a')).length, 0);
    assert.equal(puts.find(p => p.url.endsWith('/group-a')).payload.on.on, false);
    assert.equal(puts.find(p => p.url.endsWith('/unrelated')).payload.dimming.brightness, 70);
});

test('Review F03: Neuer Einzelbefehl waehrend Gruppenaufloesung bleibt erhalten', async () => {
    delay = 60;
    const off = hue.executeCommand(group, '0');
    await wait(10);
    await hue.executeCommand({ ...light, multi_sync: false }, '80');
    await off;
    await wait(70);
    assert.equal(puts.filter(p => p.url.endsWith('/group-a')).length, 0);
    assert.deepEqual(puts.filter(p => p.url.endsWith('/light-a')).map(p => p.payload.on.on), [true]);
    assert.equal(puts.find(p => p.url.endsWith('/light-b')).payload.on.on, false);
});

test('Review F04: Spaete Gruppenaufloesung kann neueren Effekt-Stopp nicht ueberholen', async () => {
    delay = 60;
    const candle = hue.executeEffect(group, 'candle');
    await wait(10);
    await hue.executeEffect(light, 'no_effect');
    await candle;
    await wait(100);
    assert.deepEqual(puts.filter(p => p.url.endsWith('/light-a')).map(p => p.payload.effects.effect), ['no_effect']);
    assert.equal(puts.find(p => p.url.endsWith('/light-b')).payload.effects.effect, 'candle');
});

test('Review F03: Neuer Einzelbefehl waehrend Gruppen-Retry verhindert veralteten Gruppen-PUT', async () => {
    groupRateLimited = true;
    let signal;
    const attempted = new Promise(resolve => { signal = resolve; });
    onGroupAttempt = signal;
    const off = hue.executeCommand(group, '0');
    await attempted;
    const on = hue.executeCommand({ ...light, multi_sync: false }, '75');
    await Promise.all([off, on]);
    await wait(100);
    assert.equal(puts.filter(p => p.url.endsWith('/group-a')).length, 1, 'nur der abgelehnte Erstversuch');
    assert.equal(puts.find(p => p.url.endsWith('/light-a')).payload.dimming.brightness, 75);
    assert.equal(puts.find(p => p.url.endsWith('/light-b')).payload.on.on, false);
});

test('Review F03: Ueberlappende Gruppen erhalten die neuere Anforderung je Mitglied', async () => {
    resources.zone = [{ services: [{ rid: 'group-b', rtype: 'grouped_light' }], children: [{ rid: 'light-a', rtype: 'light' }] }];
    try {
        hue._internals.noteHueSchedulerRateLimit(180);
        const off = hue.executeCommand(group, '0');
        await wait(30);
        const on = hue.executeCommand({ ...group, hue_uuid: 'group-b' }, '65');
        await Promise.all([off, on]);
        await wait(60);
        assert.equal(puts.filter(p => p.url.endsWith('/group-a')).length, 0);
        assert.equal(puts.find(p => p.url.endsWith('/group-b')).payload.dimming.brightness, 65);
        assert.equal(puts.find(p => p.url.endsWith('/light-b')).payload.on.on, false);
    } finally { delete resources.zone; }
});

test('Review F03: Langsame Alles-Aufloesung und Sequenz behalten ihre urspruengliche Reihenfolge', async () => {
    const order = hue.reserveCommandOrder();
    await hue.executeCommand({ ...light, multi_sync: false }, '75');
    await hue.executeCommand({ ...light, multi_sync: false }, '0', 0, order);
    await hue.executeCommand({ ...light, hue_uuid: 'light-b', multi_sync: false }, '0', 0, order);
    assert.deepEqual(puts.filter(p => p.url.endsWith('/light-a')).map(p => p.payload.on.on), [true]);
    assert.equal(puts.find(p => p.url.endsWith('/light-b')).payload.on.on, false);
});
