const express = require('express');
const axios = require('axios');
const path = require('path');
const os = require('os');
const pjson = require('../package.json');

const configManager = require('./config');
const logger = require('./logger');
const mqttManager = require('./mqtt');
const hueManager = require('./hue');
const auth = require('./auth');

const router = express.Router();

const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8555");

function parseNumberSetting(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function parseBooleanSetting(value, fieldName) {
    if (typeof value !== 'boolean') {
        const error = new Error(`${fieldName} muss boolean sein`);
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function parseOptionalBooleanSetting(value, fieldName, fallback = false) {
    if (value === undefined) return fallback;
    return parseBooleanSetting(value, fieldName);
}

function parseSyncOffsetSetting(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        const error = new Error('sync_offset_ms muss eine Zahl sein');
        error.statusCode = 400;
        throw error;
    }

    const rounded = Math.round(parsed / 10) * 10;
    return Math.max(-500, Math.min(1000, rounded));
}

function parseSyncClusterSetting(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().substring(0, 40);
}

function parseMultiSyncGroupSetting(value) {
    const group = String(value || 'a').toLowerCase();
    if (!['a', 'b', 'c', 'd', 'e'].includes(group)) {
        const error = new Error('multi_sync_group muss a-e sein');
        error.statusCode = 400;
        throw error;
    }
    return group;
}

function sanitizeMappingSettings(body = {}) {
    const verifyState = parseOptionalBooleanSetting(body.verify_state, 'verify_state', false);
    const splitOn = parseOptionalBooleanSetting(body.split_on, 'split_on', false);
    const repeatCommand = parseOptionalBooleanSetting(body.repeat_command, 'repeat_command', false);
    if ([verifyState, splitOn, repeatCommand].filter(Boolean).length > 1) {
        const error = new Error('Funkmaßnahme muss eindeutig sein');
        error.statusCode = 400;
        throw error;
    }

    return {
        sync_lox: parseBooleanSetting(body.sync_lox, 'sync_lox'),
        ignore_dynamics: parseBooleanSetting(body.ignore_dynamics, 'ignore_dynamics'),
        multi_sync: parseBooleanSetting(body.multi_sync, 'multi_sync'),
        multi_sync_group: parseMultiSyncGroupSetting(body.multi_sync_group),
        sync_cluster: parseSyncClusterSetting(body.sync_cluster),
        sync_offset_ms: parseSyncOffsetSetting(body.sync_offset_ms),
        verify_state: verifyState,
        split_on: splitOn,
        repeat_command: repeatCommand
    };
}

function isReservedDiscoveryPath(name) {
    const normalized = String(name || '').toLowerCase();
    return ['api', 'description.xml', 'upnp', 'ssdp', 'xml'].includes(normalized);
}

function rejectReservedDiscoveryPath(name, res) {
    if (!isReservedDiscoveryPath(name)) return false;
    return res.status(404).send('Not Found');
}

function isInvalidLoxoneValueError(error) {
    return error?.code === 'INVALID_LOXONE_VALUE' || error?.statusCode === 400;
}

function sendInvalidLoxoneValue(name, value, res) {
    logger.warn(`Ungültiger Loxone-Wert ignoriert: /${name}/${value}`, 'LIGHT');
    return res.status(400).send('Ungültiger Wert');
}

function getServerIp() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        for (const alias of interfaces[devName]) {
            if (alias.family === 'IPv4' && !alias.internal) return alias.address;
        }
    }
    return '127.0.0.1';
}

router.get('/api/setup/discover', async (req, res) => { 
    try { const r = await axios.get('https://discovery.meethue.com/'); res.json(r.data); } 
    catch (e) { res.status(500).json({}); } 
});

router.post('/api/setup/register', async (req, res) => { 
    try { 
        const r = await axios.post(`https://${req.body.ip}/api`, { devicetype: "loxHueBridge" }, { httpsAgent: hueManager.httpsAgent }); 
        if(r.data[0].success) { 
            configManager.config.bridgeIp = req.body.ip; 
            configManager.config.appKey = r.data[0].success.username; 
            configManager.saveConfig();
            configManager.load(); // reload to set isConfigured
            return res.json({success:true}); 
        } 
        res.json({success:false, error: r.data[0].error.description}); 
    } catch(e) { res.status(500).json({error:e.message}); } 
});

router.post('/api/setup/loxone', (req, res) => { 
    const c = configManager.config;
    c.loxoneIp = req.body.loxoneIp;
    c.loxonePort = parseNumberSetting(req.body.loxonePort, c.loxonePort || 7000, 1, 65535);
    c.debug = !!req.body.debug;
    if(req.body.transitionTime!==undefined) c.transitionTime = parseNumberSetting(req.body.transitionTime, c.transitionTime || 400, 0, 60000);
    if(req.body.eventStreamWatchdogTimeoutSeconds!==undefined) {
        c.eventStreamWatchdogTimeoutSeconds = parseNumberSetting(req.body.eventStreamWatchdogTimeoutSeconds, c.eventStreamWatchdogTimeoutSeconds || 600, 60, 3600);
    }
    if(req.body.throttleTime!==undefined) {
        c.throttleTime = parseNumberSetting(req.body.throttleTime, c.throttleTime || 100, 0, 5000);
    }
    if(req.body.mqttEnabled !== undefined) c.mqttEnabled = !!req.body.mqttEnabled;
    if(req.body.mqttBroker !== undefined) c.mqttBroker = req.body.mqttBroker;
    if(req.body.mqttPort !== undefined) c.mqttPort = parseNumberSetting(req.body.mqttPort, c.mqttPort || 1883, 1, 65535);
    if(req.body.mqttUser !== undefined) c.mqttUser = req.body.mqttUser;
    if(req.body.mqttPassClear === true) c.mqttPass = '';
    else if(req.body.mqttPass !== undefined && String(req.body.mqttPass).length > 0) c.mqttPass = req.body.mqttPass;
    if(req.body.mqttPrefix !== undefined) c.mqttPrefix = req.body.mqttPrefix;
    if(req.body.disableLogDisk !== undefined) {
        c.disableLogDisk = !!req.body.disableLogDisk;
        logger.updateConfig(c.disableLogDisk, c.debug);
    }
    if(req.body.multiLightControl !== undefined) {
        const currentMulti = configManager.config.multiLightControl || configManager.getDefaultMultiLightControl();
        const submittedGroups = Array.isArray(req.body.multiLightControl.groups) ? req.body.multiLightControl.groups : [];
        const groups = (currentMulti.groups || configManager.getDefaultMultiLightControl().groups).map(group => {
            const submitted = submittedGroups.find(item => item && item.id === group.id) || {};

            return {
                id: group.id,
                name: typeof submitted.name === 'string' && submitted.name.trim() ? submitted.name.trim().substring(0, 40) : group.name,
                syncWindowMs: parseNumberSetting(submitted.syncWindowMs, group.syncWindowMs || 120, 10, 2000),
                batchSize: parseNumberSetting(submitted.batchSize, group.batchSize || 4, 1, 50),
                batchDelayMs: parseNumberSetting(submitted.batchDelayMs, group.batchDelayMs || 30, 0, 2000),
                maxCommandsPerSecond: parseNumberSetting(submitted.maxCommandsPerSecond, group.maxCommandsPerSecond || 10, 1, 50),
                sameClusterSpacingMs: parseNumberSetting(submitted.sameClusterSpacingMs, group.sameClusterSpacingMs ?? 10, 0, 50)
            };
        });

        c.multiLightControl = {
            ...currentMulti,
            syncWindowMs: groups[0]?.syncWindowMs || 120,
            batchSize: groups[0]?.batchSize || 4,
            batchDelayMs: groups[0]?.batchDelayMs || 30,
            maxCommandsPerSecond: groups[0]?.maxCommandsPerSecond || 10,
            sameClusterSpacingMs: groups[0]?.sameClusterSpacingMs ?? 10,
            bridgeMaxCommandsPerSecond: parseNumberSetting(req.body.multiLightControl.bridgeMaxCommandsPerSecond, currentMulti.bridgeMaxCommandsPerSecond || 30, 1, 100),
            groups
        };
    }
    
    configManager.saveConfig(); 
    configManager.load();
    hueManager.applyRuntimeConfig();
    mqttManager.connect(); 
    hueManager.startEventStream(); 
    res.json({success:true}); 
});

function escapeXml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

router.get('/api/download/outputs', (req, res) => {
    const filterNames = req.query.names ? req.query.names.split(',') : null;
    let lights = configManager.mapping.filter(m => m.hue_type === 'light' || m.hue_type === 'group');
    if (filterNames) lights = lights.filter(m => filterNames.includes(m.loxone_name));
    let xml = `<?xml version="1.0" encoding="utf-8"?>\n<VirtualOut Title="LoxHueBridge Lights" Address="http://${getServerIp()}:${HTTP_PORT}" CmdInit="" CloseAfterSend="true" CmdSep=";">\n\t<Info templateType="3" minVersion="16011106"/>\n`;
    lights.forEach(l => {
        const t = l.loxone_name.charAt(0).toUpperCase() + l.loxone_name.slice(1) + " (Hue)";
        xml += `\t<VirtualOutCmd Title="${escapeXml(t)}" Comment="${escapeXml(l.hue_name)}" CmdOn="${escapeXml(`/${l.loxone_name}/<v>`)}" Analog="true"/>\n`;
    });
    xml += `</VirtualOut>`;
    res.set('Content-Type', 'text/xml');
    res.set('Content-Disposition', `attachment; filename="lox_outputs.xml"`);
    res.send(xml);
});

router.get('/api/download/inputs', (req, res) => {
    const filterNames = req.query.names ? req.query.names.split(',') : null;
    let sensors = configManager.mapping.filter(m => m.hue_type === 'sensor' || m.hue_type === 'button');
    if (filterNames) sensors = sensors.filter(m => filterNames.includes(m.loxone_name));
    let xml = `<?xml version="1.0" encoding="utf-8"?>\n<VirtualInUdp Title="LoxHueBridge Sensors" Port="${configManager.config.loxonePort}">\n\t<Info templateType="1" minVersion="16011106"/>\n`;
    sensors.forEach(s => {
        const n = s.loxone_name;
        const t = n.charAt(0).toUpperCase() + n.slice(1);
        if (s.hue_type === 'sensor') {
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Motion`)}" Check="${escapeXml(`hue.${n}.motion \\v`)}" Analog="true" DefVal="0" MinVal="0" MaxVal="1" Unit="&lt;v&gt;"/>\n`;
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Contact`)}" Check="${escapeXml(`hue.${n}.contact \\v`)}" Analog="true" DefVal="0" MinVal="0" MaxVal="1" Unit="&lt;v&gt;"/>\n`;
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Lux`)}" Check="${escapeXml(`hue.${n}.lux \\v`)}" Analog="true" DefVal="0" MinVal="0" MaxVal="65000" Unit="&lt;v&gt; lx"/>\n`;
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Temp`)}" Check="${escapeXml(`hue.${n}.temp \\v`)}" Analog="true" DefVal="0" MinVal="-50" MaxVal="100" Unit="&lt;v.1&gt; °C"/>\n`;
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Battery`)}" Check="${escapeXml(`hue.${n}.bat \\v`)}" Analog="true" DefVal="0" MinVal="0" MaxVal="100" Unit="&lt;v&gt; %"/>\n`;
        } else {
            xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Event`)}" Check="${escapeXml(`hue.${n}.button \\v`)}" Analog="false"/>\n`;
            if(s.hue_name.includes("Dreh") || s.hue_name.includes("Rotary") || s.hue_name.includes("Dial")) {
                xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Rotary CW`)}" Check="${escapeXml(`hue.${n}.rotary cw`)}" Analog="false"/>\n`;
                xml += `\t<VirtualInUdpCmd Title="${escapeXml(`${t} Rotary CCW`)}" Check="${escapeXml(`hue.${n}.rotary ccw`)}" Analog="false"/>\n`;
            }
        }
    });
    xml += `</VirtualInUdp>`;
    res.set('Content-Type', 'text/xml');
    res.set('Content-Disposition', `attachment; filename="lox_inputs.xml"`);
    res.send(xml);
});

router.get('/api/targets', async (req, res) => {
    if (!configManager.isConfigured) return res.status(503).json([]);
    try {
        await hueManager.buildDeviceMap();
        const resources = await hueManager._internals.loadHueResources(['light', 'room', 'zone', 'device']);
        let t = [];
        const lightCapabilities = hueManager.getLightCapabilities();
        if (resources.light) {
            resources.light.forEach(x => {
                t.push({ uuid: x.id, name: x.metadata?.name || x.id, type: 'light', capabilities: lightCapabilities[x.id] || null });
            });
        }
        [...(resources.room || []), ...(resources.zone || [])].forEach(x => {
            const s = (x.services || []).find(y => y.rtype === 'grouped_light');
            if (s) t.push({ uuid: s.rid, name: x.metadata?.name || s.rid, type: 'group' });
        });
        if (resources.device) {
            resources.device.forEach(x => {
                const services = x.services || [];
                const name = x.metadata?.name || x.id;
                const m = services.find(y => y.rtype === 'motion');
                if (m) t.push({ uuid: m.rid, name, type: 'sensor' });
                
                const c = services.find(y => y.rtype === 'contact');
                if (c) t.push({ uuid: c.rid, name, type: 'sensor' });
                
                const buttons = services.filter(y => y.rtype === 'button');
                buttons.forEach((b, idx) => {
                    let suffix = buttons.length > 1 ? ` (Taste ${idx + 1})` : '';
                    t.push({ uuid: b.rid, name: `${name}${suffix}`, type: 'button' });
                });
                
                const rot = services.find(y => y.rtype === 'relative_rotary');
                if (rot) {
                    t.push({ uuid: rot.rid, name: `${name} (Drehring)`, type: 'button' });
                }
            });
        }
        t.sort((a, b) => a.name.localeCompare(b.name));
        res.json(t);
    } catch(e) {
        logger.error("Fehler bei /api/targets: " + e.message, "SYSTEM");
        res.status(500).json([]);
    }
});

router.post('/api/mapping', (req, res) => {
    configManager.mapping = req.body.filter(m => m.loxone_name);
    configManager.saveMapping();
    
    const serviceToDeviceMap = hueManager.getServiceToDeviceMap();
    configManager.mapping.forEach(m => {
        const mapMeta = serviceToDeviceMap[m.hue_uuid];
        configManager.detectedItems = configManager.detectedItems.filter(d => {
            if(d.type === 'command') return d.name !== m.loxone_name;
            const detMeta = serviceToDeviceMap[d.id];
            if(mapMeta && detMeta && mapMeta.deviceId === detMeta.deviceId) return false;
            return d.id !== m.hue_uuid;
        });
    });
    res.json({success:true});
});

router.get('/api/mapping', (req, res) => res.json(configManager.mapping));

router.post('/api/mapping/:loxoneName/settings', (req, res) => {
    const entry = configManager.getMappingByLoxoneName(req.params.loxoneName);
    if (!entry) return res.status(404).json({ success: false, error: 'Mapping nicht gefunden' });

    try {
        const settings = sanitizeMappingSettings(req.body);
        Object.assign(entry, settings);
        configManager.saveMapping();
        return res.json({ success: true, mapping: entry });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, error: error.message });
    }
});

router.get('/api/detected', (req, res) => res.json([...configManager.detectedItems].reverse()));
router.get('/api/status', (req, res) => res.json(configManager.statusCache));
router.get('/api/multisync/preview', (req, res) => res.json(hueManager.getMultiSyncPreview()));

router.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const category = req.query.category;
    const search = req.query.search ? req.query.search.toLowerCase() : null;

    let filtered = logger.getLogs(10000, category); 
    if (search) filtered = filtered.filter(l => l.msg.toLowerCase().includes(search));
    const result = filtered.slice(0, limit).map(r => ({ ...r, time: new Date(r.timestamp).toLocaleTimeString('de-DE') + '.' + String(r.timestamp % 1000).padStart(3, '0') }));
    res.json(result);
});

router.get('/api/settings', (req, res) => res.json({ 
    bridge_ip: configManager.config.bridgeIp, loxone_ip: configManager.config.loxoneIp, loxone_port: configManager.config.loxonePort, http_port: HTTP_PORT, 
    debug: configManager.config.debug, key_configured: configManager.isConfigured, transitionTime: configManager.config.transitionTime, throttleTime: configManager.config.throttleTime,
    eventStreamWatchdogTimeoutSeconds: configManager.config.eventStreamWatchdogTimeoutSeconds || 600,
    mqttEnabled: configManager.config.mqttEnabled, mqttBroker: configManager.config.mqttBroker, mqttPort: configManager.config.mqttPort, mqttUser: configManager.config.mqttUser, mqttPrefix: configManager.config.mqttPrefix,
    mqttPassSet: !!configManager.config.mqttPass,
    mqttConnected: mqttManager.client && mqttManager.client.connected, version: pjson.version,
    disableLogDisk: configManager.config.disableLogDisk,
    multiLightControl: configManager.config.multiLightControl || configManager.getDefaultMultiLightControl()
}));

router.get('/api/security/status', (req, res) => {
    res.json({
        authEnabled: configManager.config.authEnabled === true,
        authUser: configManager.config.authUser || 'admin',
        passwordConfigured: !!configManager.config.authPasswordHash
    });
});

router.post('/api/security/settings', (req, res) => {
    const enabled = req.body.authEnabled === true;
    const user = typeof req.body.authUser === 'string' && req.body.authUser.trim()
        ? req.body.authUser.trim().substring(0, 40)
        : 'admin';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (password) {
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Passwort muss mindestens 8 Zeichen haben.' });
        }
        configManager.config.authPasswordHash = auth.hashPassword(password);
    }

    if (enabled && !configManager.config.authPasswordHash) {
        return res.status(400).json({ success: false, error: 'Bitte zuerst ein Passwort setzen.' });
    }

    configManager.config.authEnabled = enabled;
    configManager.config.authUser = user;
    configManager.saveConfig();

    res.json({
        success: true,
        authEnabled: configManager.config.authEnabled,
        authUser: configManager.config.authUser,
        passwordConfigured: !!configManager.config.authPasswordHash
    });
});

router.post('/api/settings/debug', (req, res) => { 
    configManager.config.debug = !!req.body.active; 
    configManager.saveConfig(); 
    logger.updateConfig(configManager.config.disableLogDisk, configManager.config.debug);
    res.json({success:true}); 
});

router.post('/api/system/restart', (req, res) => { 
    res.json({success: true}); 
    logger.warn("Neustart...", "SYSTEM"); 
    setTimeout(() => process.exit(0), 500); 
});

router.get('/api/system/logdownload', (req, res) => { 
    try { 
        const rows = logger.getLogs(10000); 
        const text = rows.reverse().map(l => `[${new Date(l.timestamp).toLocaleString('de-DE')}] [${l.category}] [${l.level}] ${l.msg}`).join('\n'); 
        res.set('Content-Type', 'text/plain'); 
        res.set('Content-Disposition', 'attachment; filename="loxhuebridge.log"'); 
        res.send(text); 
    } catch(e) { res.status(500).send("Fehler: " + e.message); } 
});

router.get('/api/system/backup', (req, res) => {
    try {
        const redactSecrets = req.query.redactSecrets === 'true';
        const config = redactSecrets ? redactConfigSecrets(configManager.config) : configManager.config;
        const backup = { config, mapping: configManager.mapping, version: pjson.version, date: new Date().toISOString(), redacted: redactSecrets };
        res.json(backup);
    } catch(e) {
        logger.error("Backup Fehler: " + e.message, "SYSTEM");
        res.status(500).json({error: e.message});
    }
});

router.post('/api/system/restore', (req, res) => {
    try {
        const backup = req.body;
        if (!backup.config || !backup.mapping || !Array.isArray(backup.mapping)) {
            return res.status(400).json({success: false, error: "Ungültiges Backup-Format."});
        }
        if (backup.redacted === true || backup.config.appKey === '***' || backup.config.mqttPass === '***' || backup.config.authToken === '***' || backup.config.authPasswordHash === '***') {
            return res.status(400).json({success: false, error: "Reduziertes Backup ohne Zugangsdaten kann nicht wiederhergestellt werden."});
        }
        configManager.config = { ...configManager.config, ...backup.config };
        configManager.mapping = backup.mapping;
        configManager.saveConfig();
        configManager.saveMapping();
        logger.success("Restore erfolgreich!", "SYSTEM");
        res.json({success: true});
        setTimeout(() => process.exit(0), 1000);
    } catch(e) {
        logger.error("Restore Fehler: " + e.message, "SYSTEM");
        res.status(500).json({success: false, error: e.message});
    }
});

router.get('/api/diagnostics/bridge', async (req, res) => {
    if (!configManager.isConfigured) return res.status(503).json(null);
    try {
        const zigbeeData = await hueManager.getZigbeeStatus();
        const capabilities = hueManager.getLightCapabilities();
        const serviceToDeviceMap = hueManager.getServiceToDeviceMap();
        res.json({ zigbee: zigbeeData, capabilities, serviceToDeviceMap });
    } catch(e) {
        logger.error("Diagnose Fehler: " + e.message, "SYSTEM");
        res.status(500).json(null);
    }
});

router.get('/api/diagnostics/lampen', (req, res) => {
    res.json(hueManager.getLampDiagnostics());
});

// Timed Effect Route: /:name/sunrise/:seconds – muss VOR dem Catch-All `/:name/:value` stehen!
const ALERT_KEYWORDS   = ['alert', 'breathe'];
const EFFECT_KEYWORDS  = ['candle', 'fire', 'fireplace', 'prism', 'sparkle', 'opal', 'glisten', 'noeffect', 'no_effect'];

function normalizeEffectName(value) {
    if (value === 'noeffect') return 'no_effect';
    if (value === 'fireplace') return 'fire';
    return value;
}

router.get('/:name/sunrise/:seconds', async (req, res) => {
    const { name, seconds } = req.params;
    if (rejectReservedDiscoveryPath(name, res)) return;

    const durationSeconds = parseInt(seconds);
    logger.debug(`IN: /${name}/sunrise/${durationSeconds}s`, 'LIGHT');
    if (!configManager.isConfigured) return res.status(503).send('Not Configured');
    if (isNaN(durationSeconds) || durationSeconds <= 0) return res.status(400).send('Ungültige Dauer');

    const search = name.toLowerCase();
    const entry = configManager.mapping.find(m => m.loxone_name === search);
    const isGlobalAll = (search === 'all' || search === 'alles');
    const isMappedAll = (entry && entry.hue_uuid === 'pseudo-all');
    if (isGlobalAll || isMappedAll) {
        await hueManager.executeTimedEffectForAllLights('sunrise', durationSeconds);
        return res.status(200).send('OK All Sunrise');
    }

    if (!entry) {
        const multiSyncGroupId = hueManager.resolveMultiSyncGroupCommandName(name);
        if (multiSyncGroupId) {
            await hueManager.executeTimedEffectForMultiSyncGroup(multiSyncGroupId, 'sunrise', durationSeconds);
            return res.status(200).send('OK Multi-Sync Sunrise');
        }

        configManager.addDetectedItem(name);
        return res.status(200).send('Recorded');
    }
    if (entry.hue_type === 'sensor' || entry.hue_type === 'button') return res.status(400).send('Read-only');

    await hueManager.executeTimedEffect(entry, 'sunrise', durationSeconds);
    res.status(200).send('OK Sunrise');
});

router.get('/:name/:value', async (req, res) => {
    const { name, value } = req.params;
    if (rejectReservedDiscoveryPath(name, res)) return;

    logger.debug(`IN: /${name}/${value}`, 'LIGHT');
    if (!configManager.isConfigured) return res.status(503).send("Not Configured");
    
    const search = name.toLowerCase();
    const entry = configManager.mapping.find(m => m.loxone_name === search);
    const valueLower = value.toLowerCase();
    const isGlobalAll = (search === 'all' || search === 'alles');
    const isMappedAll = (entry && entry.hue_uuid === 'pseudo-all');

    if (isGlobalAll || isMappedAll) {
        if (EFFECT_KEYWORDS.includes(valueLower)) {
            await hueManager.executeEffectForAllLights(normalizeEffectName(valueLower));
            return res.status(200).send('OK All Effect');
        }

        if (!hueManager.isValidLoxoneCommandValue(value)) {
            return sendInvalidLoxoneValue(name, value, res);
        }

        try {
            const homeRes = await axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/bridge_home`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent: hueManager.httpsAgent });
            const homeSvc = homeRes.data.data[0]?.services.find(s => s.rtype === 'grouped_light');
            if (homeSvc) {
                logger.info("Steuere gesamtes Zuhause (bridge_home) nativ...", "LIGHT");
                await hueManager.executeCommand({ hue_uuid: homeSvc.rid, hue_type: 'group', loxone_name: 'all' }, value, 0);
                return res.status(200).send("OK Native All");
            }
        } catch (e) {
            logger.warn("bridge_home nicht gefunden, nutze Sequenz-Fallback...", "LIGHT");
        }

        const targets = await hueManager.buildAllCommandTargets();
        res.status(200).send(`Seq for ${targets.length}`);
        (async () => {
            logger.info(`Starte Sequenz für ${targets.length}...`, 'LIGHT');
            for (const target of targets) {
                await hueManager.executeCommand(target.entry, value, 0);
            }
        })();
        return;
    }

    if (!entry) {
        if (EFFECT_KEYWORDS.includes(valueLower)) {
            const multiSyncGroupId = hueManager.resolveMultiSyncGroupCommandName(name);
            if (multiSyncGroupId) {
                await hueManager.executeEffectForMultiSyncGroup(multiSyncGroupId, normalizeEffectName(valueLower));
                return res.status(200).send('OK Multi-Sync Effect');
            }
        }

        configManager.addDetectedItem(name);
        return res.status(200).send('Recorded');
    }

    if (entry.hue_type === 'sensor' || entry.hue_type === 'button') return res.status(400).send("Read-only");

    // Effekt-Befehle abfangen (non-numeric values) – vor executeCommand!
    if (ALERT_KEYWORDS.includes(valueLower)) {
        await hueManager.executeAlert(entry);
        return res.status(200).send('OK Alert');
    }
    if (EFFECT_KEYWORDS.includes(valueLower)) {
        await hueManager.executeEffect(entry, normalizeEffectName(valueLower));
        return res.status(200).send('OK Effect');
    }

    try {
        await hueManager.executeCommand(entry, value);
        res.status(200).send('OK');
    } catch (e) {
        if (isInvalidLoxoneValueError(e)) return sendInvalidLoxoneValue(name, value, res);
        throw e;
    }
});

function redactConfigSecrets(config) {
    return {
        ...config,
        appKey: config.appKey ? '***' : config.appKey,
        mqttPass: config.mqttPass ? '***' : config.mqttPass,
        authToken: config.authToken ? '***' : config.authToken,
        authPasswordHash: config.authPasswordHash ? '***' : config.authPasswordHash
    };
}

module.exports = router;
module.exports._internals = {
    isReservedDiscoveryPath,
    isInvalidLoxoneValueError,
    redactConfigSecrets,
    parseSyncOffsetSetting,
    parseSyncClusterSetting,
    parseOptionalBooleanSetting,
    sanitizeMappingSettings
};
