const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MULTI_SYNC_GROUP_IDS = ['a', 'b', 'c', 'd', 'e'];

function createDefaultMultiSyncGroup(id, overrides = {}) {
    return {
        id,
        name: overrides.name || `Gruppe ${id.toUpperCase()}`,
        syncWindowMs: overrides.syncWindowMs ?? 120,
        batchSize: overrides.batchSize ?? 4,
        batchDelayMs: overrides.batchDelayMs ?? 30,
        maxCommandsPerSecond: overrides.maxCommandsPerSecond ?? 10
    };
}

function createDefaultMultiLightControl(overrides = {}) {
    const legacySettings = {
        syncWindowMs: overrides.syncWindowMs ?? 120,
        batchSize: overrides.batchSize ?? 4,
        batchDelayMs: overrides.batchDelayMs ?? 30,
        maxCommandsPerSecond: overrides.maxCommandsPerSecond ?? 10
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
        this.dataDir = path.join(process.cwd(), 'data');
        this.configFile = path.join(this.dataDir, 'config.json');
        this.mappingFile = path.join(this.dataDir, 'mapping.json');

        if (!fs.existsSync(this.dataDir)) {
            try { fs.mkdirSync(this.dataDir); console.log(`[INIT] Ordner erstellt: ${this.dataDir}`); } 
            catch (e) { console.error(`[FATAL] Konnte Datenordner nicht erstellen: ${e.message}`); }
        }

        this.config = {
            bridgeIp: process.env.HUE_BRIDGE_IP || null,
            appKey: process.env.HUE_APP_KEY || null,
            loxoneIp: process.env.LOXONE_IP || null,
            loxonePort: parseInt(process.env.LOXONE_UDP_PORT || "7000"),
            debug: process.env.DEBUG === 'true',
            transitionTime: 400,
            throttleTime: 100,
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
        try {
            if (fs.existsSync(this.configFile)) {
                const loaded = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.config = {
                    ...this.config,
                    ...loaded,
                    multiLightControl: createDefaultMultiLightControl(loaded.multiLightControl || {})
                };
            }
        } catch (e) { logger.error("Config Load Error: " + e.message, 'SYSTEM'); }

        try {
            if (fs.existsSync(this.mappingFile)) {
                this.mapping = JSON.parse(fs.readFileSync(this.mappingFile, 'utf8')).filter(m => m.loxone_name);
            }
        } catch (e) { this.mapping = []; }
        
        this.isConfigured = !!(this.config.bridgeIp && this.config.appKey && this.config.loxoneIp);
    }

    saveConfig() {
        try { fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 4)); } 
        catch(e) { logger.error(`Fehler beim Speichern der Config: ${e.message}`, 'SYSTEM'); }
    }
    
    saveMapping() {
        try { fs.writeFileSync(this.mappingFile, JSON.stringify(this.mapping, null, 4)); } 
        catch(e) { logger.error(`Fehler beim Speichern des Mappings: ${e.message}`, 'SYSTEM'); }
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

module.exports = new ConfigManager();

