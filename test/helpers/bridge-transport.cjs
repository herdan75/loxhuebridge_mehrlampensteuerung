// Test-only transport: real Axios against the isolated loopback Hue simulator.
const Module = require('node:module');
const axios = require('axios');
const originalLoad = Module._load;
function localUrl(value) {
    const url = new URL(value);
    if (url.hostname !== 'hue.test') throw new Error(`Unexpected test destination: ${url.hostname}`);
    return process.env.TEST_HUE_BASE + url.pathname + url.search;
}
const transport = options => axios({ ...options, url: localUrl(options.url), proxy: false });
transport.get = (url, options) => axios.get(localUrl(url), { ...options, proxy: false });
transport.post = (url, payload, options) => axios.post(localUrl(url), payload, { ...options, proxy: false });
transport.put = (url, payload, options) => axios.put(localUrl(url), payload, { ...options, proxy: false });
Module._load = function(request, parent, isMain) {
    return request === 'axios' ? transport : originalLoad(request, parent, isMain);
};
// Windows cannot deliver Unix SIGTERM; exercise the registered handler via IPC.
process.on('message', message => { if (message === 'test-sigterm') process.emit('SIGTERM'); });
