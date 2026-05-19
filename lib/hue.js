const axios = require('axios');
const https = require('https');
const logger = require('./logger');
const configManager = require('./config');
const loxoneManager = require('./loxone');
const mqttManager = require('./mqtt');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const REQUEST_QUEUES = { 
    light: { items: [], isProcessing: false, delayMs: 100 }, 
    grouped_light: { items: [], isProcessing: false, delayMs: 1100 } 
};

const MULTI_SYNC_DEFAULTS = {
    syncWindowMs: 120,
    batchSize: 4,
    batchDelayMs: 30,
    maxCommandsPerSecond: 10
};
const MULTI_SYNC_GROUP_IDS = ['a', 'b', 'c', 'd', 'e'];
const MAX_EVENT_BUFFER_LENGTH = 1024 * 1024;

let multiSyncBuffers = new Map();
let multiSyncTimers = new Map();
let nextMultiSyncBridgeSlotAt = 0;

let serviceToDeviceMap = {}; 
let lightCapabilities = {};
let commandState = {}; 
let groupLightMembersCache = { expiresAt: 0, rooms: [], zones: [], devices: [] };

const LOX_MIN_MIREK = 153; const LOX_MAX_MIREK = 370;

function mapRange(v, i1, i2, o1, o2) { return (v - i1) * (o2 - o1) / (i2 - i1) + o1; }
function kelvinToMirek(k) { if (k < 2000) return 500; return Math.round(1000000/k); }
function componentToHex(c) { const hex = c.toString(16); return hex.length == 1 ? "0" + hex : hex; }
function rgbToHex(r, g, b) { return "#" + componentToHex(Math.round(r)) + componentToHex(Math.round(g)) + componentToHex(Math.round(b)); }
function xyToHex(x, y, bri = 1.0) {
    let z = 1.0 - x - y; let Y = bri; let X = (Y / y) * x; let Z = (Y / y) * z;
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
    r = r <= 0.0031308 ? 12.92 * r : (1.0 + 0.055) * Math.pow(r, (1.0 / 2.4)) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : (1.0 + 0.055) * Math.pow(g, (1.0 / 2.4)) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : (1.0 + 0.055) * Math.pow(b, (1.0 / 2.4)) - 0.055;
    return rgbToHex(Math.max(0, Math.min(255, r * 255)), Math.max(0, Math.min(255, g * 255)), Math.max(0, Math.min(255, b * 255)));
}
function mirekToHex(mirek) {
    let temp = 1000000 / mirek / 100; let r, g, b;
    if (temp <= 66) { r = 255; g = 99.4708025861 * Math.log(temp) - 161.1195681661; b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307; } 
    else { r = 329.698727446 * Math.pow(temp - 60, -0.1332047592); g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492); b = 255; }
    return rgbToHex(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
}
function rgbToXy(r, g, b) {
    let red = r/100, green = g/100, blue = b/100;
    red = (red > 0.04045) ? Math.pow((red + 0.055) / 1.055, 2.4) : (red / 12.92);
    green = (green > 0.04045) ? Math.pow((green + 0.055) / 1.055, 2.4) : (green / 12.92);
    blue = (blue > 0.04045) ? Math.pow((blue + 0.055) / 1.055, 2.4) : (blue / 12.92);
    let X = red * 0.664511 + green * 0.154324 + blue * 0.162028;
    let Y = red * 0.283881 + green * 0.729798 + blue * 0.065885;
    let Z = red * 0.000088 + green * 0.077053 + blue * 0.950255;
    let sum = X + Y + Z;
    if (sum === 0) return { x: 0, y: 0 };
    return { x: Number((X / sum).toFixed(4)), y: Number((Y / sum).toFixed(4)) };
}
function rgbToMirekFallback(r, g, b, minM, maxM) {
    if ((r + b) === 0) return Math.round((minM + maxM) / 2);
    let warmth = r / (r + b); 
    return Math.round(minM + (warmth * (maxM - minM)));
}
function hueLightToLux(v) { return Math.round(Math.pow(10, (v - 1) / 10000)); }

function logQueueError(type, msg) { logger.error(`Queue Error (${type}): ${msg}`, 'SYSTEM'); }

async function processQueue(type) {
    const q = REQUEST_QUEUES[type];
    if (q.isProcessing || q.items.length === 0) return;
    q.isProcessing = true;
    const task = q.items.shift();
    try { await task(); } catch (e) { logQueueError(type, e.message); }
    setTimeout(() => { q.isProcessing = false; if (q.items.length > 0) processQueue(type); }, q.delayMs);
}

function enqueueRequest(type, taskFn) {
    const queueType = REQUEST_QUEUES[type] ? type : 'light';
    REQUEST_QUEUES[queueType].items.push(taskFn);
    processQueue(queueType);
}

function updateStatus(loxName, key, val) {
    if (!configManager.statusCache[loxName]) configManager.statusCache[loxName] = {};
    const isEvent = (key === 'button' || key === 'rotary');
    if (!isEvent && configManager.statusCache[loxName][key] === val) return; 
    configManager.statusCache[loxName][key] = val;
    const entry = configManager.getMappingByLoxoneName(loxName);
    if (!entry) return;
    let shouldSend = false; let category = 'SYSTEM';
    if (entry.hue_type === 'sensor') { shouldSend = true; category = 'SENSOR'; }
    else if (entry.hue_type === 'button') { shouldSend = true; category = 'BUTTON'; }
    else if (entry.sync_lox === true) { shouldSend = true; category = 'LIGHT'; } 
    if (shouldSend) loxoneManager.sendToLoxone(`hue.${loxName}.${key} ${val}`);
    
    if(!mqttManager.client || !mqttManager.client.connected) return;
    const typeMap = { 'light': 'light', 'group': 'group', 'sensor': 'sensor', 'button': 'button' };
    const type = typeMap[entry.hue_type] || 'device';
    mqttManager.publish(`${type}/${loxName}/${key}`, val);
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeMultiSyncGroupId(groupId) {
    const normalized = String(groupId || 'a').toLowerCase();
    return MULTI_SYNC_GROUP_IDS.includes(normalized) ? normalized : 'a';
}

function getMultiSyncSettings(groupId = 'a') {
    const cfg = configManager.config.multiLightControl || {};
    const normalizedGroupId = normalizeMultiSyncGroupId(groupId);
    const group = Array.isArray(cfg.groups)
        ? cfg.groups.find(item => item && item.id === normalizedGroupId)
        : null;
    const source = group || cfg;

    return {
        id: normalizedGroupId,
        name: source.name || `Gruppe ${normalizedGroupId.toUpperCase()}`,
        syncWindowMs: clampNumber(source.syncWindowMs, MULTI_SYNC_DEFAULTS.syncWindowMs, 10, 2000),
        batchSize: Math.round(clampNumber(source.batchSize, MULTI_SYNC_DEFAULTS.batchSize, 1, 50)),
        batchDelayMs: clampNumber(source.batchDelayMs, MULTI_SYNC_DEFAULTS.batchDelayMs, 0, 2000),
        maxCommandsPerSecond: clampNumber(source.maxCommandsPerSecond, MULTI_SYNC_DEFAULTS.maxCommandsPerSecond, 1, 50)
    };
}

function getBridgeMaxCommandsPerSecond() {
    const cfg = configManager.config.multiLightControl || {};
    return clampNumber(cfg.bridgeMaxCommandsPerSecond, 30, 1, 100);
}

function getSyncOffsetMs(entry) {
    const value = Number(entry?.sync_offset_ms);
    if (!Number.isFinite(value)) return 0;
    return Math.max(-500, Math.min(1000, value));
}

function appendEventStreamChunk(buffer, chunk) {
    const combined = buffer + chunk.toString('utf8');
    const rawEvents = combined.split(/\r?\n\r?\n/);
    const remaining = rawEvents.pop() || '';

    return { rawEvents, remaining };
}

function extractSseData(rawEvent) {
    const dataLines = rawEvent
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.replace(/^data:\s?/, ''));

    if (!dataLines.length) return null;

    return dataLines.join('\n').trim();
}

function buildMultiSyncSchedule(items, settings = getMultiSyncSettings()) {
    if (!Array.isArray(items) || !items.length) return [];

    const maxCommandsPerSecond = Math.max(1, Number(settings.maxCommandsPerSecond) || MULTI_SYNC_DEFAULTS.maxCommandsPerSecond);
    const commandSpacingMs = Math.ceil(1000 / maxCommandsPerSecond);
    const batchSize = Math.max(1, Number(settings.batchSize) || MULTI_SYNC_DEFAULTS.batchSize);
    const batchDelayMs = Math.max(0, Number(settings.batchDelayMs) || 0);
    const offsets = items.map(item => getSyncOffsetMs(item.entry));
    const baseDelayMs = Math.max(0, -Math.min(...offsets));

    let lastDelay = -commandSpacingMs;

    return items
        .map((item, index) => {
            const offset = offsets[index];
            const batchDelay = Math.floor(index / batchSize) * batchDelayMs;
            const requestedDelay = baseDelayMs + offset + (index * commandSpacingMs) + batchDelay;

            return { item, requestedDelay: Math.max(0, Math.round(requestedDelay)) };
        })
        .sort((a, b) => a.requestedDelay - b.requestedDelay)
        .map(scheduleItem => {
            const delayMs = Math.max(scheduleItem.requestedDelay, lastDelay + commandSpacingMs);
            lastDelay = delayMs;

            return {
                ...scheduleItem,
                delayMs,
                commandSpacingMs
            };
        });
}

function getMultiSyncPreview(entries = configManager.mapping, groupId = null) {
    const groupIds = groupId ? [normalizeMultiSyncGroupId(groupId)] : MULTI_SYNC_GROUP_IDS;
    const groups = groupIds.map(id => {
        const items = entries
            .filter(entry => entry.hue_type === 'light' && entry.multi_sync === true && normalizeMultiSyncGroupId(entry.multi_sync_group) === id)
            .map(entry => ({ entry }));
        const settings = getMultiSyncSettings(id);
        const schedule = buildMultiSyncSchedule(items, settings);
        const lastDelayMs = schedule.length ? Math.max(...schedule.map(item => item.delayMs)) : 0;
        const totalDurationMs = settings.syncWindowMs + lastDelayMs;
        const effectiveCommandsPerSecond = schedule.length > 1 && lastDelayMs > 0
            ? Number(((schedule.length - 1) / (lastDelayMs / 1000)).toFixed(1))
            : schedule.length;

        return {
            groupId: id,
            activeLights: schedule.length,
            settings,
            commandSpacingMs: schedule[0]?.commandSpacingMs || Math.ceil(1000 / settings.maxCommandsPerSecond),
            totalDurationMs,
            effectiveCommandsPerSecond,
            schedule: schedule.map(item => ({
                loxoneName: item.item.entry.loxone_name,
                syncOffsetMs: getSyncOffsetMs(item.item.entry),
                delayMs: settings.syncWindowMs + item.delayMs
            }))
        };
    });

    if (groupId) return groups[0];

    return {
        bridgeMaxCommandsPerSecond: getBridgeMaxCommandsPerSecond(),
        groups
    };
}

function scheduleBridgeLimitedMultiSyncTask(taskFn) {
    const spacingMs = Math.ceil(1000 / getBridgeMaxCommandsPerSecond());
    const now = Date.now();
    const scheduledAt = Math.max(now, nextMultiSyncBridgeSlotAt);
    nextMultiSyncBridgeSlotAt = scheduledAt + spacingMs;

    setTimeout(taskFn, Math.max(0, scheduledAt - now));
}

function getMultiSyncGroupId(entry) {
    return normalizeMultiSyncGroupId(entry?.multi_sync_group);
}

function getHueHeaders() {
    return { 'hue-application-key': configManager.config.appKey };
}

function normalizeCommandName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function resolveMultiSyncGroupCommandName(name) {
    const normalized = normalizeCommandName(name);

    for (const id of MULTI_SYNC_GROUP_IDS) {
        const aliases = [
            `gruppe_${id}`,
            `group_${id}`,
            `multisync_${id}`,
            `multi_sync_${id}`,
            `sync_${id}`
        ];

        if (aliases.includes(normalized)) return id;
    }

    const groups = configManager.config.multiLightControl?.groups || [];
    const match = groups.find(group => group?.id && normalizeCommandName(group.name) === normalized);

    return match ? normalizeMultiSyncGroupId(match.id) : null;
}

function getMultiSyncBuffer(groupId) {
    const normalizedGroupId = normalizeMultiSyncGroupId(groupId);
    if (!multiSyncBuffers.has(normalizedGroupId)) {
        multiSyncBuffers.set(normalizedGroupId, new Map());
    }

    return multiSyncBuffers.get(normalizedGroupId);
}

async function putHuePayload(uuid, type, payload, loxName) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/${type}/${uuid}`;
    logger.debug(`OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT');

    await axios.put(url, payload, {
        headers: getHueHeaders(),
        httpsAgent
    });

    updateStatus(loxName, 'on', payload.on?.on ? 1 : 0);
    if (payload.dimming) updateStatus(loxName, 'bri', payload.dimming.brightness);
}

function getLightServiceIdsForDevices(deviceIds, devices = []) {
    const deviceIdSet = new Set(deviceIds);
    const lightIds = [];

    devices.forEach(device => {
        if (!deviceIdSet.has(device.id)) return;
        (device.services || [])
            .filter(service => service.rtype === 'light' && service.rid)
            .forEach(service => lightIds.push(service.rid));
    });

    return [...new Set(lightIds)];
}

function getLightMappingsByUuid() {
    const byUuid = new Map();

    configManager.mapping
        .filter(entry => entry.hue_type === 'light' && entry.hue_uuid)
        .forEach(entry => byUuid.set(entry.hue_uuid, entry));

    return byUuid;
}

function resolveGroupLightIds(groupedLightRid, rooms = [], zones = [], devices = []) {
    const groupResources = [...rooms, ...zones];
    const owner = groupResources.find(resource =>
        (resource.services || []).some(service => service.rtype === 'grouped_light' && service.rid === groupedLightRid)
    );

    if (!owner) return [];

    const childDeviceIds = (owner.children || [])
        .filter(child => child.rtype === 'device' && child.rid)
        .map(child => child.rid);

    return getLightServiceIdsForDevices(childDeviceIds, devices);
}

function buildEffectTargets(entry, lightIds) {
    const mappingsByUuid = getLightMappingsByUuid();

    return lightIds.map((lightId, index) => {
        const mappedEntry = mappingsByUuid.get(lightId);

        return {
            uuid: lightId,
            entry: mappedEntry || {
                hue_uuid: lightId,
                hue_type: 'light',
                loxone_name: `${entry.loxone_name}_${index + 1}`,
                multi_sync: false
            }
        };
    });
}

function buildMultiSyncGroupEffectTargets(groupId) {
    const normalizedGroupId = normalizeMultiSyncGroupId(groupId);

    return configManager.mapping
        .filter(entry =>
            entry.hue_type === 'light' &&
            entry.hue_uuid &&
            entry.multi_sync === true &&
            normalizeMultiSyncGroupId(entry.multi_sync_group) === normalizedGroupId
        )
        .map(entry => ({ uuid: entry.hue_uuid, entry }));
}

function buildAllLightEffectTargets() {
    const seen = new Set();

    return configManager.mapping
        .filter(entry => entry.hue_type === 'light' && entry.hue_uuid)
        .filter(entry => {
            if (seen.has(entry.hue_uuid)) return false;
            seen.add(entry.hue_uuid);
            return true;
        })
        .map(entry => ({ uuid: entry.hue_uuid, entry }));
}

async function getGroupResolutionResources() {
    const now = Date.now();
    if (groupLightMembersCache.expiresAt > now) return groupLightMembersCache;

    const [rooms, zones, devices] = await Promise.all([
        axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/room`, { headers: getHueHeaders(), httpsAgent }),
        axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/zone`, { headers: getHueHeaders(), httpsAgent }),
        axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/device`, { headers: getHueHeaders(), httpsAgent })
    ]);

    groupLightMembersCache = {
        expiresAt: now + 30000,
        rooms: rooms.data?.data || [],
        zones: zones.data?.data || [],
        devices: devices.data?.data || []
    };

    return groupLightMembersCache;
}

async function resolveEffectTargets(entry) {
    if (entry.hue_type !== 'group') {
        return [{ uuid: entry.hue_uuid, entry }];
    }

    const resources = await getGroupResolutionResources();
    const lightIds = resolveGroupLightIds(entry.hue_uuid, resources.rooms, resources.zones, resources.devices);

    return buildEffectTargets(entry, lightIds);
}

async function putLightEffectPayload(uuid, payload, loxName) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/light/${uuid}`;
    await axios.put(url, payload, { headers: getHueHeaders(), httpsAgent });
    logger.debug(`EFFECT OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT');
}

function scheduleEffectTargets(targets, payloadBuilder) {
    const groupedTargets = new Map();

    targets.forEach(target => {
        const groupId = target.entry.multi_sync === true ? getMultiSyncGroupId(target.entry) : 'default';
        if (!groupedTargets.has(groupId)) groupedTargets.set(groupId, []);
        groupedTargets.get(groupId).push(target);
    });

    groupedTargets.forEach((groupTargets, groupId) => {
        const settings = groupId === 'default'
            ? { ...MULTI_SYNC_DEFAULTS, maxCommandsPerSecond: Math.min(MULTI_SYNC_DEFAULTS.maxCommandsPerSecond, getBridgeMaxCommandsPerSecond()) }
            : getMultiSyncSettings(groupId);
        const items = groupTargets.map(target => ({ entry: target.entry, target }));

        buildMultiSyncSchedule(items, settings).forEach(({ item, delayMs }) => {
            setTimeout(() => {
                scheduleBridgeLimitedMultiSyncTask(async () => {
                    try {
                        await putLightEffectPayload(
                            item.target.uuid,
                            payloadBuilder(),
                            item.target.entry.loxone_name
                        );
                    } catch (e) {
                        logger.hueError(e, 'LIGHT');
                    }
                });
            }, delayMs);
        });
    });
}

async function sendToHueRecursive(uuid, type, payload, loxName, options = {}) {
    const bypassQueue = options.bypassQueue === true;

    const task = async () => {
        try {
            await putHuePayload(uuid, type, payload, loxName);
        } catch (e) {
            logger.hueError(e, 'LIGHT');
        } finally {
            if (commandState[uuid].next) {
                const nextPayload = commandState[uuid].next;
                commandState[uuid].next = null;
                await sendToHueRecursive(uuid, type, nextPayload, loxName, options);
            } else {
                commandState[uuid].busy = false;
            }
        }
    };

    if (bypassQueue) {
        await task();
    } else {
        enqueueRequest(type, task);
    }
}

async function updateLightWithQueue(uuid, type, payload, loxName, forcedDuration = null, options = {}) {
    if (!commandState[uuid]) commandState[uuid] = { busy: false, next: null };
    let duration = configManager.config.transitionTime !== undefined ? configManager.config.transitionTime : 400;
    
    const caps = lightCapabilities[uuid];
    const entry = configManager.getMappingByLoxoneName(loxName);
    
    if ((caps && !caps.supportsDimming) || (entry && entry.ignore_dynamics === true)) {
        duration = 0;
    }

    const isDigitalSwitch = Object.keys(payload).length === 1 && payload.on !== undefined;
    if (isDigitalSwitch && payload.on.on === true) duration = 0; 
    
    if (forcedDuration !== null) duration = forcedDuration;
    if (duration > 0) payload.dynamics = { duration: duration };
    
    if (commandState[uuid].busy) { commandState[uuid].next = payload; return; }
    commandState[uuid].busy = true;
    await sendToHueRecursive(uuid, type, payload, loxName, options);
}

function scheduleMultiSyncedLightCommand(entry, uuid, type, payload, forcedTransition = null) {
    if (type !== 'light' || entry.multi_sync !== true) {
        return updateLightWithQueue(uuid, type, payload, entry.loxone_name, forcedTransition);
    }

    const groupId = getMultiSyncGroupId(entry);
    const buffer = getMultiSyncBuffer(groupId);

    buffer.set(uuid, {
        entry,
        uuid,
        type,
        payload,
        forcedTransition
    });

    if (multiSyncTimers.has(groupId)) return;

    const settings = getMultiSyncSettings(groupId);

    const timer = setTimeout(() => {
        const groupBuffer = getMultiSyncBuffer(groupId);
        const batch = Array.from(groupBuffer.values());
        multiSyncBuffers.set(groupId, new Map());
        multiSyncTimers.delete(groupId);

        buildMultiSyncSchedule(batch, settings).forEach(({ item, delayMs }) => {
            setTimeout(() => {
                scheduleBridgeLimitedMultiSyncTask(() => {
                    updateLightWithQueue(
                        item.uuid,
                        item.type,
                        item.payload,
                        item.entry.loxone_name,
                        item.forcedTransition,
                        { bypassQueue: true }
                    );
                });
            }, delayMs);
        });
    }, settings.syncWindowMs);

    multiSyncTimers.set(groupId, timer);
}

async function executeCommand(entry, value, forcedTransition = null) {
    const rid = entry.hue_uuid;
    const rtype = entry.hue_type === 'group' ? 'grouped_light' : 'light';
    let payload = {}; let n = parseInt(value); if(isNaN(n)) n=0;
    if (n === 0) payload = { on: { on: false } };
    else if (n === 1) payload = { on: { on: true } };
    else if (n > 1 && n <= 100) payload = { on: { on: true }, dimming: { brightness: n } };
    else {
        const s = value.toString();
        if (s.startsWith('20') && s.length >= 9) {
            const b = parseInt(s.substring(2, 5)); const k = parseInt(s.substring(5));
            let targetMirek = kelvinToMirek(k);
            const caps = lightCapabilities[rid];
            if (caps && caps.min && caps.max) {
                const scaled = Math.round(mapRange(targetMirek, LOX_MIN_MIREK, LOX_MAX_MIREK, caps.min, caps.max));
                targetMirek = Math.max(caps.min, Math.min(caps.max, scaled));
            }
            payload = (b===0) ? { on: { on: false } } : { on: { on: true }, dimming: { brightness: b }, color_temperature: { mirek: targetMirek } };
        } else {
            let b = Math.floor(n / 1000000), rem = n % 1000000, g = Math.floor(rem / 1000), r = rem % 1000, max = Math.max(r, g, b);
            if (max === 0) { payload = { on: { on: false } }; } else {
                const caps = lightCapabilities[rid];
                const supportsColor = caps ? caps.supportsColor : true;
                if (!supportsColor && caps && caps.supportsCt) {
                    const minM = caps.min || 153; const maxM = caps.max || 500;
                    const targetMirek = rgbToMirekFallback(r, g, b, minM, maxM);
                    payload = { on: { on: true }, dimming: { brightness: max }, color_temperature: { mirek: targetMirek } };
                    logger.debug(`RGB Fallback: R${r} B${b} -> ${targetMirek}m`, 'LIGHT');
                } else { payload = { on: { on: true }, dimming: { brightness: max }, color: { xy: rgbToXy(r, g, b) } }; }
            }
        }
    }
    await scheduleMultiSyncedLightCommand(entry, rid, rtype, payload, forcedTransition);
}

async function executeAlert(entry) {
    const rid = entry.hue_uuid;
    const rtype = entry.hue_type === 'group' ? 'grouped_light' : 'light';
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/${rtype}/${rid}`;
    try {
        logger.info(`ALERT breathe -> ${entry.loxone_name}`, 'LIGHT');
        await axios.put(url, { alert: { action: 'breathe' } }, { headers: getHueHeaders(), httpsAgent });
    } catch (e) { logger.hueError(e, 'LIGHT'); }
}

async function executeEffect(entry, effectName) {
    try {
        const targets = await resolveEffectTargets(entry);
        if (!targets.length) {
            logger.warn(`EFFECT ${effectName} -> ${entry.loxone_name}: keine Lampen in Gruppe gefunden`, 'LIGHT');
            return;
        }

        logger.info(`EFFECT ${effectName} -> ${entry.loxone_name} (${targets.length} Lampe(n))`, 'LIGHT');
        scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }));
    } catch (e) { logger.hueError(e, 'LIGHT'); }
}

async function executeTimedEffect(entry, effectName, durationSeconds) {
    const durationMs = Math.max(1000, durationSeconds * 1000);
    try {
        const targets = await resolveEffectTargets(entry);
        if (!targets.length) {
            logger.warn(`TIMED EFFECT ${effectName} -> ${entry.loxone_name}: keine Lampen in Gruppe gefunden`, 'LIGHT');
            return;
        }

        logger.info(`TIMED EFFECT ${effectName} ${durationSeconds}s -> ${entry.loxone_name} (${targets.length} Lampe(n))`, 'LIGHT');
        scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }));
    } catch (e) { logger.hueError(e, 'LIGHT'); }
}

async function executeEffectForMultiSyncGroup(groupId, effectName) {
    const normalizedGroupId = normalizeMultiSyncGroupId(groupId);
    const targets = buildMultiSyncGroupEffectTargets(normalizedGroupId);

    if (!targets.length) {
        logger.warn(`EFFECT ${effectName} -> Multi-Sync Gruppe ${normalizedGroupId.toUpperCase()}: keine Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`EFFECT ${effectName} -> Multi-Sync Gruppe ${normalizedGroupId.toUpperCase()} (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }));
}

async function executeTimedEffectForMultiSyncGroup(groupId, effectName, durationSeconds) {
    const normalizedGroupId = normalizeMultiSyncGroupId(groupId);
    const durationMs = Math.max(1000, durationSeconds * 1000);
    const targets = buildMultiSyncGroupEffectTargets(normalizedGroupId);

    if (!targets.length) {
        logger.warn(`TIMED EFFECT ${effectName} -> Multi-Sync Gruppe ${normalizedGroupId.toUpperCase()}: keine Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`TIMED EFFECT ${effectName} ${durationSeconds}s -> Multi-Sync Gruppe ${normalizedGroupId.toUpperCase()} (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }));
}

async function executeEffectForAllLights(effectName) {
    const targets = buildAllLightEffectTargets();

    if (!targets.length) {
        logger.warn(`EFFECT ${effectName} -> all: keine gemappten Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`EFFECT ${effectName} -> all (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }));
}

async function executeTimedEffectForAllLights(effectName, durationSeconds) {
    const durationMs = Math.max(1000, durationSeconds * 1000);
    const targets = buildAllLightEffectTargets();

    if (!targets.length) {
        logger.warn(`TIMED EFFECT ${effectName} -> all: keine gemappten Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`TIMED EFFECT ${effectName} ${durationSeconds}s -> all (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }));
}

async function getZigbeeStatus() {
    if (!configManager.isConfigured) return null;
    try {
        const [connRes, bridgeRes] = await Promise.all([
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/zigbee_connectivity`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/bridge`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent })
        ]);
        return {
            connectivity: connRes.data.data,
            bridge: bridgeRes.data.data[0] || null
        };
    } catch (e) {
        logger.error('Zigbee Status Fehler: ' + e.message, 'SYSTEM');
        return null;
    }
}

async function buildDeviceMap() {
    if (!configManager.isConfigured) return;
    try {
        const [resDev, resLight] = await Promise.all([
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/device`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/light`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent })
        ]);
        serviceToDeviceMap = {}; lightCapabilities = {};
        resDev.data.data.forEach(d => d.services.forEach(s => serviceToDeviceMap[s.rid] = { deviceId: d.id, deviceName: d.metadata.name, serviceType: s.rtype }));
        resLight.data.data.forEach(l => {
            lightCapabilities[l.id] = {
                supportsColor: !!l.color,
                supportsCt: !!l.color_temperature,
                supportsDimming: !!l.dimming,
                min: l.color_temperature?.mirek_schema?.mirek_minimum || 153,
                max: l.color_temperature?.mirek_schema?.mirek_maximum || 500,
                supportedEffects: l.effects?.effect_values || [],
                supportedTimedEffects: l.timed_effects?.effect_values || []
            };
        });
    } catch (e) { logger.error("Map Error: " + e.message, 'SYSTEM'); }
}

async function syncInitialStates() {
    if (!configManager.isConfigured) return;
    try {
        logger.info("Lade initialen Status aller Geräte...", 'SYSTEM');
        const [resLight, resGroup, resMotion, resContact, resTemp, resLux, resBat] = await Promise.all([
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/light`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/grouped_light`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/motion`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/contact`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/temperature`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/light_level`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent }),
            axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/device_power`, { headers: { 'hue-application-key': configManager.config.appKey }, httpsAgent })
        ]);

        const findMapping = (id) => configManager.mapping.find(m => m.hue_uuid === id) || configManager.mapping.find(m => {
             const meta = serviceToDeviceMap[id];
             const mapMeta = serviceToDeviceMap[m.hue_uuid];
             return meta && mapMeta && meta.deviceId === mapMeta.deviceId;
        });

        if(resLight.data?.data) resLight.data.data.forEach(d => {
            const entry = findMapping(d.id);
            if (entry) {
                const name = entry.loxone_name;
                if(d.on) updateStatus(name, 'on', d.on.on ? 1 : 0);
                if(d.dimming) updateStatus(name, 'bri', d.dimming.brightness);
                if(d.color_temperature?.mirek) { updateStatus(name, 'mirek', d.color_temperature.mirek); updateStatus(name, 'hex', mirekToHex(d.color_temperature.mirek)); }
                if(d.color?.xy) updateStatus(name, 'hex', xyToHex(d.color.xy.x, d.color.xy.y));
            }
        });
        if(resGroup.data?.data) resGroup.data.data.forEach(d => {
            const entry = findMapping(d.id);
            if (entry) {
                const name = entry.loxone_name;
                if(d.on) updateStatus(name, 'on', d.on.on ? 1 : 0);
                if(d.dimming) updateStatus(name, 'bri', d.dimming.brightness);
            }
        });
        if(resMotion.data?.data) resMotion.data.data.forEach(d => { const entry = findMapping(d.id); if (entry && d.motion) updateStatus(entry.loxone_name, 'motion', d.motion.motion ? 1 : 0); });
        if(resContact.data?.data) resContact.data.data.forEach(d => { const entry = findMapping(d.id); if (entry && d.contact_report) updateStatus(entry.loxone_name, 'contact', d.contact_report.state === 'no_contact' ? 1 : 0); });
        if(resTemp.data?.data) resTemp.data.data.forEach(d => { const entry = findMapping(d.id); if (entry && d.temperature) updateStatus(entry.loxone_name, 'temp', d.temperature.temperature); });
        if(resLux.data?.data) resLux.data.data.forEach(d => { const entry = findMapping(d.id); if (entry && d.light) updateStatus(entry.loxone_name, 'lux', hueLightToLux(d.light.light_level)); });
        if(resBat.data?.data) resBat.data.data.forEach(d => { if(d.owner && d.owner.rid) { const deviceId = d.owner.rid; configManager.mapping.forEach(m => { const meta = serviceToDeviceMap[m.hue_uuid]; if(meta && meta.deviceId === deviceId) { updateStatus(m.loxone_name, 'bat', d.power_state.battery_level); } }); } });
        logger.info("Initial Sync abgeschlossen.", 'SYSTEM');
    } catch(e) { logger.warn("Initial Sync Fehler: " + e.message, 'SYSTEM'); }
}

function processHueEvents(events) {
    if (!Array.isArray(events)) {
        logger.warn('EventStream Payload ignoriert: Erwartet wurde ein JSON Array.', 'SYSTEM');
        return;
    }

    events.forEach(evt => {
        if ((evt.type === 'update' || evt.type === 'add') && Array.isArray(evt.data)) {
            evt.data.forEach(d => {
                const entry = configManager.mapping.find(m => m.hue_uuid === d.id) || configManager.mapping.find(m => {
                    const meta = serviceToDeviceMap[d.id];
                    const mapMeta = serviceToDeviceMap[m.hue_uuid];
                    return meta && mapMeta && meta.deviceId === mapMeta.deviceId;
                });
                let logCat = 'SYSTEM';
                if(entry) {
                    if(entry.hue_type === 'light' || entry.hue_type === 'group') logCat = 'LIGHT';
                    else if(entry.hue_type === 'sensor') logCat = 'SENSOR';
                    else if(entry.hue_type === 'button') logCat = 'BUTTON';
                } else if (d.motion) logCat = 'SENSOR';
                else if (d.button) logCat = 'BUTTON';
                else if (d.on) logCat = 'LIGHT';

                if (entry) {
                    const lox = entry.loxone_name;
                    if (d.motion && d.motion.motion !== undefined) { updateStatus(lox, 'motion', d.motion.motion ? 1 : 0); if(configManager.config.debug) logger.debug(`Event: ${lox} Motion ${d.motion.motion}`, logCat); }
                    if (d.temperature) updateStatus(lox, 'temp', d.temperature.temperature);
                    if (d.light) updateStatus(lox, 'lux', hueLightToLux(d.light.light_level));
                    if (d.contact_report && d.contact_report.state) { const isOpen = d.contact_report.state === 'no_contact'; updateStatus(lox, 'contact', isOpen ? 1 : 0); if(configManager.config.debug) logger.debug(`Event: ${lox} Contact=${isOpen ? 'OPEN' : 'CLOSED'}`, logCat); }
                    if (d.on) { updateStatus(lox, 'on', d.on.on ? 1 : 0); if(configManager.config.debug) logger.debug(`Event: ${lox} On=${d.on.on}`, logCat); }
                    if (d.dimming) updateStatus(lox, 'bri', d.dimming.brightness);
                    if (d.button) { const evt = d.button.last_event; if (evt === 'short_release' || evt === 'long_press') { updateStatus(lox, 'button', evt); logger.debug(`Event: ${lox} Btn=${evt}`, logCat); } }
                    if (d.power_state) updateStatus(lox, 'bat', d.power_state.battery_level);
                    if (d.relative_rotary) { let rotaryData = d.relative_rotary.rotary_report || d.relative_rotary.last_event || d.relative_rotary; if (rotaryData && rotaryData.rotation) { const dir = rotaryData.rotation.direction === 'clock_wise' ? 'cw' : 'ccw'; updateStatus(lox, 'rotary', dir); logger.debug(`Event: ${lox} Dial=${dir}`, logCat); } }
                    if (d.color && d.color.xy) updateStatus(lox, 'hex', xyToHex(d.color.xy.x, d.color.xy.y));
                    if (d.color_temperature && d.color_temperature.mirek) { updateStatus(lox, 'hex', mirekToHex(d.color_temperature.mirek)); updateStatus(lox, 'mirek', d.color_temperature.mirek); }
                }
            });
        }
    });
}

let eventStreamActive = false; let eventStreamRequest = null; let watchdogInterval = null; let lastEventTimestamp = Date.now(); let eventStreamReconnectTimer = null;
function startWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = setInterval(() => { if (!eventStreamActive) return; const silenceDuration = Date.now() - lastEventTimestamp; if (silenceDuration > 60000) { logger.warn(`EventStream Watchdog: Keine Daten seit ${Math.round(silenceDuration/1000)}s. Erzwinge Neustart...`, 'SYSTEM'); restartEventStream(); } }, 30000); }
function scheduleEventStreamReconnect(delayMs, stream = null) { if (stream && eventStreamRequest && stream !== eventStreamRequest) return; if (eventStreamReconnectTimer) return; eventStreamActive = false; eventStreamRequest = null; eventStreamReconnectTimer = setTimeout(() => { eventStreamReconnectTimer = null; startEventStream(); }, delayMs); }
function restartEventStream() { if (eventStreamRequest) { try { eventStreamRequest.destroy(); } catch (e) { console.error(e); } } scheduleEventStreamReconnect(1000); }
async function startEventStream() {
    if (!configManager.isConfigured || eventStreamActive) return;
    if (eventStreamReconnectTimer) { clearTimeout(eventStreamReconnectTimer); eventStreamReconnectTimer = null; }
    eventStreamActive = true; lastEventTimestamp = Date.now(); startWatchdog(); await buildDeviceMap(); await syncInitialStates();
    logger.info("Starte EventStream...", 'SYSTEM');
    try {
        const response = await axios({ method: 'get', url: `https://${configManager.config.bridgeIp}/eventstream/clip/v2`, headers: { 'hue-application-key': configManager.config.appKey, 'Accept': 'text/event-stream' }, httpsAgent, responseType: 'stream', timeout: 0 });
        eventStreamRequest = response.data;
        let eventBuffer = '';
        response.data.on('data', (chunk) => {
            lastEventTimestamp = Date.now();
            const parsed = appendEventStreamChunk(eventBuffer, chunk);
            eventBuffer = parsed.remaining;

            if (eventBuffer.length > MAX_EVENT_BUFFER_LENGTH) {
                logger.error(`EventStream Puffer verworfen: kein Event-Abschluss nach ${eventBuffer.length} Bytes.`, 'SYSTEM');
                eventBuffer = '';
            }

            parsed.rawEvents.forEach(rawEvent => {
                const jsonStr = extractSseData(rawEvent);
                if (!jsonStr) return;

                let events;
                try {
                    events = JSON.parse(jsonStr);
                } catch (e) {
                    logger.error(`EventStream JSON Parsing Fehler: ${e.message} | Payload-Länge: ${jsonStr.length}`, "SYSTEM");
                    return;
                }

                try {
                    processHueEvents(events);
                } catch (e) {
                    logger.error(`EventStream Verarbeitung Fehler: ${e.message}`, 'SYSTEM');
                }
            });
        });
        response.data.on('end', () => { logger.warn("EventStream vom Server beendet.", 'SYSTEM'); scheduleEventStreamReconnect(5000, response.data); });
        response.data.on('error', (err) => { logger.error("EventStream Fehler: " + err.message, 'SYSTEM'); scheduleEventStreamReconnect(5000, response.data); });
        response.data.on('close', () => { logger.warn("EventStream geschlossen.", 'SYSTEM'); scheduleEventStreamReconnect(5000, response.data); });
    } catch (error) { logger.error("EventStream Verbindungsfehler: " + error.message, 'SYSTEM'); scheduleEventStreamReconnect(10000); }
}

module.exports = {
    executeCommand,
    executeAlert,
    executeEffect,
    executeTimedEffect,
    executeEffectForMultiSyncGroup,
    executeTimedEffectForMultiSyncGroup,
    executeEffectForAllLights,
    executeTimedEffectForAllLights,
    resolveMultiSyncGroupCommandName,
    getZigbeeStatus,
    getMultiSyncPreview,
    buildDeviceMap,
    startEventStream,
    getLightCapabilities: () => lightCapabilities,
    getServiceToDeviceMap: () => serviceToDeviceMap,
    REQUEST_QUEUES,
    httpsAgent,
    _internals: {
        mapRange,
        kelvinToMirek,
        componentToHex,
        rgbToHex,
        xyToHex,
        mirekToHex,
        rgbToXy,
        rgbToMirekFallback,
        hueLightToLux,
        appendEventStreamChunk,
        extractSseData,
        buildMultiSyncSchedule,
        getMultiSyncSettings,
        getBridgeMaxCommandsPerSecond,
        normalizeMultiSyncGroupId,
        normalizeCommandName,
        resolveGroupLightIds,
        buildEffectTargets,
        buildMultiSyncGroupEffectTargets,
        buildAllLightEffectTargets,
        updateLightWithQueue,
        commandState
    }
};
