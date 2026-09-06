const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function until(check, diagnostics = () => '') {
    const deadline = Date.now() + 10000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + diagnostics());
        await delay(20);
    }
}

async function fixture(t, enabled = true, options = {}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-http-'));
    const streams = new Set();
    const puts = [];
    const hue = http.createServer(async (req, res) => {
        assert.equal(req.headers['hue-application-key'], 'test-key');
        if (req.url.startsWith('/eventstream/')) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(': connected\n\n');
            streams.add(res);
            req.on('close', () => streams.delete(res));
            return;
        }
        if (req.method === 'PUT') {
            let body = '';
            for await (const chunk of req) body += chunk;
            puts.push({ url: req.url, payload: JSON.parse(body) });
        }
        const data = req.url === '/clip/v2/resource/light'
            ? [{ id: 'test-light', type: 'light', on: { on: false }, dimming: { brightness: 0 } }] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, errors: [] }));
    });
    await new Promise(resolve => hue.listen(0, '127.0.0.1', resolve));
    const salt = '0123456789abcdef0123456789abcdef';
    const key = await new Promise((resolve, reject) => crypto.pbkdf2('test-password', salt, 210000, 32, 'sha256', (error, value) => error ? reject(error) : resolve(value)));
    fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
        bridgeIp: 'hue.test', appKey: 'test-key', loxoneIp: '127.0.0.1', loxonePort: 7000,
        authEnabled: enabled, authUser: 'admin', authPasswordHash: enabled ? 'pbkdf2$210000$' + salt + '$' + key.toString('hex') : '',
        disableLogDisk: options.disableLogDisk === true, mqttEnabled: false, throttleTime: 0, transitionTime: 0
    }));
    fs.writeFileSync(path.join(temp, 'mapping.json'), JSON.stringify([
        { hue_type: 'light', hue_uuid: 'test-light', loxone_name: 'test_lamp', sync_lox: false,
            multi_sync: options.multiSync === true, multi_sync_group: 'a' }
    ]));
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/bridge-transport.cjs'), 'server.js'], {
        cwd: path.join(__dirname, '..'), windowsHide: true,
        env: { ...process.env, DATA_DIR: temp, HTTP_PORT: '0', LOXHUE_AUTH_TOKEN: '', TEST_HUE_BASE: 'http://127.0.0.1:' + hue.address().port },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        for (const stream of streams) stream.destroy();
        hue.closeAllConnections();
        await new Promise(resolve => hue.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    });
    await until(() => /Live auf (\d+)/.test(output), () => output);
    const port = Number(output.match(/Live auf (\d+)/)[1]);
    await until(() => streams.size === 1, () => output);
    const headers = { authorization: 'Basic ' + Buffer.from('admin:test-password').toString('base64') };
    return {
        child, streams, puts, temp, exited, output: () => output,
        request: (url, options = {}, authenticated = true) => fetch('http://127.0.0.1:' + port + url, {
            ...options, headers: { ...(authenticated ? headers : {}), ...options.headers }, signal: AbortSignal.timeout(5000)
        })
    };
}

test('F15: echter HTTP-Server mit Auth, offenen Loxone-Befehlen, SSE und API-Neustart', { timeout: 20000 }, async t => {
    const app = await fixture(t);
    assert.equal((await app.request('/', {}, false)).status, 401);
    assert.equal((await app.request('/api/settings', {}, false)).status, 401);
    const dashboard = await app.request('/');
    assert.match(await dashboard.text(), /multisync.js/);
    assert.equal((await app.request('/api/settings')).status, 200);
    const security = await (await app.request('/api/security/status')).json();
    assert.deepEqual(Object.keys(security).sort(), ['authEnabled', 'authUser', 'passwordConfigured']);
    const backup = await (await app.request('/api/system/backup?redactSecrets=true')).json();
    assert.ok(!JSON.stringify(backup).includes('pbkdf2$'));
    const rejectedRestore = await app.request('/api/system/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup)
    });
    assert.equal(rejectedRestore.status, 400);
    assert.equal((await app.request('/test_lamp/80', {}, false)).status, 200);
    await until(() => app.puts.length === 1, app.output);
    assert.equal(app.puts[0].payload.dimming.brightness, 80);
    let status = await (await app.request('/api/status')).json();
    assert.equal(status.test_lamp.on, 0, 'PUT acceptance is not a measured state');
    for (const stream of app.streams) {
        stream.write('data: [{"type":"update","data":[{"id":"test-light","on":');
        stream.write('{"on":true},"dimming":{"brightness":80}}]}]\n\n');
    }
    await delay(50);
    status = await (await app.request('/api/status')).json();
    assert.equal(status.test_lamp.on, 1);
    assert.equal(status.test_lamp.bri, 80);
    assert.equal((await app.request('/api/status?x[isBuffer]=no')).status, 200);
    assert.equal((await app.request('/api/system/restart', { method: 'POST' })).status, 200);
    assert.deepEqual(await app.exited, { code: 0, signal: null });
    assert.match(app.output(), /API-Neustart empfangen/);
    await until(() => app.streams.size === 0);
    assert.equal(fs.existsSync(path.join(app.temp, 'logs.db')), true);
});

test('F15: ohne Schutz bleibt HTTP offen, Aktivierung ohne Passwort scheitert, SIGTERM schliesst Prozess', { timeout: 20000 }, async t => {
    const app = await fixture(t, false);
    assert.equal((await app.request('/api/settings', {}, false)).status, 200);
    assert.equal((await app.request('/api/security/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"authEnabled":true}'
    }, false)).status, 400);
    if (process.platform === 'win32') app.child.send('test-sigterm');
    else app.child.kill('SIGTERM');
    assert.deepEqual(await app.exited, { code: 0, signal: null });
    assert.match(app.output(), /SIGTERM empfangen/);
    await until(() => app.streams.size === 0);
});

for (const options of [{}, { multiSync: true }, { multiSync: true, disableLogDisk: true }]) {
    test(`HTTP: Lampendiagnose ohne Debug und Logs nach UI-Speichern ${JSON.stringify(options)}`, { timeout: 20000 }, async t => {
        const app = await fixture(t, true, options);
        assert.equal((await (await app.request('/api/settings')).json()).debug, false);
        assert.deepEqual(await (await app.request('/api/diagnostics/lampen')).json(), []);
        assert.equal((await app.request('/test_lamp/80', {}, false)).status, 200);
        await until(() => app.puts.length === 1, app.output);
        let rows = await (await app.request('/api/diagnostics/lampen')).json();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].befehle, 1, 'diagnostics must not depend on debug');
        assert.equal(rows[0].uuid, 'test-light');
        let logs = await (await app.request('/api/logs')).json();
        assert.ok(!logs.some(row => row.level === 'DEBUG'));

        const saved = await app.request('/api/setup/loxone', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loxoneIp: '127.0.0.1', loxonePort: 7000, debug: true })
        });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).success, true);
        assert.equal((await (await app.request('/api/settings')).json()).debug, true);
        assert.equal((await app.request('/test_lamp/0', {}, false)).status, 200);
        await until(() => app.puts.length === 2, app.output);
        logs = await (await app.request('/api/logs?category=LIGHT')).json();
        assert.ok(logs.some(row => row.level === 'DEBUG' && row.msg === 'IN: /test_lamp/0'));
        assert.ok(logs.some(row => row.level === 'DEBUG' && row.msg.startsWith('OUT -> Hue (test_lamp):')));
        rows = await (await app.request('/api/diagnostics/lampen')).json();
        assert.equal(rows[0].befehle, 2);
        for (const stream of app.streams) {
            stream.write('data: [{"type":"update","data":[{"id":"test-light","on":{"on":false}}]}]\n\n');
        }
        await delay(100);
        rows = await (await app.request('/api/diagnostics/lampen')).json();
        assert.equal(rows[0].bestaetigt, 1);
    });
}
