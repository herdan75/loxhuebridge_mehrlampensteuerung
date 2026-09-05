require('dotenv').config();

const express = require('express');
const path = require('path');

const logger = require('./lib/logger');
const configManager = require('./lib/config');
const mqttManager = require('./lib/mqtt');
const hueManager = require('./lib/hue');
const loxoneManager = require('./lib/loxone');
const routes = require('./lib/routes');
const auth = require('./lib/auth');
const lifecycle = require('./lib/lifecycle');

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
    try { logger.close(); } catch(e) { console.error("Fehler beim Schließen des Loggers", e); }
    process.exit(1); 
});

process.on('unhandledRejection', (reason) => {
    const text = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error('🔥 [FATAL] UNHANDLED REJECTION:', text);
    try {
        logger.error(`CRASH: ${reason instanceof Error ? reason.message : String(reason)}`, 'SYSTEM');
        logger.close();
    } catch(e) { console.error("Fehler beim Schreiben des Crash-Logs", e); }
    process.exit(1);
});

configManager.load();
hueManager.applyRuntimeConfig();
logger.init(configManager.dataDir, configManager.config.disableLogDisk, configManager.config.debug);

if (logger.dbError) logger.error(`DB Init fehlgeschlagen: ${logger.dbError}. RAM-Modus aktiv.`, 'SYSTEM');

let mqttStartupTimer;
if (configManager.isConfigured) {
    mqttStartupTimer = setTimeout(() => mqttManager.connect(), 500);
} else {
    logger.warn("Setup erforderlich. Bitte Dashboard öffnen.", 'SYSTEM');
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(auth.requireAuth);

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
const httpServer = app.listen(HTTP_PORT, () => {
    console.log(`🚀 loxHueBridge Live auf ${httpServer.address().port}`);
    if (configManager.isConfigured) hueManager.startEventStream(); 
});

const SHUTDOWN_TIMEOUT_MS = 8000;
let shutdownStarted = false;

function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearTimeout(mqttStartupTimer);
    logger.info(`${signal} empfangen, fahre herunter...`, 'SYSTEM');

    const closeLoggerAndExit = (code) => {
        try { logger.close(); } catch (e) { console.error('[SHUTDOWN] Logger:', e.message); }
        process.exit(code);
    };

    const hardExitTimer = setTimeout(() => {
        console.error('[SHUTDOWN] Timeout abgelaufen, beende hart.');
        closeLoggerAndExit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExitTimer.unref?.();

    try { hueManager.close(); } catch (e) { console.error('[SHUTDOWN] Hue:', e.message); }
    try { mqttManager.close?.(); } catch (e) { console.error('[SHUTDOWN] MQTT:', e.message); }
    try { loxoneManager.close?.(); } catch (e) { console.error('[SHUTDOWN] UDP:', e.message); }

    httpServer.close((error) => {
        if (error) console.error('[SHUTDOWN] HTTP:', error.message);
        clearTimeout(hardExitTimer);
        closeLoggerAndExit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
lifecycle.on('shutdown', shutdown);
