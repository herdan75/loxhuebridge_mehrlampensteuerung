const dgram = require('dgram');
const logger = require('./logger');
const configManager = require('./config');

class LoxoneManager {
    constructor() {
        this.udpClient = null;
        this.createSocket();
    }

    createSocket() {
        const oldClient = this.udpClient;
        if (oldClient) {
            oldClient.removeAllListeners();
            try { oldClient.close(); } catch (e) { /* already closed */ }
        }

        this.udpClient = dgram.createSocket('udp4');
        this.udpClient.on('error', (err) => {
            logger.error(`UDP Client Error: ${err.message}. Socket wird neu aufgebaut.`, 'SYSTEM');
            this.createSocket();
        });
    }

    sendToLoxone(msg) {
        const config = configManager.config;
        if (!config.loxoneIp || !config.loxonePort) return;
        if (!this.udpClient) this.createSocket();
        try {
            this.udpClient.send(msg, config.loxonePort, config.loxoneIp, (err) => {
                if (err) {
                    logger.error(`UDP Sende-Fehler: ${err.message}. Socket wird neu aufgebaut.`, 'SYSTEM');
                    this.createSocket();
                }
            });
        } catch (e) {
            logger.error(`UDP Catch: ${e.message}`, 'SYSTEM');
            this.createSocket();
        }
    }

    close() {
        if (!this.udpClient) return;
        try {
            this.udpClient.removeAllListeners();
            this.udpClient.close();
        } catch (e) {
            logger.error(`UDP Close: ${e.message}`, 'SYSTEM');
        }
        this.udpClient = null;
    }
}

module.exports = new LoxoneManager();
