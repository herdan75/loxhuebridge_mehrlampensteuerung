const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { writeAtomic, removeFile } = require('./persistence');

const MULTI_SYNC_GROUP_IDS = ['a', 'b', 'c', 'd', 'e'];

function resolveDataDir() {
    return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function createDefaultMultiSyncGroup(id, overrides = {}) {
    return {
        id,
        name: overrides.name || `Gruppe ${id.toUpperCase()}`,
        syncWindowMs: overrides.syncWindowMs ?? 120,
        batchSize: overrides.batchSize ?? 4,
        batchDelayMs: overrides.batchDelayMs ?? 30,
        maxCommandsPerSecond: overrides.maxCommandsPerSecond ?? 10,
        sameClusterSpacingMs: overrides.sameClusterSpacingMs ?? 10
    };
}

function createDefaultMultiLightControl(overrides = {}) {
    const legacySettings = {
        syncWindowMs: overrides.syncWindowMs ?? 120,
        batchSize: overrides.batchSize ?? 4,
        batchDelayMs: overrides.batchDelayMs ?? 30,
        maxCommandsPerSecond: overrides.maxCommandsPerSecond ?? 10,
        sameClusterSpacingMs: overrides.sameClusterSpacingMs ?? 10
    };

    return {
        ...legacySettings,
        bridgeMaxCommandsPerSecond: overrides.bridgeMaxCommandsPerSecond ?? 30,
        groups: MULTI_SYNC_GROUP_IDS.map(id => {
            const groupOverride = Array.isArray(overrides.groups)
                ? overrides.groups.find(group => group && group.id === id)
                : null;

            return createDefaultMultiSyncGroup(id, groupOverride || (id === 'a' ? legacySettings : {}));
        })
    };
}

class ConfigManager {
    constructor() {
        this.dataDir = resolveDataDir();
        this.configFile = path.join(this.dataDir, 'config.json');
        this.mappingFile = path.join(this.dataDir, 'mapping.json');

        if (!fs.existsSync(this.dataDir)) {
            try { fs.mkdirSync(this.dataDir, { recursive: true }); console.log(`[INIT] Ordner erstellt: ${this.dataDir}`); }
            catch (e) { console.error(`[FATAL] Konnte Datenordner nicht erstellen: ${e.message}`); }
        }

        this.config = {
            bridgeIp: process.env.HUE_BRIDGE_IP || null,
            appKey: process.env.HUE_APP_KEY || null,
            authEnabled: !!process.env.LOXHUE_AUTH_TOKEN,
            authUser: "admin",
            authPasswordHash: "",
            authToken: process.env.LOXHUE_AUTH_TOKEN || "",
            loxoneIp: process.env.LOXONE_IP || null,
            loxonePort: parseInt(process.env.LOXONE_UDP_PORT || "7000"),
            debug: process.env.DEBUG === 'true',
            transitionTime: 400,
            throttleTime: 100,
            hueRequestTimeoutMs: 5000,
            eventStreamWatchdogTimeoutSeconds: 600,
            mqttEnabled: false,
            mqttBroker: null,
            mqttPort: 1883,
            mqttUser: "",
            mqttPass: "",
            mqttPrefix: "loxhue",
            disableLogDisk: false,
            multiLightControl: createDefaultMultiLightControl()
        };
        
        this.mapping = [];
        this.isConfigured = false;
        
        this.detectedItems = [];
        this.statusCache = {};
    }

    load() {
        this.recoverRestore();
        try {
            if (fs.existsSync(this.configFile)) {
                const loaded = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                if (loaded.authEnabled === undefined && loaded.authToken) loaded.authEnabled = true;
                this.config = {
                    ...this.config,
                    ...loaded,
                    multiLightControl: createDefaultMultiLightControl(loaded.multiLightControl || {})
                };
            }
        } catch (e) { logger.error("Config Load Error: " + e.message, 'SYSTEM'); throw e; }

        try {
            if (fs.existsSync(this.mappingFile)) {
                this.mapping = JSON.parse(fs.readFileSync(this.mappingFile, 'utf8')).filter(m => m.loxone_name);
            }
        } catch (e) { logger.error("Mapping Load Error: " + e.message, 'SYSTEM'); throw e; }
        
        this.isConfigured = !!(this.config.bridgeIp && this.config.appKey && this.config.loxoneIp);
    }

    saveConfig(candidate = this.config) {
        this.recoverRestore();
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Ungültige Konfiguration');
        writeAtomic(this.configFile, JSON.stringify(candidate, null, 4));
        this.config = candidate;
    }
    
    saveMapping(candidate = this.mapping) {
        this.recoverRestore();
        if (!Array.isArray(candidate) || candidate.some(item => !item || typeof item.loxone_name !== 'string')) throw new Error('Ungültiges Mapping');
        writeAtomic(this.mappingFile, JSON.stringify(candidate, null, 4));
        this.mapping = candidate;
    }

    recoverRestore() {
        const journal = path.join(this.dataDir, '.restore-pending.json');
        if (!fs.existsSync(journal)) return;
        const previous = JSON.parse(fs.readFileSync(journal, 'utf8'));
        if (previous.version !== 1 || !['config', 'mapping'].every(key => previous[key] === null || typeof previous[key] === 'string')) {
            throw new Error('Ungültiges Restore-Journal');
        }
        for (const [key, file] of [['config', this.configFile], ['mapping', this.mappingFile]]) {
            if (previous[key] === null) removeFile(file);
            else writeAtomic(file, previous[key]);
        }
        removeFile(journal);
    }

    restore(config, mapping) {
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            !Array.isArray(mapping) || mapping.some(item => !item || typeof item.loxone_name !== 'string')) {
            throw new Error('Ungültiges Backup-Format');
        }
        const configText = JSON.stringify(config, null, 4);
        const mappingText = JSON.stringify(mapping, null, 4);
        this.recoverRestore();
        const journal = path.join(this.dataDir, '.restore-pending.json');
        const readPrevious = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        const previous = { version: 1, config: readPrevious(this.configFile), mapping: readPrevious(this.mappingFile) };
        // A remaining journal means the two-file transaction must be rolled back on startup.
        writeAtomic(journal, JSON.stringify(previous));
        try {
            writeAtomic(this.configFile, configText);
            writeAtomic(this.mappingFile, mappingText);
            removeFile(journal);
        } catch (error) {
            try { this.recoverRestore(); } catch (recoveryError) { error.recoveryError = recoveryError; }
            throw error;
        }
        this.config = config;
        this.mapping = mapping;
    }
    
    getMappingByLoxoneName(name) {
        return this.mapping.find(m => m.loxone_name === name);
    }

    getDefaultMultiLightControl(overrides = {}) {
        return createDefaultMultiLightControl(overrides);
    }
    
    addDetectedItem(name) {
        if(!this.detectedItems.find(d => d.name === name)) {
            this.detectedItems.push({type: 'command', name: name, id: 'cmd_' + name});
            if(this.detectedItems.length > 10) this.detectedItems.shift();
        }
    }
}

const configManager = new ConfigManager();

module.exports = configManager;
module.exports.resolveDataDir = resolveDataDir;

