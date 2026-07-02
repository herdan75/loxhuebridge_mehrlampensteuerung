const axios = require('axios');
const https = require('https');
const logger = require('./logger');
const configManager = require('./config');
const loxoneManager = require('./loxone');
const mqttManager = require('./mqtt');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Runtime spacing used by the central HueScheduler. All Hue PUTs are queued
// through scheduleHuePutTask(); these values are no longer independent queues.
const HUE_RESOURCE_DELAYS = {
    light: { delayMs: 100 },
    grouped_light: { delayMs: 1100 }
};

const MULTI_SYNC_DEFAULTS = {
    syncWindowMs: 120,
    batchSize: 4,
    batchDelayMs: 30,
    maxCommandsPerSecond: 10,
    sameClusterSpacingMs: 10
};
const MULTI_SYNC_GROUP_IDS = ['a', 'b', 'c', 'd', 'e'];
const MAX_EVENT_BUFFER_LENGTH = 1024 * 1024;
const EVENT_STREAM_WATCHDOG_INTERVAL_MS = 30000;
const DEFAULT_EVENT_STREAM_SILENCE_RESTART_MS = 10 * 60 * 1000;
const HUE_RATE_LIMIT_RETRY_DELAYS_MS = [250, 750];
const DEFAULT_HUE_REQUEST_TIMEOUT_MS = 5000;

let multiSyncBuffers = new Map();
let multiSyncTimers = new Map();
let multiSyncCommandVersions = new Map();
let effectGenerations = new Map();
let hueSchedulerQueue = [];
let hueSchedulerProcessing = false;
let nextHueSchedulerSlotAt = 0;
let hueSchedulerPenaltyUntil = 0;

let serviceToDeviceMap = {}; 
let lightCapabilities = {};
let commandState = {}; 
let groupLightMembersCache = { expiresAt: 0, rooms: [], zones: [], devices: [] };

const HUE_MIN_MIREK = 153; const HUE_MAX_MIREK = 500;
const LOX_CT_MIN_KELVIN = 2000; const LOX_CT_MAX_KELVIN = 6500;

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

function getRuntimeThrottleTimeMs() {
    const value = Number(configManager.config.throttleTime);
    if (!Number.isFinite(value) || value < 0) return 100;
    return Math.round(value);
}

function applyRuntimeConfig() {
    const throttleTime = getRuntimeThrottleTimeMs();
    HUE_RESOURCE_DELAYS.light.delayMs = throttleTime;
    HUE_RESOURCE_DELAYS.grouped_light.delayMs = Math.max(throttleTime, 1000);
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
        maxCommandsPerSecond: clampNumber(source.maxCommandsPerSecond, MULTI_SYNC_DEFAULTS.maxCommandsPerSecond, 1, 50),
        sameClusterSpacingMs: clampNumber(source.sameClusterSpacingMs, MULTI_SYNC_DEFAULTS.sameClusterSpacingMs, 0, 50)
    };
}

function getBridgeMaxCommandsPerSecond() {
    const cfg = configManager.config.multiLightControl || {};
    return clampNumber(cfg.bridgeMaxCommandsPerSecond, 30, 1, 100);
}

function getHueSchedulerSpacingMs(resourceType = 'light', source = 'normal') {
    const globalSpacingMs = Math.ceil(1000 / getBridgeMaxCommandsPerSecond());
    if (resourceType === 'grouped_light') {
        return Math.max(globalSpacingMs, HUE_RESOURCE_DELAYS.grouped_light.delayMs);
    }

    if (source === 'multi_sync' || source === 'effect') {
        return globalSpacingMs;
    }

    return Math.max(globalSpacingMs, HUE_RESOURCE_DELAYS.light.delayMs);
}

// Central Hue PUT scheduler:
// normal light commands use throttleTime, grouped_light stays conservative,
// multi_sync/effect use their own timing plus the global bridge limit, and
// Hue 429 responses add a temporary global penalty before the next task.
async function processHueScheduler() {
    if (hueSchedulerProcessing) return;
    hueSchedulerProcessing = true;

    while (hueSchedulerQueue.length > 0) {
        const task = hueSchedulerQueue.shift();
        const now = Date.now();
        const waitUntil = Math.max(nextHueSchedulerSlotAt, hueSchedulerPenaltyUntil);
        const waitMs = Math.max(0, waitUntil - now);
        if (waitMs > 0) await sleep(waitMs);

        try {
            await task.execute();
            task.resolve();
        } catch (error) {
            task.reject(error);
        } finally {
            const spacingMs = Number.isFinite(Number(task.schedulerSpacingMs))
                ? Math.max(0, Math.min(5000, Math.round(Number(task.schedulerSpacingMs))))
                : getHueSchedulerSpacingMs(task.resourceType, task.source);
            nextHueSchedulerSlotAt = Date.now() + spacingMs;
        }
    }

    hueSchedulerProcessing = false;
}

function scheduleHuePutTask(task) {
    return new Promise((resolve, reject) => {
        hueSchedulerQueue.push({
            resourceType: task.resourceType || 'light',
            source: task.source || 'normal',
            uuid: task.uuid,
            payload: task.payload,
            loxoneName: task.loxoneName,
            schedulerSpacingMs: task.schedulerSpacingMs,
            execute: task.execute,
            resolve,
            reject
        });

        processHueScheduler();
    });
}

function resetHueSchedulerForTests() {
    hueSchedulerQueue = [];
    hueSchedulerProcessing = false;
    nextHueSchedulerSlotAt = 0;
    hueSchedulerPenaltyUntil = 0;
    multiSyncCommandVersions = new Map();
    effectGenerations = new Map();
}

function noteHueSchedulerRateLimit(delayMs, now = Date.now()) {
    const safeDelayMs = Math.max(100, Math.min(5000, Number(delayMs) || HUE_RATE_LIMIT_RETRY_DELAYS_MS[0]));
    hueSchedulerPenaltyUntil = Math.max(hueSchedulerPenaltyUntil, now + safeDelayMs);
    return hueSchedulerPenaltyUntil;
}

function getHueSchedulerPenaltyUntil() {
    return hueSchedulerPenaltyUntil;
}

function getSyncOffsetMs(entry) {
    const value = Number(entry?.sync_offset_ms);
    if (!Number.isFinite(value)) return 0;
    return Math.max(-500, Math.min(1000, value));
}

function normalizeSyncCluster(value) {
    return String(value || '').trim().substring(0, 40);
}

function getItemLightUuid(item) {
    return item?.uuid || item?.target?.uuid || item?.entry?.hue_uuid || '';
}

function getPhysicalDeviceKeyForLight(uuid) {
    if (!uuid) return '';
    return serviceToDeviceMap[uuid]?.deviceId || uuid;
}

function getPhysicalDeviceNameForLight(uuid) {
    if (!uuid) return '';
    return serviceToDeviceMap[uuid]?.deviceName || '';
}

function getMultiSyncClusterInfo(item, settings = {}) {
    const entry = item?.entry || {};
    const lightUuid = getItemLightUuid(item);
    const explicitCluster = normalizeSyncCluster(entry.sync_cluster);

    if (explicitCluster) {
        return {
            key: `${settings.id || getMultiSyncGroupId(entry)}:manual:${explicitCluster.toLowerCase()}`,
            name: explicitCluster,
            explicit: true
        };
    }

    const deviceKey = getPhysicalDeviceKeyForLight(lightUuid);
    const deviceName = getPhysicalDeviceNameForLight(lightUuid);

    return {
        key: `${settings.id || getMultiSyncGroupId(entry)}:auto:${deviceKey || lightUuid || entry.loxone_name || 'single'}`,
        name: deviceName || 'Einzel',
        explicit: false
    };
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
    const sameClusterSpacingMs = clampNumber(settings.sameClusterSpacingMs, MULTI_SYNC_DEFAULTS.sameClusterSpacingMs, 0, 50);
    const batchSize = Math.max(1, Number(settings.batchSize) || MULTI_SYNC_DEFAULTS.batchSize);
    const batchDelayMs = Math.max(0, Number(settings.batchDelayMs) || 0);
    const offsets = items.map(item => getSyncOffsetMs(item.entry));
    const baseDelayMs = Math.max(0, -Math.min(...offsets));

    const clusters = new Map();
    items.forEach((item, index) => {
        const offset = offsets[index];
        const cluster = getMultiSyncClusterInfo(item, settings);
        if (!clusters.has(cluster.key)) {
            clusters.set(cluster.key, {
                key: cluster.key,
                name: cluster.name,
                firstIndex: index,
                minOffset: offset,
                items: []
            });
        }

        const clusterEntry = clusters.get(cluster.key);
        clusterEntry.minOffset = Math.min(clusterEntry.minOffset, offset);
        clusterEntry.items.push({
            item,
            offset,
            originalIndex: index,
            clusterKey: cluster.key,
            clusterName: cluster.name
        });
    });

    const sortedClusters = Array.from(clusters.values())
        .sort((a, b) => {
            if (a.minOffset !== b.minOffset) return a.minOffset - b.minOffset;
            return a.firstIndex - b.firstIndex;
        });

    let lastDelay = -commandSpacingMs;
    let previousClusterKey = null;
    let commandIndex = 0;
    const schedule = [];

    sortedClusters.forEach((cluster, clusterIndex) => {
        cluster.items
            .sort((a, b) => {
                if (a.offset !== b.offset) return a.offset - b.offset;
                return a.originalIndex - b.originalIndex;
            })
            .forEach((scheduleItem, withinClusterIndex) => {
                const spacingFromPrevious = previousClusterKey === scheduleItem.clusterKey
                    ? sameClusterSpacingMs
                    : commandSpacingMs;
                const batchDelay = previousClusterKey === scheduleItem.clusterKey
                    ? 0
                    : Math.floor(commandIndex / batchSize) * batchDelayMs;
                const requestedDelay = baseDelayMs
                    + cluster.minOffset
                    + (clusterIndex * commandSpacingMs)
                    + Math.max(0, scheduleItem.offset - cluster.minOffset)
                    + (withinClusterIndex * sameClusterSpacingMs)
                    + batchDelay;
                const delayMs = Math.max(
                    Math.max(0, Math.round(requestedDelay)),
                    lastDelay + spacingFromPrevious
                );

                schedule.push({
                    ...scheduleItem,
                    requestedDelay: Math.max(0, Math.round(requestedDelay)),
                    delayMs,
                    commandSpacingMs,
                    sameClusterSpacingMs
                });

                lastDelay = delayMs;
                previousClusterKey = scheduleItem.clusterKey;
                commandIndex += 1;
            });
    });

    schedule.forEach((scheduleItem, index) => {
        const nextItem = schedule[index + 1];
        scheduleItem.schedulerSpacingMs = nextItem && nextItem.clusterKey === scheduleItem.clusterKey
            ? sameClusterSpacingMs
            : commandSpacingMs;
    });

    return schedule;
}

function getMultiSyncPreview(entries = configManager.mapping, groupId = null) {
    const groupIds = groupId ? [normalizeMultiSyncGroupId(groupId)] : MULTI_SYNC_GROUP_IDS;
    const groups = groupIds.map(id => {
        const items = entries
            .filter(entry => entry.hue_type === 'light' && entry.multi_sync === true && normalizeMultiSyncGroupId(entry.multi_sync_group) === id)
            .map(entry => ({ entry, uuid: entry.hue_uuid }));
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
            sameClusterSpacingMs: settings.sameClusterSpacingMs,
            totalDurationMs,
            effectiveCommandsPerSecond,
            schedule: schedule.map(item => ({
                loxoneName: item.item.entry.loxone_name,
                syncCluster: item.clusterName,
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

function getMultiSyncGroupId(entry) {
    return normalizeMultiSyncGroupId(entry?.multi_sync_group);
}

function getHueHeaders() {
    return { 'hue-application-key': configManager.config.appKey };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isHueRateLimitError(error) {
    return error?.response?.status === 429;
}

function getHueRateLimitRetryDelayMs(error, attemptIndex = 0) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    const retryAfterMs = Number(retryAfter) * 1000;

    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(5000, Math.max(100, retryAfterMs));
    }

    return HUE_RATE_LIMIT_RETRY_DELAYS_MS[Math.min(attemptIndex, HUE_RATE_LIMIT_RETRY_DELAYS_MS.length - 1)];
}

function getHueRequestTimeoutMs() {
    const value = Number(configManager.config.hueRequestTimeoutMs);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_HUE_REQUEST_TIMEOUT_MS;
    return Math.round(Math.max(1000, Math.min(60000, value)));
}

async function putHueWithRateLimitRetry(url, payload, options = {}) {
    const maxRetries = options.maxRetries ?? HUE_RATE_LIMIT_RETRY_DELAYS_MS.length;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await axios.put(url, payload, {
                headers: getHueHeaders(),
                httpsAgent,
                timeout: getHueRequestTimeoutMs()
            });
        } catch (error) {
            if (!isHueRateLimitError(error) || attempt >= maxRetries) throw error;

            const delayMs = getHueRateLimitRetryDelayMs(error, attempt);
            noteHueSchedulerRateLimit(delayMs);
            logger.warn(`HUE RATE LIMIT (429), retry in ${delayMs}ms`, 'LIGHT');
            await sleep(delayMs);
        }
    }
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

function isOffPayload(payload) {
    return payload?.on?.on === false;
}

function mergeHuePayload(previousPayload, nextPayload) {
    if (!previousPayload) return { ...nextPayload };
    if (!nextPayload) return { ...previousPayload };
    if (isOffPayload(previousPayload) || isOffPayload(nextPayload)) return { on: { on: false } };

    const merged = {
        ...previousPayload,
        ...nextPayload
    };

    if (nextPayload.color) delete merged.color_temperature;
    if (nextPayload.color_temperature) delete merged.color;

    return merged;
}

function getMultiSyncCommandKey(groupId, uuid) {
    return `${normalizeMultiSyncGroupId(groupId)}:${uuid}`;
}

function getMultiSyncCommandVersion(groupId, uuid) {
    return multiSyncCommandVersions.get(getMultiSyncCommandKey(groupId, uuid)) || 0;
}

function bumpMultiSyncCommandVersion(groupId, uuid) {
    const key = getMultiSyncCommandKey(groupId, uuid);
    const version = (multiSyncCommandVersions.get(key) || 0) + 1;
    multiSyncCommandVersions.set(key, version);
    return version;
}

function normalizeEffectGenerationKey(groupId) {
    return groupId === 'default' ? 'default' : normalizeMultiSyncGroupId(groupId);
}

function getEffectGeneration(groupId) {
    return effectGenerations.get(normalizeEffectGenerationKey(groupId)) || 0;
}

function startNewEffectGeneration(groupId) {
    const key = normalizeEffectGenerationKey(groupId);
    const generation = getEffectGeneration(key) + 1;
    effectGenerations.set(key, generation);
    return generation;
}

async function putHuePayload(uuid, type, payload, loxName, options = {}) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/${type}/${uuid}`;
    return scheduleHuePutTask({
        resourceType: type,
        source: options.source || 'normal',
        uuid,
        payload,
        loxoneName: loxName,
        schedulerSpacingMs: options.schedulerSpacingMs,
        execute: async () => {
            logger.debug(`OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT');

            await putHueWithRateLimitRetry(url, payload);

            updateStatus(loxName, 'on', payload.on?.on ? 1 : 0);
            if (payload.dimming) updateStatus(loxName, 'bri', payload.dimming.brightness);
        }
    });
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

async function buildAllCommandTargets(entries = configManager.mapping, resourceOverride = null) {
    const targets = [];
    const seenLightIds = new Set();
    const seenGroupIds = new Set();
    const addLightTarget = (uuid, entry) => {
        if (!uuid || seenLightIds.has(uuid)) return;
        seenLightIds.add(uuid);
        targets.push({ uuid, entry });
    };
    const addGroupFallback = (entry) => {
        if (!entry?.hue_uuid || seenGroupIds.has(entry.hue_uuid)) return;
        seenGroupIds.add(entry.hue_uuid);
        targets.push({ uuid: entry.hue_uuid, entry });
    };

    let resources = resourceOverride;
    for (const entry of entries.filter(item => item.hue_type === 'light' || item.hue_type === 'group')) {
        if (entry.hue_type === 'light') {
            addLightTarget(entry.hue_uuid, entry);
            continue;
        }

        try {
            if (!resources) resources = await getGroupResolutionResources();
            const lightIds = resolveGroupLightIds(entry.hue_uuid, resources.rooms, resources.zones, resources.devices);
            if (!lightIds.length) {
                addGroupFallback(entry);
                continue;
            }

            buildEffectTargets(entry, lightIds).forEach(target => addLightTarget(target.uuid, target.entry));
        } catch (error) {
            logger.warn(`All-Fallback: Gruppe ${entry.loxone_name} konnte nicht aufgelöst werden (${error.message}). Nutze Gruppen-Fallback.`, 'LIGHT');
            addGroupFallback(entry);
        }
    }

    return targets;
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

function supportsEffect(uuid, effectName, timed = false) {
    const caps = lightCapabilities[uuid];
    if (!caps) return true;

    const supported = timed ? caps.supportedTimedEffects : caps.supportedEffects;
    if (!Array.isArray(supported)) return true;

    return supported.includes(effectName);
}

function filterEffectTargetsByCapabilities(targets, effectName, timed = false) {
    return targets.filter(target => {
        if (supportsEffect(target.uuid, effectName, timed)) return true;

        logger.warn(
            `${timed ? 'TIMED EFFECT' : 'EFFECT'} ${effectName} -> ${target.entry.loxone_name}: Lampe unterstützt Effekt nicht`,
            'LIGHT'
        );
        return false;
    });
}

async function putLightEffectPayload(uuid, payload, loxName, options = {}) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/light/${uuid}`;
    return scheduleHuePutTask({
        resourceType: 'light',
        source: 'effect',
        uuid,
        payload,
        loxoneName: loxName,
        schedulerSpacingMs: options.schedulerSpacingMs,
        execute: async () => {
            await putHueWithRateLimitRetry(url, payload);
            logger.debug(`EFFECT OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT');
        }
    });
}

function scheduleEffectTargets(targets, payloadBuilder, options = {}) {
    const effectTargets = options.effectName
        ? filterEffectTargetsByCapabilities(targets, options.effectName, options.timed === true)
        : targets;
    const groupedTargets = new Map();

    effectTargets.forEach(target => {
        const groupId = target.entry.multi_sync === true ? getMultiSyncGroupId(target.entry) : 'default';
        if (!groupedTargets.has(groupId)) groupedTargets.set(groupId, []);
        groupedTargets.get(groupId).push(target);
    });

    groupedTargets.forEach((groupTargets, groupId) => {
        const generation = startNewEffectGeneration(groupId);
        const settings = groupId === 'default'
            ? { ...MULTI_SYNC_DEFAULTS, maxCommandsPerSecond: Math.min(MULTI_SYNC_DEFAULTS.maxCommandsPerSecond, getBridgeMaxCommandsPerSecond()) }
            : getMultiSyncSettings(groupId);
        const items = groupTargets.map(target => ({ entry: target.entry, target }));

        buildMultiSyncSchedule(items, settings).forEach(({ item, delayMs, schedulerSpacingMs }) => {
            setTimeout(() => {
                if (getEffectGeneration(groupId) !== generation) {
                    logger.debug(`Effect-Sync ${String(groupId).toUpperCase()}: verwerfe alten Timer für ${item.target.entry.loxone_name}`, 'LIGHT');
                    return;
                }

                putLightEffectPayload(
                    item.target.uuid,
                    payloadBuilder(),
                    item.target.entry.loxone_name,
                    { schedulerSpacingMs }
                ).catch(e => logger.hueError(e, 'LIGHT'));
            }, delayMs);
        });
    });
}

async function sendToHueRecursive(uuid, type, payload, loxName, options = {}) {
    const task = async () => {
        try {
            await putHuePayload(uuid, type, payload, loxName, options);
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

    await task();
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
    const uuidVersion = bumpMultiSyncCommandVersion(groupId, uuid);

    const previous = buffer.get(uuid);
    buffer.set(uuid, {
        entry,
        uuid,
        type,
        payload: mergeHuePayload(previous?.payload, payload),
        forcedTransition,
        uuidVersion
    });

    if (multiSyncTimers.has(groupId)) return;

    const settings = getMultiSyncSettings(groupId);

    const timer = setTimeout(() => {
        const groupBuffer = getMultiSyncBuffer(groupId);
        const batch = Array.from(groupBuffer.values());
        multiSyncBuffers.set(groupId, new Map());
        multiSyncTimers.delete(groupId);

        buildMultiSyncSchedule(batch, settings).forEach(({ item, delayMs, schedulerSpacingMs }) => {
            setTimeout(() => {
                if (getMultiSyncCommandVersion(groupId, item.uuid) !== item.uuidVersion) {
                    logger.debug(`Multi-Sync ${groupId.toUpperCase()}: verwerfe alten Timer für ${item.entry.loxone_name} wegen neuerem Befehl derselben Lampe`, 'LIGHT');
                    return;
                }

                updateLightWithQueue(
                    item.uuid,
                    item.type,
                    item.payload,
                    item.entry.loxone_name,
                    item.forcedTransition,
                    { source: 'multi_sync', schedulerSpacingMs }
                );
            }, delayMs);
        });
    }, settings.syncWindowMs);

    multiSyncTimers.set(groupId, timer);
}

function createInvalidCommandValueError(value) {
    const error = new Error(`Ungültiger Loxone-Wert: ${value}`);
    error.code = 'INVALID_LOXONE_VALUE';
    error.statusCode = 400;
    return error;
}

function parseLoxoneCommandValue(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) throw createInvalidCommandValueError(value);

    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) throw createInvalidCommandValueError(value);

    return { number: parsed, text };
}

function isValidLoxoneCommandValue(value) {
    try {
        parseLoxoneCommandValue(value);
        return true;
    } catch (e) {
        return false;
    }
}

function assertLoxonePercentComponent(value, label, rawValue) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw createInvalidCommandValueError(`${rawValue} (${label} ${value} außerhalb 0..100)`);
    }
}

function parseLoxoneRgbComponents(n, rawValue) {
    const b = Math.floor(n / 1000000);
    const rem = n % 1000000;
    const g = Math.floor(rem / 1000);
    const r = rem % 1000;

    assertLoxonePercentComponent(r, 'R', rawValue);
    assertLoxonePercentComponent(g, 'G', rawValue);
    assertLoxonePercentComponent(b, 'B', rawValue);

    return { r, g, b, max: Math.max(r, g, b) };
}

function parseLoxoneCtCommandValue(text, caps = null) {
    const rawValue = String(text ?? '').trim();
    if (!/^20\d{3}\d{4}$/.test(rawValue)) throw createInvalidCommandValueError(rawValue);

    const brightness = Number(rawValue.substring(2, 5));
    const kelvin = Number(rawValue.substring(5, 9));

    assertLoxonePercentComponent(brightness, 'Brightness', rawValue);
    if (kelvin < LOX_CT_MIN_KELVIN || kelvin > LOX_CT_MAX_KELVIN) {
        throw createInvalidCommandValueError(`${rawValue} (Kelvin ${kelvin} außerhalb ${LOX_CT_MIN_KELVIN}..${LOX_CT_MAX_KELVIN})`);
    }

    const capMin = Number(caps?.min);
    const capMax = Number(caps?.max);
    const minMirek = Number.isFinite(capMin) ? capMin : HUE_MIN_MIREK;
    const maxMirek = Number.isFinite(capMax) ? capMax : HUE_MAX_MIREK;
    const safeMin = Math.min(minMirek, maxMirek);
    const safeMax = Math.max(minMirek, maxMirek);
    const mirek = Math.max(safeMin, Math.min(safeMax, kelvinToMirek(kelvin)));

    return { brightness, kelvin, mirek };
}

async function executeCommand(entry, value, forcedTransition = null) {
    const rid = entry.hue_uuid;
    const rtype = entry.hue_type === 'group' ? 'grouped_light' : 'light';
    const parsedValue = parseLoxoneCommandValue(value);
    let payload = {}; let n = parsedValue.number;
    if (n === 0) payload = { on: { on: false } };
    else if (n === 1) payload = { on: { on: true } };
    else if (n > 1 && n <= 100) payload = { on: { on: true }, dimming: { brightness: n } };
    else {
        const s = parsedValue.text;
        const caps = lightCapabilities[rid];
        if (s.startsWith('20')) {
            const { brightness: b, mirek: targetMirek } = parseLoxoneCtCommandValue(s, caps);
            payload = (b===0) ? { on: { on: false } } : { on: { on: true }, dimming: { brightness: b }, color_temperature: { mirek: targetMirek } };
        } else {
            const { r, g, b, max } = parseLoxoneRgbComponents(n, parsedValue.text);
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
        await scheduleHuePutTask({
            resourceType: rtype,
            source: rtype === 'grouped_light' ? 'normal_group' : 'normal',
            uuid: rid,
            payload: { alert: { action: 'breathe' } },
            loxoneName: entry.loxone_name,
            execute: () => putHueWithRateLimitRetry(url, { alert: { action: 'breathe' } })
        });
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
        scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }), { effectName });
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
        scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }), { effectName, timed: true });
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
    scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }), { effectName });
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
    scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }), { effectName, timed: true });
}

async function executeEffectForAllLights(effectName) {
    const targets = buildAllLightEffectTargets();

    if (!targets.length) {
        logger.warn(`EFFECT ${effectName} -> all: keine gemappten Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`EFFECT ${effectName} -> all (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ effects: { effect: effectName } }), { effectName });
}

async function executeTimedEffectForAllLights(effectName, durationSeconds) {
    const durationMs = Math.max(1000, durationSeconds * 1000);
    const targets = buildAllLightEffectTargets();

    if (!targets.length) {
        logger.warn(`TIMED EFFECT ${effectName} -> all: keine gemappten Lampen gefunden`, 'LIGHT');
        return;
    }

    logger.info(`TIMED EFFECT ${effectName} ${durationSeconds}s -> all (${targets.length} Lampe(n))`, 'LIGHT');
    scheduleEffectTargets(targets, () => ({ timed_effects: { effect: effectName, duration: durationMs } }), { effectName, timed: true });
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
            if (l.owner?.rid) {
                const existing = serviceToDeviceMap[l.id] || {};
                serviceToDeviceMap[l.id] = {
                    deviceId: l.owner.rid,
                    deviceName: existing.deviceName || l.metadata?.name || '',
                    serviceType: existing.serviceType || 'light'
                };
            }
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
function shouldRestartEventStreamForSilence(lastTimestamp, now = Date.now(), isActive = eventStreamActive) {
    const configuredSeconds = Number(configManager.config.eventStreamWatchdogTimeoutSeconds);
    const timeoutMs = Number.isFinite(configuredSeconds)
        ? Math.max(60, Math.min(3600, configuredSeconds)) * 1000
        : DEFAULT_EVENT_STREAM_SILENCE_RESTART_MS;

    return isActive && (now - lastTimestamp) > timeoutMs;
}
function startWatchdog() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
        if (!shouldRestartEventStreamForSilence(lastEventTimestamp)) return;
        const silenceDuration = Date.now() - lastEventTimestamp;
        logger.warn(`EventStream Watchdog: Keine Daten seit ${Math.round(silenceDuration/1000)}s. Starte Stream vorsorglich neu...`, 'SYSTEM');
        restartEventStream();
    }, EVENT_STREAM_WATCHDOG_INTERVAL_MS);
}
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
    applyRuntimeConfig,
    isValidLoxoneCommandValue,
    getZigbeeStatus,
    getMultiSyncPreview,
    buildAllCommandTargets,
    buildDeviceMap,
    startEventStream,
    getLightCapabilities: () => lightCapabilities,
    getServiceToDeviceMap: () => serviceToDeviceMap,
    HUE_RESOURCE_DELAYS,
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
        getMultiSyncClusterInfo,
        getPhysicalDeviceKeyForLight,
        getPhysicalDeviceNameForLight,
        normalizeSyncCluster,
        getMultiSyncSettings,
        getBridgeMaxCommandsPerSecond,
        getHueSchedulerSpacingMs,
        scheduleHuePutTask,
        resetHueSchedulerForTests,
        noteHueSchedulerRateLimit,
        getHueSchedulerPenaltyUntil,
        getMultiSyncCommandKey,
        getMultiSyncCommandVersion,
        bumpMultiSyncCommandVersion,
        getEffectGeneration,
        startNewEffectGeneration,
        mergeHuePayload,
        isOffPayload,
        normalizeMultiSyncGroupId,
        normalizeCommandName,
        resolveGroupLightIds,
        buildEffectTargets,
        buildMultiSyncGroupEffectTargets,
        buildAllLightEffectTargets,
        buildAllCommandTargets,
        supportsEffect,
        filterEffectTargetsByCapabilities,
        shouldRestartEventStreamForSilence,
        DEFAULT_EVENT_STREAM_SILENCE_RESTART_MS,
        DEFAULT_HUE_REQUEST_TIMEOUT_MS,
        isHueRateLimitError,
        getHueRateLimitRetryDelayMs,
        getHueRequestTimeoutMs,
        putHueWithRateLimitRetry,
        getRuntimeThrottleTimeMs,
        parseLoxoneCommandValue,
        isValidLoxoneCommandValue,
        parseLoxoneRgbComponents,
        parseLoxoneCtCommandValue,
        assertLoxonePercentComponent,
        updateLightWithQueue,
        commandState
    }
};
