const test = require('node:test');
const assert = require('node:assert');
const loxoneManager = require('../lib/loxone');
const configManager = require('../lib/config');

test('LoxoneManager - sendToLoxone blockiert ohne IP', (t) => {
    configManager.config.loxoneIp = null;
    // Sollte nicht crashen, Return frühzeitig
    loxoneManager.sendToLoxone('hue.test.on 1');
    assert.ok(true);
});

test('LoxoneManager - sendToLoxone ruft udpClient auf', (t) => {
    configManager.config.loxoneIp = '127.0.0.1';
    configManager.config.loxonePort = 12345;
    
    let sendCalled = false;
    const originalSend = loxoneManager.udpClient.send;
    
    // Mocking
    loxoneManager.udpClient.send = (msg, port, ip, callback) => {
        sendCalled = true;
        assert.strictEqual(msg, 'hue.test.on 1');
        assert.strictEqual(port, 12345);
        assert.strictEqual(ip, '127.0.0.1');
        if(callback) callback(null);
    };
    
    loxoneManager.sendToLoxone('hue.test.on 1');
    assert.strictEqual(sendCalled, true);
    
    // Restore
    loxoneManager.udpClient.send = originalSend; 
    
    // Close the socket to allow the process to exit cleanly after tests
    loxoneManager.udpClient.close();
});
