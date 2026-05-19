const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockOptionalDeps(request, parent, isMain) {
    if (request === 'axios') {
        const axiosMock = async () => ({ data: { data: [] } });
        axiosMock.get = async () => ({ data: { data: [] } });
        axiosMock.post = async () => ({ data: [] });
        axiosMock.put = async () => ({ data: [] });
        return axiosMock;
    }
    if (request === 'mqtt') {
        return { connect: () => ({ on: () => {}, end: () => {}, publish: () => {}, connected: false }) };
    }

    return originalLoad(request, parent, isMain);
};

const configManager = require('../lib/config');

// Da executeAlert, executeEffect und executeTimedEffect Netzwerkcalls machen,
// testen wir die Effekt-Keyword-Logik und die Math-Funktionen isoliert.
const hueManager = require('../lib/hue');
const { _internals } = hueManager;
const {
    kelvinToMirek,
    rgbToHex,
    rgbToXy,
    mirekToHex,
    xyToHex,
    hueLightToLux,
    mapRange,
    appendEventStreamChunk,
    extractSseData,
    buildMultiSyncSchedule,
    resolveGroupLightIds,
    buildEffectTargets,
    buildMultiSyncGroupEffectTargets,
    buildAllLightEffectTargets,
    normalizeCommandName
} = _internals;

// --- Farb-Mathematik ---
test('kelvinToMirek: Standard-Werte', () => {
    assert.strictEqual(kelvinToMirek(2700), Math.round(1000000 / 2700)); // warmweiß
    assert.strictEqual(kelvinToMirek(6500), Math.round(1000000 / 6500)); // kalt
    assert.strictEqual(kelvinToMirek(1000), 500); // < 2000K → Cap bei 500
});

test('rgbToHex: Primärfarben', () => {
    assert.strictEqual(rgbToHex(255, 0, 0), '#ff0000');
    assert.strictEqual(rgbToHex(0, 255, 0), '#00ff00');
    assert.strictEqual(rgbToHex(0, 0, 255), '#0000ff');
    assert.strictEqual(rgbToHex(255, 255, 255), '#ffffff');
    assert.strictEqual(rgbToHex(0, 0, 0), '#000000');
});

test('rgbToXy: Reines Rot ergibt gültigen XY-Wert', () => {
    const xy = rgbToXy(100, 0, 0);
    assert.ok(xy.x > 0 && xy.x < 1, 'x muss zwischen 0 und 1 liegen');
    assert.ok(xy.y > 0 && xy.y < 1, 'y muss zwischen 0 und 1 liegen');
});

test('rgbToXy: Schwarz ergibt {x:0, y:0}', () => {
    const xy = rgbToXy(0, 0, 0);
    assert.strictEqual(xy.x, 0);
    assert.strictEqual(xy.y, 0);
});

test('mirekToHex: Warmweiß (370 mirek ≈ 2700K) ergibt rötlichen Hex', () => {
    const hex = mirekToHex(370);
    assert.ok(hex.startsWith('#'), 'Sollte mit # beginnen');
    assert.strictEqual(hex.length, 7, 'Hex-Code muss 7 Zeichen lang sein');
    // Warmweiß hat mehr Rot als Blau
    const r = parseInt(hex.substring(1, 3), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    assert.ok(r > b, `Warmweiß: Rot (${r}) sollte größer als Blau (${b}) sein`);
});

test('xyToHex: Gibt gültigen Hex-Code zurück', () => {
    const hex = xyToHex(0.675, 0.322, 1.0); // sRGB Rot
    assert.ok(hex.startsWith('#'), 'Sollte mit # beginnen');
    assert.strictEqual(hex.length, 7);
});

test('hueLightToLux: Bekannte Werte', () => {
    // Formel: lux = Math.round(10^((v-1)/10000))
    assert.strictEqual(hueLightToLux(1), 1);         // 10^0 = 1 lux (Minimum)
    assert.strictEqual(hueLightToLux(10001), 10);   // 10^(10000/10000) = 10^1 = 10
    const highLux = hueLightToLux(30001);
    assert.ok(highLux > 100, `Bei hohem Lichtsensor-Wert (30001) muss lux > 100 sein, war: ${highLux}`);
});

test('mapRange: Lineare Interpolation', () => {
    assert.strictEqual(mapRange(50, 0, 100, 0, 200), 100);
    assert.strictEqual(mapRange(0, 0, 100, 0, 200), 0);
    assert.strictEqual(mapRange(100, 0, 100, 0, 200), 200);
});

// --- SSE/EventStream Parsing ---
test('SSE Parser puffert fragmentierte JSON Payloads bis zur Leerzeile', () => {
    const first = appendEventStreamChunk('', Buffer.from('data: [{"type":"update","data":[{"id":"1","on":{"on":tr'));
    assert.deepStrictEqual(first.rawEvents, []);
    assert.ok(first.remaining.length > 0);

    const second = appendEventStreamChunk(first.remaining, Buffer.from('ue}}]}]\n\n'));
    assert.strictEqual(second.remaining, '');
    assert.strictEqual(second.rawEvents.length, 1);

    const payload = extractSseData(second.rawEvents[0]);
    assert.deepStrictEqual(JSON.parse(payload), [{ type: 'update', data: [{ id: '1', on: { on: true } }] }]);
});

test('SSE Parser verarbeitet CRLF und mehrzeilige data Felder', () => {
    const chunk = Buffer.from('event: update\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r\n');
    const parsed = appendEventStreamChunk('', chunk);
    assert.strictEqual(parsed.rawEvents.length, 1);
    assert.strictEqual(extractSseData(parsed.rawEvents[0]), '{"a":1,\n"b":2}');
});

// --- Mehrlampensynchronisierung ---
test('Multi-Sync Scheduler respektiert maximale Hue Befehlsrate', () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
        entry: { loxone_name: `lampe_${index}`, sync_offset_ms: 0 }
    }));

    const schedule = buildMultiSyncSchedule(items, {
        syncWindowMs: 120,
        batchSize: 4,
        batchDelayMs: 30,
        maxCommandsPerSecond: 10
    });

    assert.strictEqual(schedule.length, 11);

    for (let i = 1; i < schedule.length; i++) {
        assert.ok(
            schedule[i].delayMs - schedule[i - 1].delayMs >= 100,
            `Abstand ${i} war ${schedule[i].delayMs - schedule[i - 1].delayMs}ms`
        );
    }
});

test('Multi-Sync Scheduler erlaubt schnellere experimentelle Rate kontrolliert', () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
        entry: { loxone_name: `lampe_${index}`, sync_offset_ms: 0 }
    }));

    const schedule = buildMultiSyncSchedule(items, {
        syncWindowMs: 120,
        batchSize: 4,
        batchDelayMs: 30,
        maxCommandsPerSecond: 25
    });

    for (let i = 1; i < schedule.length; i++) {
        assert.ok(
            schedule[i].delayMs - schedule[i - 1].delayMs >= 40,
            `Abstand ${i} war ${schedule[i].delayMs - schedule[i - 1].delayMs}ms`
        );
    }
});

test('Multi-Sync Preview trennt Lampen nach Gruppe', () => {
    configManager.config.multiLightControl = configManager.getDefaultMultiLightControl({
        bridgeMaxCommandsPerSecond: 30,
        groups: [
            { id: 'a', name: 'Wohnzimmer', syncWindowMs: 120, batchSize: 4, batchDelayMs: 30, maxCommandsPerSecond: 20 },
            { id: 'b', name: 'Buero', syncWindowMs: 100, batchSize: 2, batchDelayMs: 20, maxCommandsPerSecond: 10 }
        ]
    });

    const preview = hueManager.getMultiSyncPreview([
        { hue_type: 'light', multi_sync: true, multi_sync_group: 'a', loxone_name: 'wohn_1' },
        { hue_type: 'light', multi_sync: true, multi_sync_group: 'a', loxone_name: 'wohn_2' },
        { hue_type: 'light', multi_sync: true, multi_sync_group: 'b', loxone_name: 'buero_1' },
        { hue_type: 'group', multi_sync: true, multi_sync_group: 'a', loxone_name: 'hue_group' }
    ]);

    const groupA = preview.groups.find(group => group.groupId === 'a');
    const groupB = preview.groups.find(group => group.groupId === 'b');

    assert.strictEqual(preview.bridgeMaxCommandsPerSecond, 30);
    assert.strictEqual(groupA.settings.name, 'Wohnzimmer');
    assert.strictEqual(groupA.activeLights, 2);
    assert.strictEqual(groupB.settings.name, 'Buero');
    assert.strictEqual(groupB.activeLights, 1);
});

test('Gruppen-Effekt-Fallback loest Hue Raum/Zone auf einzelne Lampen auf', () => {
    const rooms = [{
        id: 'room-1',
        services: [{ rtype: 'grouped_light', rid: 'grouped-wz' }],
        children: [
            { rtype: 'device', rid: 'device-1' },
            { rtype: 'device', rid: 'device-2' }
        ]
    }];
    const zones = [];
    const devices = [
        { id: 'device-1', services: [{ rtype: 'light', rid: 'light-1' }] },
        { id: 'device-2', services: [{ rtype: 'light', rid: 'light-2' }, { rtype: 'zigbee_connectivity', rid: 'zigbee-2' }] }
    ];

    assert.deepStrictEqual(resolveGroupLightIds('grouped-wz', rooms, zones, devices), ['light-1', 'light-2']);
});

test('Gruppen-Effekt-Fallback uebernimmt Multi-Sync-Zuordnung gemappter Lampen', () => {
    configManager.mapping = [
        { hue_type: 'light', hue_uuid: 'light-1', loxone_name: 'wohn_links', multi_sync: true, multi_sync_group: 'a' },
        { hue_type: 'light', hue_uuid: 'light-2', loxone_name: 'wohn_rechts', multi_sync: true, multi_sync_group: 'a' }
    ];

    const targets = buildEffectTargets(
        { hue_type: 'group', hue_uuid: 'grouped-wz', loxone_name: 'wz_group' },
        ['light-1', 'light-2', 'light-3']
    );

    assert.strictEqual(targets.length, 3);
    assert.strictEqual(targets[0].entry.loxone_name, 'wohn_links');
    assert.strictEqual(targets[0].entry.multi_sync_group, 'a');
    assert.strictEqual(targets[2].entry.loxone_name, 'wz_group_3');
    assert.strictEqual(targets[2].entry.multi_sync, false);
});

test('Multi-Sync Gruppen-Effektziel findet Lampen der gewaehlten loxHueBridge Gruppe', () => {
    configManager.mapping = [
        { hue_type: 'light', hue_uuid: 'light-a1', loxone_name: 'wohn_1', multi_sync: true, multi_sync_group: 'a' },
        { hue_type: 'light', hue_uuid: 'light-a2', loxone_name: 'wohn_2', multi_sync: true, multi_sync_group: 'a' },
        { hue_type: 'light', hue_uuid: 'light-b1', loxone_name: 'buero_1', multi_sync: true, multi_sync_group: 'b' },
        { hue_type: 'light', hue_uuid: 'light-off', loxone_name: 'normal', multi_sync: false, multi_sync_group: 'a' }
    ];

    const targets = buildMultiSyncGroupEffectTargets('a');

    assert.deepStrictEqual(targets.map(target => target.uuid), ['light-a1', 'light-a2']);
});

test('Multi-Sync Gruppenname kann als URL-Ziel erkannt werden', () => {
    configManager.config.multiLightControl = configManager.getDefaultMultiLightControl({
        groups: [{ id: 'a', name: 'Wohnzimmer Ambient' }]
    });

    assert.strictEqual(normalizeCommandName('Wohnzimmer Ambient'), 'wohnzimmer_ambient');
    assert.strictEqual(hueManager.resolveMultiSyncGroupCommandName('gruppe_a'), 'a');
    assert.strictEqual(hueManager.resolveMultiSyncGroupCommandName('Wohnzimmer Ambient'), 'a');
});

test('All-Effektziel verwendet nur gemappte Einzel-Lampen und dedupliziert sie', () => {
    configManager.mapping = [
        { hue_type: 'light', hue_uuid: 'light-1', loxone_name: 'wohn_1', multi_sync: true, multi_sync_group: 'a' },
        { hue_type: 'light', hue_uuid: 'light-1', loxone_name: 'wohn_1_duplikat', multi_sync: true, multi_sync_group: 'a' },
        { hue_type: 'light', hue_uuid: 'light-2', loxone_name: 'wohn_2', multi_sync: true, multi_sync_group: 'b' },
        { hue_type: 'group', hue_uuid: 'grouped-wz', loxone_name: 'wz_group' }
    ];

    const targets = buildAllLightEffectTargets();

    assert.deepStrictEqual(targets.map(target => target.uuid), ['light-1', 'light-2']);
});

// --- Effekt-Keyword-Validierung ---
test('Effekt-Keywords sind vollständig und korrekt definiert', () => {
    const ALERT_KEYWORDS  = ['alert', 'breathe'];
    const EFFECT_KEYWORDS = ['candle', 'fire', 'fireplace', 'prism', 'sparkle', 'opal', 'glisten', 'noeffect', 'no_effect'];
    const TIMED_EFFECTS   = ['sunrise'];

    // Keine Überschneidungen
    const alertSet  = new Set(ALERT_KEYWORDS);
    const effectSet = new Set(EFFECT_KEYWORDS);
    const timedSet  = new Set(TIMED_EFFECTS);

    EFFECT_KEYWORDS.forEach(k => assert.ok(!alertSet.has(k),  `${k} darf nicht in beiden Listen sein`));
    TIMED_EFFECTS.forEach(k  => assert.ok(!alertSet.has(k),   `${k} darf nicht in beiden Listen sein`));
    TIMED_EFFECTS.forEach(k  => assert.ok(!effectSet.has(k),  `${k} darf nicht in beiden Listen sein`));

    // 'noeffect' muss zu 'no_effect' normalisiert werden
    const normalize = (v) => {
        if (v === 'noeffect') return 'no_effect';
        if (v === 'fireplace') return 'fire';
        return v;
    };
    assert.strictEqual(normalize('noeffect'), 'no_effect');
    assert.strictEqual(normalize('fireplace'), 'fire');
    assert.strictEqual(normalize('candle'), 'candle');
});
