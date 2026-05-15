const express = require('express');
const axios = require('axios');
const path = require('path');
const os = require('os');
const pjson = require('../package.json');

const configManager = require('./config');
const logger = require('./logger');
const mqttManager = require('./mqtt');
const hueManager = require('./hue');

const router = express.Router();

const HTTP_PORT = parseInt(process.env.HTTP_PORT || "8555");

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
    c.loxoneIp = req.body.loxoneIp; c.loxonePort = parseInt(req.body.loxonePort); c.debug = !!req.body.debug; 
    if(req.body.transitionTime!==undefined) c.transitionTime=parseInt(req.body.transitionTime); 
    if(req.body.throttleTime!==undefined) { 
        c.throttleTime=parseInt(req.body.throttleTime); 
        hueManager.REQUEST_QUEUES.light.delayMs = c.throttleTime; 
        hueManager.REQUEST_QUEUES.grouped_light.delayMs = Math.max(c.throttleTime, 100); 
    }
    if(req.body.mqttEnabled !== undefined) c.mqttEnabled = !!req.body.mqttEnabled;
    if(req.body.mqttBroker !== undefined) c.mqttBroker = req.body.mqttBroker;
    if(req.body.mqttPort !== undefined) c.mqttPort = parseInt(req.body.mqttPort);
    if(req.body.mqttUser !== undefined) c.mqttUser = req.body.mqttUser;
    if(req.body.mqttPass !== undefined) c.mqttPass = req.body.mqttPass;
    if(req.body.mqttPrefix !== undefined) c.mqttPrefix = req.body.mqttPrefix;
    if(req.body.disableLogDisk !== undefined) {
        c.disableLogDisk = !!req.body.disableLogDisk;
        logger.updateConfig(c.disableLogDisk, c.debug);
    }
    if(req.body.multiLightControl !== undefined) {
        c.multiLightControl = {
            ...(c.multiLightControl || {}),
            syncWindowMs: parseInt(req.body.multiLightControl.syncWindowMs ?? 120),
            batchSize: parseInt(req.body.multiLightControl.batchSize ?? 4),
            batchDelayMs: parseInt(req.body.multiLightControl.batchDelayMs ?? 30)
        };
    }
    
    configManager.saveConfig(); 
    configManager.load();
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
        const [l, r, z, d] = await Promise.all([
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/light`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent: hueManager.httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/room`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent: hueManager.httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/zone`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent: hueManager.httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/device`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent: hueManager.httpsAgent })
        ]);
        let t = [];
        const lightCapabilities = hueManager.getLightCapabilities();
        if (l.data?.data) {
            l.data.data.forEach(x => {
                t.push({ uuid: x.id, name: x.metadata.name, type: 'light', capabilities: lightCapabilities[x.id] || null });
            });
        }
        [...(r.data?.data || []), ...(z.data?.data || [])].forEach(x => {
            const s = x.services.find(y => y.rtype === 'grouped_light');
            if (s) t.push({ uuid: s.rid, name: x.metadata.name, type: 'group' });
        });
        if (d.data?.data) {
            d.data.data.forEach(x => {
                const m = x.services.find(y => y.rtype === 'motion');
                if (m) t.push({ uuid: m.rid, name: x.metadata.name, type: 'sensor' });
                
                const c = x.services.find(y => y.rtype === 'contact');
                if (c) t.push({ uuid: c.rid, name: x.metadata.name, type: 'sensor' });
                
                const buttons = x.services.filter(y => y.rtype === 'button');
                buttons.forEach((b, idx) => {
                    let suffix = buttons.length > 1 ? ` (Taste ${idx + 1})` : '';
                    t.push({ uuid: b.rid, name: `${x.metadata.name}${suffix}`, type: 'button' });
                });
                
                const rot = x.services.find(y => y.rtype === 'relative_rotary');
                if (rot) {
                    t.push({ uuid: rot.rid, name: `${x.metadata.name} (Drehring)`, type: 'button' });
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
router.get('/api/detected', (req, res) => res.json([...configManager.detectedItems].reverse()));
router.get('/api/status', (req, res) => res.json(configManager.statusCache));

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
    mqttEnabled: configManager.config.mqttEnabled, mqttBroker: configManager.config.mqttBroker, mqttPort: configManager.config.mqttPort, mqttUser: configManager.config.mqttUser, mqttPrefix: configManager.config.mqttPrefix,
    mqttConnected: mqttManager.client && mqttManager.client.connected, version: pjson.version,
    disableLogDisk: configManager.config.disableLogDisk,
    multiLightControl: configManager.config.multiLightControl || { syncWindowMs: 120, batchSize: 4, batchDelayMs: 30 }
}));

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
        const backup = { config: configManager.config, mapping: configManager.mapping, version: pjson.version, date: new Date().toISOString() };
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

// Timed Effect Route: /:name/sunrise/:seconds – muss VOR dem Catch-All `/:name/:value` stehen!
const ALERT_KEYWORDS   = ['alert', 'breathe'];
const EFFECT_KEYWORDS  = ['candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten', 'noeffect', 'no_effect'];

router.get('/:name/sunrise/:seconds', async (req, res) => {
    const { name, seconds } = req.params;
    const durationSeconds = parseInt(seconds);
    logger.debug(`IN: /${name}/sunrise/${durationSeconds}s`, 'LIGHT');
    if (!configManager.isConfigured) return res.status(503).send('Not Configured');
    if (isNaN(durationSeconds) || durationSeconds <= 0) return res.status(400).send('Ungültige Dauer');

    const search = name.toLowerCase();
    const entry = configManager.mapping.find(m => m.loxone_name === search);
    if (!entry) { configManager.addDetectedItem(name); return res.status(200).send('Recorded'); }
    if (entry.hue_type === 'sensor' || entry.hue_type === 'button') return res.status(400).send('Read-only');

    await hueManager.executeTimedEffect(entry, 'sunrise', durationSeconds);
    res.status(200).send('OK Sunrise');
});

router.get('/:name/:value', async (req, res) => {
    const { name, value } = req.params;
    logger.debug(`IN: /${name}/${value}`, 'LIGHT');
    if (!configManager.isConfigured) return res.status(503).send("Not Configured");
    
    const search = name.toLowerCase();
    const entry = configManager.mapping.find(m => m.loxone_name === search);
    const isGlobalAll = (search === 'all' || search === 'alles');
    const isMappedAll = (entry && entry.hue_uuid === 'pseudo-all');

    if (isGlobalAll || isMappedAll) {
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

        const targets = configManager.mapping.filter(e => e.hue_type === 'light' || e.hue_type === 'group');
        res.status(200).send(`Seq for ${targets.length}`);
        (async () => {
            logger.info(`Starte Sequenz für ${targets.length}...`, 'LIGHT');
            const delay = 100;
            for (const target of targets) {
                hueManager.executeCommand(target, value, 0);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        })();
        return;
    }

    if (!entry) {
        configManager.addDetectedItem(name);
        return res.status(200).send('Recorded');
    }

    if (entry.hue_type === 'sensor' || entry.hue_type === 'button') return res.status(400).send("Read-only");

    // Effekt-Befehle abfangen (non-numeric values) – vor executeCommand!
    const valueLower = value.toLowerCase();
    if (ALERT_KEYWORDS.includes(valueLower)) {
        await hueManager.executeAlert(entry);
        return res.status(200).send('OK Alert');
    }
    if (EFFECT_KEYWORDS.includes(valueLower)) {
        const effectName = valueLower === 'noeffect' ? 'no_effect' : valueLower;
        await hueManager.executeEffect(entry, effectName);
        return res.status(200).send('OK Effect');
    }

    await hueManager.executeCommand(entry, value);
    res.status(200).send('OK');
});

module.exports = router;

