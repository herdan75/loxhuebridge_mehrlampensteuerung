const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createUi() {
    let html = '';
    let writes = 0;
    const element = {
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; writes++; }
    };
    const context = vm.createContext({ document: { getElementById: () => element } });
    const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
    vm.runInContext(source, context);
    return {
        getHtml: () => html, getWrites: () => writes,
        render: logs => {
            context.logs = logs;
            vm.runInContext('cachedLogs = logs; renderLogs();', context);
        }
    };
}

test('Loganzeige aktualisiert gleich lange, aber unterschiedliche Eintraege', () => {
    const ui = createUi();
    const row = { category: 'LIGHT', level: 'DEBUG', time: '23:10:00.000', msg: 'IN: /test_lamp/0' };
    ui.render([row]);
    const first = ui.getHtml();
    ui.render([{ ...row, time: '23:10:01.000', msg: 'IN: /test_lamp/1' }]);
    assert.equal(ui.getHtml().length, first.length);
    assert.notEqual(ui.getHtml(), first);
    assert.match(ui.getHtml(), /IN: \/test_lamp\/1/);
});

test('Loganzeige erhaelt identischen Inhalt und maskiert Logtexte', () => {
    const ui = createUi();
    const rows = [{ category: 'LIGHT', level: 'INFO', time: '23:10:00.000', msg: '<script>test</script>' }];
    ui.render(rows);
    ui.render(rows);
    assert.equal(ui.getWrites(), 1);
    assert.match(ui.getHtml(), /&lt;script&gt;test&lt;\/script&gt;/);
    ui.render([]);
    assert.match(ui.getHtml(), /Keine Eintr/);
});
