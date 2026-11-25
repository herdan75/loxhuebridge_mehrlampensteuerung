const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

// Real Hue implementation; no real network, config files, UDP or MQTT.
module.exports = function fixture(t, overrides = {}) {
    const filename = path.resolve(__dirname, '../../lib/hue.js');
    const calls = { puts: [], gets: [], logs: [] };
    const mapping = overrides.mapping || [{ hue_uuid: 'power', hue_type: 'light', loxone_name: 'power', power_switched: true }];
    const config = { mapping, statusCache: {}, isConfigured: true,
        config: { bridgeIp: 'fixture.invalid', appKey: 'fixture', transitionTime: 0,
            multiLightControl: { bridgeMaxCommandsPerSecond: 100, groups: [] }, ...overrides.config },
        getMappingByLoxoneName: name => mapping.find(item => item.loxone_name === name)
    };
    const axios = Object.assign(async () => {
        if (!overrides.stream) throw new Error('Unexpected event stream in fixture');
        return { data: overrides.stream };
    }, {
        async put(url, payload, options) {
            calls.puts.push({ uuid: url.split('/').pop(), payload, at: Date.now(), options });
            return overrides.put ? overrides.put(calls.puts.length, url, payload) : { data: { data: [], errors: [] } };
        },
        async get(url, options) {
            calls.gets.push({ url, options });
            return overrides.get ? overrides.get(url) : { data: { data: [{ on: { on: true }, dimming: { brightness: 80 } }] } };
        }
    });
    const logger = Object.fromEntries(['debug', 'info', 'warn', 'error', 'hueError'].map(level => [level, (...args) => calls.logs.push({ level, args })]));
    const stubs = { axios, './config': config, './logger': logger, './loxone': { sendToLoxone() {} }, './mqtt': { publish() {} } };
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = name => Object.hasOwn(stubs, name) ? stubs[name] : Module.createRequire(filename)(name);
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    const hue = mod.exports;
    hue.HUE_RESOURCE_DELAYS.light.delayMs = 0;
    hue._internals.setReliabilityTimingsForTests({ verifyDelaysMs: [20, 70], repeatDelayMs: 20 });
    t.after(() => hue.close());
    return { hue, config, calls, entry: mapping[0] };
};
