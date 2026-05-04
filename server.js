const express = require('express');
const path = require('path');

const logger = require('./lib/logger');
const configManager = require('./lib/config');
const mqttManager = require('./lib/mqtt');
const hueManager = require('./lib/hue');
const routes = require('./lib/routes');

console.log("🚀 [BOOT] loxHueBridge Prozess gestartet...");

process.on('uncaughtException', (err) => {
    console.error('🔥 [FATAL] UNCAUGHT EXCEPTION:', err);
    try {
        const db = logger.getRawDb();
        if(db) {
            const stmt = db.prepare('INSERT INTO logs (timestamp, level, category, msg) VALUES (?, ?, ?, ?)');
            stmt.run(Date.now(), 'ERROR', 'SYSTEM', `CRASH: ${err.message}`);
        }
    } catch(e) { console.error("Fehler beim Schreiben des Crash-Logs", e); }
    process.exit(1); 
});

configManager.load();
logger.init(configManager.dataDir, configManager.config.disableLogDisk, configManager.config.debug);

if (logger.dbError) logger.error(`DB Init fehlgeschlagen: ${logger.dbError}. RAM-Modus aktiv.`, 'SYSTEM');

if (configManager.isConfigured) {
    setTimeout(() => mqttManager.connect(), 500);
} else {
    logger.warn("Setup erforderlich. Bitte Dashboard öffnen.", 'SYSTEM');
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => { 
    if (req.path.startsWith('/api/') || req.path === '/setup.html') return next(); 
    if (!configManager.isConfigured) { 
        if (req.path === '/') return res.sendFile(path.join(__dirname, 'public', 'setup.html')); 
        return res.redirect('/'); 
    } 
    next(); 
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/', routes);

const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8555");
app.listen(HTTP_PORT, () => { 
    console.log(`🚀 loxHueBridge Live auf ${HTTP_PORT}`); 
    if (configManager.isConfigured) hueManager.startEventStream(); 
});