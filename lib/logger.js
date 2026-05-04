const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

class Logger {
    constructor() {
        this.db = null;
        this.insertLogStmt = null;
        this.dbError = null;
        this.ramLogs = [];
        this.MAX_RAM_LOGS = 500;
        this.disableLogDisk = false;
        this.debugEnabled = false;
    }

    init(dataDir, disableLogDisk, debugEnabled) {
        this.disableLogDisk = disableLogDisk;
        this.debugEnabled = debugEnabled;
        const DB_FILE = path.join(dataDir, 'logs.db');
        try {
            this.db = new DatabaseSync(DB_FILE);
            this.db.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, level TEXT, category TEXT, msg TEXT)`);
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.insertLogStmt = this.db.prepare('INSERT INTO logs (timestamp, level, category, msg) VALUES (?, ?, ?, ?)');
        } catch (e) {
            console.error("⚠️ [DB ERROR] RAM-Modus aktiv. Grund:", e.message);
            this.dbError = e.message;
            this.disableLogDisk = true; 
        }
    }

    updateConfig(disableLogDisk, debugEnabled) {
        this.disableLogDisk = disableLogDisk;
        this.debugEnabled = debugEnabled;
    }

    getTime() {
        const now = new Date();
        return now.toLocaleTimeString('de-DE', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    }

    addToLogBuffer(level, msg, category = 'SYSTEM') {
        const timeStr = this.getTime();
        const timestamp = Date.now();
        if (level === 'ERROR') console.error(`[${timeStr}] [${category}] ${msg}`);
        else console.log(`[${timeStr}] [${category}] ${msg}`);
        
        if (this.disableLogDisk || !this.insertLogStmt) {
            this.ramLogs.push({ id: timestamp, timestamp, level, category, msg });
            if (this.ramLogs.length > this.MAX_RAM_LOGS) this.ramLogs.shift();
        } else {
            try { this.insertLogStmt.run(timestamp, level, category, msg); } catch(e) { console.error("DB Write Error:", e); }
        }
    }

    info(m, cat='SYSTEM') { this.addToLogBuffer('INFO', m, cat); }
    success(m, cat='SYSTEM') { this.addToLogBuffer('SUCCESS', m, cat); }
    warn(m, cat='SYSTEM') { this.addToLogBuffer('WARN', m, cat); }
    error(m, cat='SYSTEM') { this.addToLogBuffer('ERROR', m, cat); }
    debug(m, cat='SYSTEM') { if(this.debugEnabled) this.addToLogBuffer('DEBUG', m, cat); }
    hueError(e, cat='SYSTEM') {
        const s = e.response ? e.response.status : 'Net';
        if (s === 429) { this.warn(`HUE RATE LIMIT (429)`, cat); return; }
        const d = e.response ? JSON.stringify(e.response.data) : e.message;
        this.error(`HUE ERR ${s}: ${d}`, cat);
    }

    getLogs(limit, categoryFilter) {
        if (this.disableLogDisk || !this.db) {
            let res = [...this.ramLogs];
            if (categoryFilter && categoryFilter !== 'all') res = res.filter(l => l.category === categoryFilter);
            return res.reverse().slice(0, limit);
        } else {
            try {
                let q = "SELECT * FROM logs";
                let params = [];
                if (categoryFilter && categoryFilter !== 'all') { q += " WHERE category = ?"; params.push(categoryFilter); }
                q += " ORDER BY id DESC LIMIT ?"; params.push(limit);
                const query = this.db.prepare(q);
                return query.all(...params);
            } catch(e) {
                console.error("DB Read Error", e);
                return [];
            }
        }
    }

    getRawDb() {
        return this.db;
    }
}

module.exports = new Logger();
