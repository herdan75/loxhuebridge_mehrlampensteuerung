const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createUi(responses = {}) {
    const elements = new Map();
    const context = vm.createContext({
        console, setTimeout, clearTimeout, SettingsLimits: require('../public/settings-limits'),
        confirm: () => false, alert: () => {},
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', style: {} });
            return elements.get(id);
        } },
        fetch: async url => ({ ok: true, json: async () => responses[url] || {}, text: async () => JSON.stringify(responses[url] || {}) })
    });
    const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
    vm.runInContext(source, context);
    vm.runInContext('renderMultiSyncPreview = () => {}; loadMappings = async () => {}; loadStatus = async () => {};', context);
    return { context, elements };
}

test('Review F02: settings, diagnostics and inline arguments escape untrusted text', async () => {
    const hostile = '\"><img src=x onerror=window.x=1>';
    const ui = createUi({
        '/api/settings': { mqttUser: hostile, mqttBroker: hostile, loxone_ip: hostile, multiLightControl: { groups: [] } },
        '/api/security/status': {},
        '/api/diagnostics/bridge': { zigbee: { bridge: { bridge_id: hostile } } },
        '/api/diagnostics/lampen': [{ mapping: { deviceName: hostile, multiSync: true, syncCluster: hostile } }]
    });
    await vm.runInContext('loadSettings()', ui.context);
    await vm.runInContext('loadDiagnostics()', ui.context);
    for (const id of ['settingsTable', 'diagContent']) {
        const html = ui.elements.get(id).innerHTML;
        assert.doesNotMatch(html, /<img/);
        assert.match(html, /&lt;img/);
    }
    assert.equal(vm.runInContext('jsArg("lamp")', ui.context), '&quot;lamp&quot;');
});

test('Review F09: Zahlenfelder behalten Werte ausserhalb der alten Reglergrenzen', () => {
    const { context, elements } = createUi();
    const sliders = [];
    context.document.createElement = () => ({ setAttribute() {} });
    for (const [id, value] of [['sys_transition', 5000], ['sys_multiSyncWindowMs_a', 800]]) {
        elements.set(id, { type: 'range', value, parentElement: {}, classList: { add() {} },
            setAttribute() {}, closest: () => ({ querySelector: () => ({ textContent: id }) }),
            before(slider) { sliders.push(slider); } });
    }
    vm.runInContext('upgradeNumericControls({transitionTime:5000,multiLightControl:{groups:[{id:"a",syncWindowMs:800}]}})', context);
    assert.equal(elements.get('sys_transition').value, 5000);
    assert.equal(elements.get('sys_transition').max, 60000);
    assert.equal(elements.get('sys_multiSyncWindowMs_a').value, 800);
    assert.equal(elements.get('sys_multiSyncWindowMs_a').max, 2000);
    assert.deepEqual(sliders.map(input => input.value), [5000, 800]);
});

test('Review F15: Tabwechsel verwirft geaenderte Einstellungen nicht ohne Zustimmung', () => {
    const { context } = createUi();
    vm.runInContext('currentTab = "system"; settingsDirty = true; setTab("light")', context);
    assert.equal(vm.runInContext('currentTab', context), 'system');
    assert.equal(vm.runInContext('settingsDirty', context), true);
});

test('Review F15: Allgemeines Neuladen ersetzt keinen offenen Sicherheitsentwurf', async () => {
    const { context, elements } = createUi({ '/api/settings': { multiLightControl: { groups: [] } }, '/api/security/status': {} });
    elements.set('securityTable', { innerHTML: 'offener Entwurf' });
    await vm.runInContext('loadSettings("general")', context);
    assert.equal(elements.get('securityTable').innerHTML, 'offener Entwurf');
});
