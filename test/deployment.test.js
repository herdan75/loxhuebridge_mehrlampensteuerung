const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('F14: Docker kopiert ausschliesslich Anwendungscode und schliesst Daten aus', () => {
    const root = path.join(__dirname, '..');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const sources = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+/gm)].map(match => match[1]);
    assert.deepEqual(sources, ['package*.json', 'lib/', 'public/', 'server.js']);
    const ignores = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
    for (const entry of ['data/', 'backups/', '.codex/', '**/config.json', '**/mapping.json']) {
        assert.ok(ignores.includes(entry), entry);
    }
});

test('F14: Update einer alten getrackten Logdatenbank erhaelt gesicherte Laufzeitdaten', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loxhue-upgrade-'));
    const repo = path.join(temp, 'repo');
    const backup = path.join(temp, 'backup');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
    try {
        git('init');
        fs.writeFileSync(path.join(repo, 'data/logs.db'), 'old-image-log');
        git('add', '.');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'old');
        const old = git('rev-parse', 'HEAD');
        git('rm', 'data/logs.db');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'untrack');
        const next = git('rev-parse', 'HEAD');
        git('switch', '--detach', old);
        fs.writeFileSync(path.join(repo, 'data/logs.db'), 'user-live-logs');
        fs.writeFileSync(path.join(repo, 'data/config.json'), '{"bridgeIp":"preserved"}');
        fs.cpSync(path.join(repo, 'data'), backup, { recursive: true });
        git('restore', '--source=HEAD', '--worktree', '--', 'data/logs.db');
        git('merge', '--ff-only', next);
        fs.cpSync(backup, path.join(repo, 'data'), { recursive: true });
        assert.equal(fs.readFileSync(path.join(repo, 'data/logs.db'), 'utf8'), 'user-live-logs');
        assert.equal(fs.readFileSync(path.join(repo, 'data/config.json'), 'utf8'), '{"bridgeIp":"preserved"}');
        assert.equal(git('ls-files', 'data/logs.db'), '');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
