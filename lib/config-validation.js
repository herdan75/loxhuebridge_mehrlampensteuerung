const limits = require('../public/settings-limits');

function invalid(field) {
    return Object.assign(new Error(`Ungültige Konfiguration: ${field}`), { statusCode: 400 });
}

function object(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
}

function integer(value, field, min, max) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(field);
}

function rejectUnsafeKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid('reservierter Schlüssel');
        rejectUnsafeKeys(value[key]);
    }
}

function validateConfig(config) {
    object(config, 'Objekt erwartet');
    rejectUnsafeKeys(config);
    for (const key of ['authEnabled', 'debug', 'mqttEnabled', 'disableLogDisk']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') throw invalid(key);
    }
    for (const key of ['loxonePort', 'mqttPort']) {
        if (config[key] !== undefined) integer(config[key], key, 1, 65535);
    }
    for (const key of ['transitionTime', 'throttleTime', 'eventStreamWatchdogTimeoutSeconds']) {
        if (config[key] !== undefined) integer(config[key], key, limits[key].min, limits[key].max);
    }
    if (config.hueRequestTimeoutMs !== undefined) integer(config.hueRequestTimeoutMs, 'hueRequestTimeoutMs', 1000, 60000);
    for (const key of ['bridgeIp', 'loxoneIp', 'appKey', 'mqttBroker', 'mqttUser', 'mqttPass', 'mqttPrefix', 'authUser', 'authToken', 'authPasswordHash']) {
        const value = config[key];
        if (value === undefined || (value === null && ['bridgeIp', 'loxoneIp', 'appKey', 'mqttBroker'].includes(key))) continue;
        if (typeof value !== 'string' || value.length > 4096) throw invalid(key);
    }
    for (const key of ['bridgeIp', 'loxoneIp']) {
        if (config[key] && !/^[a-zA-Z0-9.:[\]_-]+$/.test(config[key])) throw invalid(key);
    }
    if (config.authUser !== undefined && (!config.authUser.trim() || config.authUser.length > 40 || /[:\x00-\x1f\x7f]/.test(config.authUser))) throw invalid('authUser');
    if (config.authPasswordHash) {
        const match = /^pbkdf2\$(\d+)\$[a-f0-9]{32}\$[a-f0-9]{64}$/i.exec(config.authPasswordHash);
        if (!match) throw invalid('authPasswordHash');
        integer(Number(match[1]), 'authPasswordHash', 100000, 600000);
    }
    if (config.authEnabled === true && !config.authPasswordHash && !config.authToken?.trim() && !process.env.LOXHUE_AUTH_TOKEN?.trim()) {
        throw invalid('Zugriffsschutz benötigt ein Passwort oder Token');
    }
    if (config.multiLightControl !== undefined) {
        const control = config.multiLightControl;
        object(control, 'multiLightControl');
        const validateTiming = (settings, prefix) => {
            for (const key of ['syncWindowMs', 'batchSize', 'batchDelayMs', 'maxCommandsPerSecond', 'sameClusterSpacingMs', 'bridgeMaxCommandsPerSecond']) {
                if (settings[key] !== undefined) integer(settings[key], `${prefix}.${key}`, limits[key].min, limits[key].max);
            }
        };
        validateTiming(control, 'multiLightControl');
        if (control.groups !== undefined) {
            if (!Array.isArray(control.groups) || control.groups.length > 5) throw invalid('multiLightControl.groups');
            const ids = new Set();
            for (const group of control.groups) {
                object(group, 'Gruppe');
                if (!['a', 'b', 'c', 'd', 'e'].includes(group.id) || ids.has(group.id)) throw invalid('Gruppenkennung');
                ids.add(group.id);
                if (group.name !== undefined && (typeof group.name !== 'string' || group.name.length > 40)) throw invalid('Gruppenname');
                validateTiming(group, `Gruppe ${group.id}`);
            }
        }
    }
    return config;
}

module.exports = { validateConfig };
