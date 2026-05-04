const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../lib/logger');

test('Logger - RAM Modus', (t) => {
    // Init RAM mode
    logger.init('/tmp', true, false);
    assert.strictEqual(logger.disableLogDisk, true);
    
    logger.ramLogs = []; // Reset für isolierten Test
    
    logger.info('RAM Info Entry');
    logger.warn('RAM Warn Entry');
    
    const logs = logger.getLogs(10);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].msg, 'RAM Warn Entry'); // reverse sorted
    assert.strictEqual(logs[1].msg, 'RAM Info Entry');
});

test('Logger - SQLite Modus', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-test-'));
    logger.init(tempDir, false, true);
    
    assert.strictEqual(logger.disableLogDisk, false);
    assert.strictEqual(logger.debugEnabled, true);
    
    logger.info('SQLite Info Entry');
    logger.debug('SQLite Debug Entry');
    
    const logs = logger.getLogs(10);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].msg, 'SQLite Debug Entry');
    assert.strictEqual(logs[1].msg, 'SQLite Info Entry');
    
    // Cleanup
    const dbPath = path.join(tempDir, 'logs.db');
    if(fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});
