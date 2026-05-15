const fs = require('fs');
const path = require('path');
const logger = require('./logger');

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
            mqttEnabled: false,
            mqttBroker: null,
            mqttPort: 1883,
            mqttUser: "",
            mqttPass: "",
            mqttPrefix: "loxhue",
            disableLogDisk: false,
            multiLightControl: {
                syncWindowMs: 120,
                batchSize: 4,
                batchDelayMs: 30
            }
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
                    multiLightControl: {
                        ...(this.config.multiLightControl || {}),
                        ...(loaded.multiLightControl || {})
                    }
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
    
    addDetectedItem(name) {
        if(!this.detectedItems.find(d => d.name === name)) {
            this.detectedItems.push({type: 'command', name: name, id: 'cmd_' + name});
            if(this.detectedItems.length > 10) this.detectedItems.shift();
        }
    }
}

module.exports = new ConfigManager();

