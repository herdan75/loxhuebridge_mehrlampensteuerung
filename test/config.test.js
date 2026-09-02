const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const configManager = require('../lib/config');

test('ConfigManager - Defaults & IsConfigured', (t) => {
    assert.strictEqual(configManager.isConfigured, false);
    assert.strictEqual(configManager.config.debug, false);
    assert.strictEqual(configManager.config.mqttPort, 1883);
    assert.strictEqual(configManager.config.hueRequestTimeoutMs, 5000);
    assert.strictEqual(configManager.config.multiLightControl.groups[0].sameClusterSpacingMs, 10);
});

test('ConfigManager - dataDir ist unabhängig von process.cwd()', () => {
    const repoRoot = path.join(__dirname, '..');
    const script = [
        `process.chdir(${JSON.stringify(os.tmpdir())})`,
        `const cfg = require(${JSON.stringify(path.join(repoRoot, 'lib', 'config.js'))})`,
        'console.log(cfg.dataDir)'
    ].join(';');

    const output = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, DATA_DIR: '' }
    }).toString('utf8').trim().split(/\r?\n/).pop();

    assert.strictEqual(path.normalize(output), path.normalize(path.join(repoRoot, 'data')));
});

test('ConfigManager - DATA_DIR Override wird rekursiv angelegt', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-data-dir-test-'));
    const dataDir = path.join(tempDir, 'nested', 'data');
    const repoRoot = path.join(__dirname, '..');
    const script = [
        `const cfg = require(${JSON.stringify(path.join(repoRoot, 'lib', 'config.js'))})`,
        'console.log(cfg.dataDir)'
    ].join(';');

    const output = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, DATA_DIR: dataDir }
    }).toString('utf8').trim().split(/\r?\n/).pop();

    assert.strictEqual(path.normalize(output), path.normalize(dataDir));
    assert.strictEqual(fs.existsSync(dataDir), true);
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
