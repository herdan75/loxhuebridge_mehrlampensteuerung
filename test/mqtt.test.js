const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const clients = [];
const original = Module._load;
Module._load = function(request, parent, main) {
    if (request === 'mqtt') return { connect(url, options) {
        const client = new EventEmitter();
        client.options = options;
        client.ended = false;
        client.end = () => { client.ended = true; };
        clients.push(client);
        return client;
    } };
    return original(request, parent, main);
};
const config = require('../lib/config');
const mqtt = require('../lib/mqtt');
Module._load = original;
test.after(() => mqtt.close());

test('Review F13: Alte Client-Ereignisse beenden keine neue Verbindung', () => {
    config.config = { ...config.config, mqttEnabled: true, mqttBroker: 'fixture-one' };
    mqtt.connect();
    const first = mqtt.client;
    config.config.mqttBroker = 'fixture-two';
    mqtt.connect();
    const second = mqtt.client;
    first.emit('error', new Error('Not authorized'));
    assert.equal(mqtt.client, second);
    assert.equal(second.ended, false);
    config.config.debug = true;
    mqtt.connect();
    assert.equal(mqtt.client, second);
    assert.equal(clients.length, 2);
});

test('Review F14: MQTT-Passwort bleibt einschliesslich Leerzeichen unveraendert', () => {
    config.config.mqttPass = ' password ';
    mqtt.connect();
    assert.equal(mqtt.client.options.password, ' password ');
});
