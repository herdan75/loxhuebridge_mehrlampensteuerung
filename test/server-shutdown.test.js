const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Server - Shutdown schließt HTTP, Hue, MQTT, UDP und Logger', () => {
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert.match(serverJs, /const httpServer = app\.listen/);
    assert.match(serverJs, /process\.on\('SIGTERM'/);
    assert.match(serverJs, /process\.on\('SIGINT'/);
    assert.match(serverJs, /SHUTDOWN_TIMEOUT_MS = 8000/);
    assert.match(serverJs, /httpServer\.close/);
    assert.match(serverJs, /hueManager\.stopEventStream/);
    assert.match(serverJs, /mqttManager\.close/);
    assert.match(serverJs, /loxoneManager\.close/);
    assert.match(serverJs, /logger\.close/);
});
