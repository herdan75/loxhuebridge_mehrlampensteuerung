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

test('Routes - reservierte Discovery/API Pfade werden nicht als Loxone-Befehl behandelt', () => {
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('api'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('description.xml'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('upnp'), true);
    assert.strictEqual(routes._internals.isReservedDiscoveryPath('wohnzimmer'), false);
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
