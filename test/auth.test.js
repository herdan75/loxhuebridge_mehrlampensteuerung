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
    configManager.isConfigured = true;

    assert.strictEqual(auth._internals.needsAuth(req('/api/settings')), false);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings'), ''), true);
});

test('Auth blockiert API ohne Token und erlaubt korrekten Bearer Token', () => {
    configManager.config.authToken = 'secret';
    configManager.isConfigured = true;

    assert.strictEqual(auth._internals.needsAuth(req('/api/settings')), true);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings'), 'secret'), false);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        headers: { authorization: 'Bearer secret' }
    }), 'secret'), true);
});

test('Auth erlaubt Query Token und Basic Auth', () => {
    configManager.config.authToken = 'secret';
    configManager.isConfigured = true;
    const basic = Buffer.from('user:secret').toString('base64');

    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        query: { token: 'secret' }
    }), 'secret'), true);
    assert.strictEqual(auth._internals.requestHasValidToken(req('/api/settings', {
        headers: { authorization: `Basic ${basic}` }
    }), 'secret'), true);
});

test('Auth nimmt Setup vor Erstkonfiguration und Loxone-Steuer-URLs aus', () => {
    configManager.config.authToken = 'secret';
    configManager.isConfigured = false;
    assert.strictEqual(auth._internals.needsAuth(req('/')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/app.js')), false);

    configManager.isConfigured = true;
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/50')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/wohnzimmer/sunrise/30')), false);
    assert.strictEqual(auth._internals.needsAuth(req('/')), true);
});
