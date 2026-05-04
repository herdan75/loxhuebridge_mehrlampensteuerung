const mqtt = require('mqtt');
const logger = require('./logger');
const configManager = require('./config');

class MqttManager {
    constructor() {
        this.client = null;
    }

    connect() {
        const config = configManager.config;
        if (this.client) { 
            try { this.client.end(); } 
            catch(e) { logger.error("MQTT Disconnect Fehler: " + e.message, "SYSTEM"); } 
            this.client = null; 
        }
        
        if (!config.mqttEnabled || !config.mqttBroker) return;
        
        const brokerUrl = `mqtt://${config.mqttBroker}:${config.mqttPort || 1883}`;
        logger.info(`Verbinde zu MQTT Broker: ${brokerUrl} ...`, 'SYSTEM');
        
        const safeStr = (s) => (s && typeof s === 'string') ? s.trim() : "";
        const options = { clientId: 'loxhue_' + Math.random().toString(16).substr(2, 8), reconnectPeriod: 5000 };
        
        const user = safeStr(config.mqttUser);
        const pass = safeStr(config.mqttPass);
        if (user.length > 0) options.username = user;
        if (pass.length > 0) options.password = pass;

        try {
            this.client = mqtt.connect(brokerUrl, options);
            this.client.on('connect', () => { logger.success("MQTT Verbunden!", 'SYSTEM'); });
            this.client.on('error', (err) => { 
                logger.error(`MQTT Fehler: ${err.message}`, 'SYSTEM');
                if (err.message && (err.message.includes('Not authorized') || err.message.includes('Connection refused'))) {
                    logger.warn("MQTT Auth fehlgeschlagen. Stoppe Verbindung.", 'SYSTEM');
                    if(this.client) { this.client.end(); this.client = null; }
                }
            });
            this.client.on('offline', () => {});
        } catch (e) { logger.error(`MQTT Init Fehler: ${e.message}`, 'SYSTEM'); }
    }

    publish(topic, message) {
        if (!this.client || !this.client.connected) return;
        const config = configManager.config;
        const prefix = config.mqttPrefix ? config.mqttPrefix + '/' : 'loxhue/';
        const fullTopic = prefix + topic;
        try {
            this.client.publish(fullTopic, String(message));
        } catch(e) {
            logger.error(`MQTT Publish Error: ${e.message}`, 'SYSTEM');
        }
    }
}

module.exports = new MqttManager();
