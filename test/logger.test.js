const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../lib/logger');

test('Logger - RAM Modus erzeugt keine SQLite-Datei', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-ram-test-'));

    logger.init(tempDir, true, false);
    assert.strictEqual(logger.disableLogDisk, true);
    assert.strictEqual(logger.getRawDb(), null);
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'logs.db')), false);

    logger.ramLogs = [];
    logger.info('RAM Info Entry');
    logger.warn('RAM Warn Entry');

    const logs = logger.getLogs(10);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].msg, 'RAM Warn Entry');
    assert.strictEqual(logs[1].msg, 'RAM Info Entry');
});

test('Logger - SQLite Modus', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-test-'));
    t.after(() => logger.closeDb());

    logger.init(tempDir, false, true);

    assert.strictEqual(logger.disableLogDisk, false);
    assert.strictEqual(logger.debugEnabled, true);

    logger.info('SQLite Info Entry');
    logger.debug('SQLite Debug Entry');

    const logs = logger.getLogs(10);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].msg, 'SQLite Debug Entry');
    assert.strictEqual(logs[1].msg, 'SQLite Info Entry');

    logger.closeDb();

    const dbPath = path.join(tempDir, 'logs.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('Logger - pruneLogs kappt SQLite und close schließt die DB', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-prune-test-'));
    const oldMaxDbLogs = logger.MAX_DB_LOGS;
    const oldPruneIntervalWrites = logger.PRUNE_INTERVAL_WRITES;
    t.after(() => {
        logger.MAX_DB_LOGS = oldMaxDbLogs;
        logger.PRUNE_INTERVAL_WRITES = oldPruneIntervalWrites;
        logger.closeDb();
    });

    logger.init(tempDir, false, false);
    logger.MAX_DB_LOGS = 3;
    logger.PRUNE_INTERVAL_WRITES = 1000;

    for (let i = 0; i < 5; i++) logger.info(`Prune Entry ${i}`);

    const deleted = logger.pruneLogs();
    const logs = logger.getLogs(10);
    const indexes = logger.getRawDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_logs_category', 'idx_logs_timestamp')").all();

    assert.ok(deleted >= 2);
    assert.strictEqual(logs.length, 3);
    assert.deepStrictEqual(indexes.map(row => row.name).sort(), ['idx_logs_category', 'idx_logs_timestamp']);

    logger.close();
    assert.strictEqual(logger.getRawDb(), null);
    assert.strictEqual(logger.disableLogDisk, true);
});

test('Logger - updateConfig wechselt von Disk auf RAM ohne offene DB', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-switch-test-'));
    logger.init(tempDir, false, true);
    assert.notStrictEqual(logger.getRawDb(), null);

    logger.updateConfig(true, false);

    assert.strictEqual(logger.disableLogDisk, true);
    assert.strictEqual(logger.debugEnabled, false);
    assert.strictEqual(logger.getRawDb(), null);

    logger.ramLogs = [];
    logger.info('Switched RAM Entry');
    assert.strictEqual(logger.getLogs(10)[0].msg, 'Switched RAM Entry');
});

test('Logger - DB Fehler bleibt RAM-Fallback', () => {
    logger.init(path.join(os.tmpdir(), 'does-not-exist', 'loxhue'), false, false);

    assert.strictEqual(logger.disableLogDisk, true);
    assert.strictEqual(logger.getRawDb(), null);

    logger.ramLogs = [];
    logger.warn('Fallback RAM Entry');
    assert.strictEqual(logger.getLogs(10)[0].msg, 'Fallback RAM Entry');
});
