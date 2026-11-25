const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('Review F08: Setup bleibt bei Speicherfehler offen und erlaubt erneuten Versuch', async () => {
    const elements = { loxIp: { value: '127.0.0.1' }, loxPort: { value: '7000' }, debugMode: {}, saveError: {} };
    const button = { disabled: false };
    let saved = false, step;
    const context = vm.createContext({
        document: { getElementById: id => elements[id], querySelector: () => button },
        fetch: async () => ({ ok: saved, json: async () => ({ success: saved, error: 'disk full' }) }),
        next: value => { step = value; }
    });
    const html = fs.readFileSync(require.resolve('../public/setup.html'), 'utf8');
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    vm.runInContext('showStep = next', context);
    await vm.runInContext('saveConfig()', context);
    assert.equal(step, undefined);
    assert.match(elements.saveError.textContent, /disk full/);
    assert.equal(button.disabled, false);
    saved = true;
    await vm.runInContext('saveConfig()', context);
    assert.equal(step, 'step4');
});
