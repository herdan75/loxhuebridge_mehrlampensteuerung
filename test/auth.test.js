const test = require('node:test');
const assert = require('node:assert');
const configManager = require('../lib/config');
const auth = require('../lib/auth');

function req(path, options = {}) {
    return {
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
        query: options.query || {}
    };
}

test('Auth bleibt ohne Token deaktiviert', async () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = false;
    configManager.config.authPasswordHash = '';
    configManager.isConfigured = true;

    assert.strictEqual(auth._internals.needsAuth(req('/api/settings')), false);
    assert.strictEqual(await auth._internals.requestHasValidCredentials(req('/api/settings')), true);
});

test('Auth blockiert API mit Legacy-Token und erlaubt korrekten Bearer Token', () => {
    configManager.config.authToken = 'secret';
    configManager.config.authEnabled = true;
    configManager.config.authPasswordHash = '';
    configManager.isConfigured = true;

    assert.strictEqual(auth._internals.needsAuth(req('/api/settings')), true);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings'), 'secret'), false);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        headers: { authorization: 'Bearer secret' }
    }), 'secret'), true);
});

test('Auth erlaubt Query Token und Basic Auth', () => {
    configManager.config.authToken = 'secret';
    configManager.config.authEnabled = true;
    configManager.config.authPasswordHash = '';
    configManager.isConfigured = true;
    const basic = Buffer.from('user:secret').toString('base64');

    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        query: { token: 'secret' }
    }), 'secret'), true);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        headers: { authorization: `Basic ${basic}` }
    }), 'secret'), true);
});

test('Auth erlaubt korrekte Basic Auth mit Benutzername und Passwort-Hash', async () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = await auth.hashPassword('top-secret-pass');
    configManager.isConfigured = true;
    const good = Buffer.from('admin:top-secret-pass').toString('base64');
    const badUser = Buffer.from('user:top-secret-pass').toString('base64');
    const badPassword = Buffer.from('admin:wrong').toString('base64');

    assert.strictEqual(await auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${good}` }
    })), true);
    assert.strictEqual(await auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${badUser}` }
    })), false);
    assert.strictEqual(await auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${badPassword}` }
    })), false);
});

test('Aktiver Schutz bleibt auch bei unvollstaendiger Konfiguration erhalten', () => {
    configManager.config.authToken = 'secret';
    configManager.config.authEnabled = true;
    configManager.isConfigured = false;
    for (const path of ['/', '/app.js', '/setup.html', '/api/setup/register', '/api/system/backup', '/api/settings']) {
        assert.strictEqual(auth._internals.needsAuth(req(path)), true, path);
    }

    configManager.isConfigured = true;
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/50')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/sunrise/30')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/')), true);
});

test('Frisches Setup ohne aktivierten Schutz bleibt erreichbar', () => {
    configManager.config.authEnabled = false;
    configManager.config.authToken = '';
    configManager.isConfigured = false;
    assert.strictEqual(auth._internals.needsAuth(req('/')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/api/setup/loxone', { method: 'POST' })), false);
});

test('Auth Middleware blockiert Dashboard/API und lässt Loxone-Steuerpfade offen', async () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = await auth.hashPassword('top-secret-pass');
    configManager.isConfigured = true;

    let statusCode = null;
    const res = {
        set() {},
        status(code) {
            statusCode = code;
            return this;
        },
        send() {
            return this;
        }
    };
    let nextCalled = false;

    await auth.requireAuth(req('/api/settings'), res, () => { nextCalled = true; });
    assert.strictEqual(statusCode, 401);
    assert.strictEqual(nextCalled, false);

    statusCode = null;
    await auth.requireAuth(req('/'), res, () => { nextCalled = true; });
    assert.strictEqual(statusCode, 401);

    nextCalled = false;
    await auth.requireAuth(req('/wohnzimmer/1'), res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
});

test('F10: Passwortberechnung lässt Timer laufen und lehnt extreme Hashparameter ab', async () => {
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const hash = await auth.hashPassword('asynchronous-password');
    assert.strictEqual(timerRan, true);
    assert.strictEqual(await auth.verifyPassword('asynchronous-password', hash), true);
    assert.strictEqual(await auth.verifyPassword('x', hash.replace('$210000$', '$999999999$')), false);
});

test('F10: Credential-Cache gilt nicht nach Benutzer- oder Passwortwechsel', async () => {
    configManager.config.authEnabled = true;
    configManager.config.authToken = '';
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = await auth.hashPassword('cache-password');
    const request = req('/', { headers: { authorization: `Basic ${Buffer.from('admin:cache-password').toString('base64')}` } });
    assert.strictEqual(await auth._internals.requestHasValidCredentials(request), true);
    assert.strictEqual(await auth._internals.requestHasValidCredentials(request), true);
    configManager.config.authUser = 'changed';
    assert.strictEqual(await auth._internals.requestHasValidCredentials(request), false);
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = await auth.hashPassword('replacement-password');
    assert.strictEqual(await auth._internals.requestHasValidCredentials(request), false);
});

test('F10: Fehlversuche sind begrenzt und sperren keine Loxone-Steuerpfade', async () => {
    configManager.isConfigured = true;
    const request = req('/', { headers: { authorization: `Basic ${Buffer.from('wrong:wrong').toString('base64')}` } });
    let status;
    const res = { set() {}, status(code) { status = code; return this; }, send() {} };
    for (let i = 0; i < 10; i++) await auth.requireAuth(request, res, assert.fail);
    await auth.requireAuth(request, res, assert.fail);
    assert.strictEqual(status, 429);
    let passed = false;
    await auth.requireAuth(req('/lampe/1'), res, () => { passed = true; });
    assert.ok(passed);
});

test('Review F01 HTTP: Unvollstaendiges Setup gibt kein Backup ohne Anmeldung frei', async () => {
    const express = require('express');
    const app = express();
    configManager.isConfigured = false;
    configManager.config.authEnabled = true;
    configManager.config.authToken = 'local-test-token';
    app.use(auth.requireAuth);
    app.get('/api/system/backup', (_req, res) => res.json({ appKey: 'test-only-secret' }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/system/backup`;
        const denied = await fetch(url);
        assert.strictEqual(denied.status, 401);
        assert.ok(!(await denied.text()).includes('test-only-secret'));
        const allowed = await fetch(url, { headers: { Authorization: 'Bearer local-test-token' } });
        assert.strictEqual(allowed.status, 200);
        assert.strictEqual((await allowed.json()).appKey, 'test-only-secret');
    } finally {
        await new Promise(resolve => server.close(resolve));
        configManager.config.authToken = '';
    }
});
