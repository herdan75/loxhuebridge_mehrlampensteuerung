const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const configManager = require('../lib/config');

test('ConfigManager - Defaults & IsConfigured', (t) => {
    assert.strictEqual(configManager.isConfigured, false);
    assert.strictEqual(configManager.config.debug, false);
    assert.strictEqual(configManager.config.mqttPort, 1883);
});

test('ConfigManager - Load and Save Config', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-config-test-'));
    
    // Override paths for safe testing
    configManager.dataDir = tempDir;
    configManager.configFile = path.join(tempDir, 'config.json');
    configManager.mappingFile = path.join(tempDir, 'mapping.json');
    
    // Setup dummy config
    configManager.config.bridgeIp = '192.168.1.100';
    configManager.config.appKey = 'secretKey123';
    configManager.config.loxoneIp = '192.168.1.50';
    
    configManager.saveConfig();
    
    assert.strictEqual(fs.existsSync(configManager.configFile), true);
    
    // Load it back
    configManager.config.bridgeIp = 'none'; // reset to check if load works
    configManager.load();
    
    assert.strictEqual(configManager.config.bridgeIp, '192.168.1.100');
    assert.strictEqual(configManager.isConfigured, true);
});

test('ConfigManager - Add Detected Item', (t) => {
    configManager.detectedItems = [];
    configManager.addDetectedItem('new_light');
    
    assert.strictEqual(configManager.detectedItems.length, 1);
    assert.strictEqual(configManager.detectedItems[0].name, 'new_light');
    
    // Add same again to test deduplication
    configManager.addDetectedItem('new_light');
    assert.strictEqual(configManager.detectedItems.length, 1);
});
