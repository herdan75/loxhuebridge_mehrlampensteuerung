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

test('Auth bleibt ohne Token deaktiviert', () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = false;
    configManager.config.authPasswordHash = '';
    configManager.isConfigured = true;

    assert.strictEqual(auth._internals.needsAuth(req('/api/settings')), false);
    assert.strictEqual(auth._internals.requestHasValidCredentials(req('/api/settings')), true);
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

test('Auth erlaubt korrekte Basic Auth mit Benutzername und Passwort-Hash', () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = auth.hashPassword('top-secret-pass');
    configManager.isConfigured = true;
    const good = Buffer.from('admin:top-secret-pass').toString('base64');
    const badUser = Buffer.from('user:top-secret-pass').toString('base64');
    const badPassword = Buffer.from('admin:wrong').toString('base64');

    assert.strictEqual(auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${good}` }
    })), true);
    assert.strictEqual(auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${badUser}` }
    })), false);
    assert.strictEqual(auth._internals.requestHasValidCredentials(req('/api/settings', {
        headers: { authorization: `Basic ${badPassword}` }
    })), false);
});

test('Auth nimmt Setup vor Erstkonfiguration und Loxone-Steuer-URLs aus', () => {
    configManager.config.authToken = 'secret';
    configManager.config.authEnabled = true;
    configManager.isConfigured = false;
    assert.strictEqual(auth._internals.needsAuth(req('/')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/app.js')), false);

    configManager.isConfigured = true;
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/50')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/sunrise/30')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/')), true);
});

test('Auth Middleware blockiert Dashboard/API und lässt Loxone-Steuerpfade offen', () => {
    configManager.config.authToken = '';
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = auth.hashPassword('top-secret-pass');
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

    auth.requireAuth(req('/api/settings'), res, () => { nextCalled = true; });
    assert.strictEqual(statusCode, 401);
    assert.strictEqual(nextCalled, false);

    statusCode = null;
    auth.requireAuth(req('/'), res, () => { nextCalled = true; });
    assert.strictEqual(statusCode, 401);

    nextCalled = false;
    auth.requireAuth(req('/wohnzimmer/1'), res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
});
