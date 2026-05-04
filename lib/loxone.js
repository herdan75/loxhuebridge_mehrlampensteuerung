const dgram = require('dgram');
const logger = require('./logger');
const configManager = require('./config');

class LoxoneManager {
    constructor() {
        this.udpClient = dgram.createSocket('udp4');
        this.udpClient.on('error', (err) => {
            logger.error(`UDP Client Error: ${err.message}`, 'SYSTEM');
        });
    }

    sendToLoxone(msg) {
        const config = configManager.config;
        if (!config.loxoneIp || !config.loxonePort) return;
        try {
            this.udpClient.send(msg, config.loxonePort, config.loxoneIp, (err) => {
                if (err) logger.error(`UDP Sende-Fehler: ${err.message}`, 'SYSTEM');
            });
        } catch (e) {
            logger.error(`UDP Catch: ${e.message}`, 'SYSTEM');
        }
    }
}

module.exports = new LoxoneManager();
