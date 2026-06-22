const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockOptionalDeps(request, parent, isMain) {
    if (request === 'express') {
        return {
            Router: () => {
                const router = {
                    stack: [],
                    get(path, handler) {
                        this.stack.push({ route: { path, stack: [{ handle: handler }] } });
                    },
                    post(path, handler) {
                        this.stack.push({ route: { path, stack: [{ handle: handler }] } });
                    }
                };
                return router;
            }
        };
    }
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
const routes = require('../lib/routes');

function getRouteHandler(path) {
    const layer = routes.stack.find(l => l.route && l.route.path === path);
    return layer.route.stack[0].handle;
}

test('Routes - reservierte Discovery/API Pfade werden nicht als Loxone-Befehl behandelt', () => {
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('api'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('description.xml'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('upnp'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('wohnzimmer'), false);
});

test('Routes - unbekannte Textwerte werden mit HTTP 400 abgelehnt', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'light-1', hue_name: 'Test Lampe', loxone_name: 'test_lampe', hue_type: 'light' }
    ];

    const layer = routes.stack.find(l => l.route && l.route.path === '/:name/:value');
    const handler = layer.route.stack[0].handle;

    let statusCode = null;
    let body = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        send(content) {
            body = content;
            return this;
        }
    };

    await handler({ params: { name: 'test_lampe', value: 'foobar' } }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(body, 'Ungültiger Wert');
});

test('Routes - ungültige Warmweiss-CT-Werte werden mit HTTP 400 abgelehnt', async () => {
    configManager.isConfigured = true;
    configManager.mapping = [
        { hue_uuid: 'light-1', hue_name: 'Test Lampe', loxone_name: 'test_lampe', hue_type: 'light' }
    ];

    const layer = routes.stack.find(l => l.route && l.route.path === '/:name/:value');
    const handler = layer.route.stack[0].handle;

    let statusCode = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        send() {
            return this;
        }
    };

    await handler({ params: { name: 'test_lampe', value: '201001500' } }, res);

    assert.strictEqual(statusCode, 400);
});

test('Routes - Security Status gibt keine Passwortdaten zurück', () => {
    configManager.config.authEnabled = true;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = 'pbkdf2$1$salt$hash';

    const handler = getRouteHandler('/api/security/status');
    let payload = null;
    handler({}, { json: content => { payload = content; } });

    assert.deepStrictEqual(payload, {
        authEnabled: true,
        authUser: 'admin',
        passwordConfigured: true
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'authPasswordHash'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'password'), false);
});

test('Routes - Security Aktivierung ohne Passwort wird abgelehnt', () => {
    configManager.config.authEnabled = false;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = '';

    const handler = getRouteHandler('/api/security/settings');
    let statusCode = null;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(content) {
            payload = content;
            return this;
        }
    };

    handler({ body: { authEnabled: true, authUser: 'admin' } }, res);

    assert.strictEqual(statusCode, 400);
    assert.strictEqual(payload.success, false);
    assert.strictEqual(configManager.config.authEnabled, false);
});

test('Routes - Security speichert Passwort nur als Hash', () => {
    configManager.config.authEnabled = false;
    configManager.config.authUser = 'admin';
    configManager.config.authPasswordHash = '';

    const handler = getRouteHandler('/api/security/settings');
    let payload = null;
    const res = {
        json(content) {
            payload = content;
            return this;
        }
    };

    handler({ body: { authEnabled: true, authUser: 'admin', password: 'top-secret-pass' } }, res);

    assert.strictEqual(payload.success, true);
    assert.strictEqual(configManager.config.authEnabled, true);
    assert.notStrictEqual(configManager.config.authPasswordHash, 'top-secret-pass');
    assert.match(configManager.config.authPasswordHash, /^pbkdf2\$/);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'authPasswordHash'), false);
});

test('Routes - Backup Redaction entfernt Zugangsdaten', () => {
    const redacted = routes._internals.redactConfigSecrets({
        bridgeIp: '192.168.1.10',
        appKey: 'hue-secret',
        mqttUser: 'mqtt-user',
        mqttPass: 'mqtt-secret',
        authToken: 'auth-secret',
        authPasswordHash: 'pbkdf2$1$salt$hash'
    });

    assert.strictEqual(redacted.bridgeIp, '192.168.1.10');
    assert.strictEqual(redacted.mqttUser, 'mqtt-user');
    assert.strictEqual(redacted.appKey, '***');
    assert.strictEqual(redacted.mqttPass, '***');
    assert.strictEqual(redacted.authToken, '***');
    assert.strictEqual(redacted.authPasswordHash, '***');
});

test('Routes - XML Exports escape special characters', async (t) => {
    // Setup dummy mapping with special characters
    configManager.mapping = [
        {
            hue_uuid: 'uuid-1',
            hue_name: 'Wohnzimmer & Esszimmer "Licht" <1>',
            loxone_name: 'wz_esszimmer',
            hue_type: 'light'
        },
        {
            hue_uuid: 'uuid-2',
            hue_name: 'Sensor & Taster',
            loxone_name: 'sensor&taster',
            hue_type: 'sensor'
        }
    ];

    // Find route handlers directly from the Express Router stack to avoid network binding (EPERM)
    const layerOutputs = routes.stack.find(l => l.route && l.route.path === '/api/download/outputs');
    const handlerOutputs = layerOutputs.route.stack[0].handle;

    const layerInputs = routes.stack.find(l => l.route && l.route.path === '/api/download/inputs');
    const handlerInputs = layerInputs.route.stack[0].handle;

    // Test outputs export handler
    let outputsXml = '';
    let outputsHeaders = {};
    const resOutputs = {
        set: (k, v) => { outputsHeaders[k] = v; },
        send: (content) => { outputsXml = content; }
    };

    handlerOutputs({ query: {} }, resOutputs);

    assert.strictEqual(outputsHeaders['Content-Type'], 'text/xml');
    assert.strictEqual(outputsXml.includes('&amp;'), true);
    assert.strictEqual(outputsXml.includes('&quot;'), true);
    assert.strictEqual(outputsXml.includes('&lt;1&gt;'), true);
    assert.strictEqual(outputsXml.includes('Wohnzimmer & Esszimmer'), false);

    // Test inputs export handler
    let inputsXml = '';
    let inputsHeaders = {};
    const resInputs = {
        set: (k, v) => { inputsHeaders[k] = v; },
        send: (content) => { inputsXml = content; }
    };

    handlerInputs({ query: {} }, resInputs);

    assert.strictEqual(inputsHeaders['Content-Type'], 'text/xml');
    assert.strictEqual(inputsXml.includes('VirtualInUdpCmd'), true);
    assert.strictEqual(inputsXml.includes('&amp;'), true);
    assert.strictEqual(inputsXml.includes('Sensor & Taster'), false);
});
