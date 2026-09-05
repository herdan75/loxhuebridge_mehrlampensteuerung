const axios = require('axios');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const logger = require('./logger');
const configManager = require('./config');
const loxoneManager = require('./loxone');
const mqttManager = require('./mqtt');
const multiSyncTiming = require('../public/multisync');

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
const LAMP_DIAGNOSTIC_CONFIRMATION_WINDOW_MS = 120000;
const LAMP_DIAGNOSTIC_BRIGHTNESS_TOLERANCE = 1.5;
const DEFAULT_VERIFY_DELAYS_MS = [15000, 90000];
const DEFAULT_REPEAT_DELAY_MS = 300;
const DEFAULT_SPLIT_DELAY_MS = 100;

let multiSyncBuffers = new Map();
let multiSyncTimers = new Map();
let multiSyncCommandVersions = new Map();
let lampDiagnostics = {};
let lampExpectedStates = {};
let lampCommandGenerations = {};
let cancelledReliability = new Map();
let verifyDelaysMs = [...DEFAULT_VERIFY_DELAYS_MS];
let repeatDelayMs = DEFAULT_REPEAT_DELAY_MS;
let splitDelayMs = DEFAULT_SPLIT_DELAY_MS;
let hueSchedulerQueue = [];
let hueSchedulerProcessing = false;
let nextHueSchedulerSlotAt = 0;
let hueSchedulerPenaltyUntil = 0;
let lastHuePutStartedAt = 0;
let huePutGate = Promise.resolve();

let serviceToDeviceMap = {}; 
let lightCapabilities = {};
let commandState = {}; 
let groupLightMembersCache = { expiresAt: 0, rooms: [], zones: [], devices: [] };

const HUE_MIN_MIREK = 153; const HUE_MAX_MIREK = 500;
const LOX_CT_MIN_KELVIN = 2000; const LOX_CT_MAX_KELVIN = 6500;

function mapRange(v, i1, i2, o1, o2) { return (v - i1) * (o2 - o1) / (i2 - i1) + o1; }
function kelvinToMirek(k) { if (k < 2000) return 500; return Math.round(1000000/k); }
function componentToHex(c) {
    const value = Number.isFinite(c) ? Math.max(0, Math.min(255, Math.round(c))) : 0;
    const hex = value.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
}
function rgbToHex(r, g, b) { return "#" + componentToHex(Math.round(r)) + componentToHex(Math.round(g)) + componentToHex(Math.round(b)); }
function xyToHex(x, y, bri = 1.0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(bri) || y <= 0) return "#000000";
    let z = 1.0 - x - y; let Y = bri; let X = (Y / y) * x; let Z = (Y / y) * z;
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
    r = Number.isFinite(r) ? Math.max(0, r) : 0;
    g = Number.isFinite(g) ? Math.max(0, g) : 0;
    b = Number.isFinite(b) ? Math.max(0, b) : 0;
    const maxChannel = Math.max(r, g, b);
    if (maxChannel > 1) { r /= maxChannel; g /= maxChannel; b /= maxChannel; }
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

function clonePayload(payload) {
    return JSON.parse(JSON.stringify(payload || {}));
}

function getLampDiagnostic(uuid, loxName = '') {
    if (!uuid) return null;
    if (!lampDiagnostics[uuid]) {
        lampDiagnostics[uuid] = {
            name: loxName || uuid,
            befehle: 0,
            bestaetigt: 0,
            widersprueche: 0,
            letzteDauerMs: null,
            letzterWiderspruch: null,
            verifiziert: 0,
            nachgesteuert: 0,
            letzteVerifikation: null,
            communicationErrors: 0,
            letzterFehler: null,
            letzterBefehlAt: null,
            letzteBestaetigungAt: null
        };
    }
    if (loxName) lampDiagnostics[uuid].name = loxName;
    return lampDiagnostics[uuid];
}

function resetLampDiagnosticsForTests() {
    lampDiagnostics = {};
    lampExpectedStates = {};
    lampCommandGenerations = {};
    cancelledReliability = new Map();
}

function getLampCommandGeneration(uuid) {
    return lampCommandGenerations[uuid] || 0;
}

function bumpLampCommandGeneration(uuid) {
    lampCommandGenerations[uuid] = getLampCommandGeneration(uuid) + 1;
    return lampCommandGenerations[uuid];
}

function isReliabilityCurrent(uuid, generation) {
    return !commandsStopped && getLampCommandGeneration(uuid) === generation && cancelledReliability.get(uuid) !== generation;
}

function invalidateGroupReliability(uuid) {
    const cache = groupLightMembersCache;
    const members = cache.expiresAt > Date.now()
        ? resolveGroupLightIds(uuid, cache.rooms, cache.zones, cache.devices) : [];
    // Unknown group membership: cancel pending corrections conservatively, without delaying the command.
    for (const id of members.length ? members : Object.keys(lampCommandGenerations)) {
        cancelledReliability.set(id, getLampCommandGeneration(id));
    }
}

function getExpectedStateFromPayload(payload) {
    const expected = {};
    if (payload?.on !== undefined) expected.on = payload.on.on;
    if (payload?.dimming !== undefined) expected.bri = payload.dimming.brightness;
    return Object.keys(expected).length ? expected : null;
}

function recordLampCommand(uuid, loxName, payload, generation, isFollowUp = false) {
    const expected = getExpectedStateFromPayload(payload);
    if (!expected) return;
    const metric = getLampDiagnostic(uuid, loxName);
    if (!metric) return;

    if (!isFollowUp) metric.befehle += 1;
    metric.letzterBefehlAt = Date.now();
    lampExpectedStates[uuid] = {
        ...expected,
        generation,
        loxName,
        timestamp: Date.now(),
        seen: {}
    };
}

function compareLightDataToExpected(data, expected) {
    const mismatches = [];
    const matches = [];

    if (expected.on !== undefined && data?.on?.on !== undefined) {
        if (data.on.on === expected.on) matches.push('on');
        else mismatches.push({ field: 'on', expected: expected.on, actual: data.on.on });
    }

    if (expected.bri !== undefined && data?.dimming?.brightness !== undefined) {
        const actual = Number(data.dimming.brightness);
        if (Math.abs(actual - expected.bri) <= LAMP_DIAGNOSTIC_BRIGHTNESS_TOLERANCE) matches.push('bri');
        else mismatches.push({ field: 'bri', expected: expected.bri, actual });
    }

    return { matches, mismatches };
}

function recordLampEvent(uuid, data) {
    const expected = lampExpectedStates[uuid];
    const metric = lampDiagnostics[uuid];
    if (!expected || !metric) return;
    if (Date.now() - expected.timestamp > LAMP_DIAGNOSTIC_CONFIRMATION_WINDOW_MS) return;

    const { matches, mismatches } = compareLightDataToExpected(data, expected);
    matches.forEach(field => {
        if (expected.seen[field]) return;
        expected.seen[field] = true;
        metric.bestaetigt += 1;
        metric.letzteDauerMs = Date.now() - expected.timestamp;
        metric.letzteBestaetigungAt = Date.now();
    });
    if (['on', 'bri'].filter(field => expected[field] !== undefined).every(field => expected.seen[field])) {
        expected.confirmed = true;
    }

    mismatches.forEach(mismatch => {
        metric.widersprueche += 1;
        metric.letzterWiderspruch = {
            zeit: Date.now(),
            erwartet: `${mismatch.field}=${mismatch.expected}`,
            gemeldet: `${mismatch.field}=${mismatch.actual}`,
            nachMs: Date.now() - expected.timestamp
        };
    });
}

function getHueCommunicationErrors(response) {
    const errors = response?.data?.errors;
    if (!Array.isArray(errors)) return [];
    return errors.filter(error => error?.error_code === 'communication_error' || String(error?.description || '').includes('communication_error'));
}

function recordHueCommunicationErrors(uuid, loxName, response) {
    const errors = getHueCommunicationErrors(response);
    if (!errors.length) return false;

    const metric = getLampDiagnostic(uuid, loxName);
    const message = errors.map(error => error.description || error.error_code || 'communication_error').join('; ');
    if (metric) {
        metric.communicationErrors += errors.length;
        metric.widersprueche += errors.length;
        metric.letzterFehler = message;
        metric.letzterWiderspruch = {
            zeit: Date.now(),
            erwartet: 'Hue-Befehl erfolgreich',
            gemeldet: message,
            nachMs: 0
        };
    }
    logger.warn(`Hue communication_error bei ${loxName}: ${message}`, 'LIGHT');
    return true;
}

function getLampDiagnostics() {
    return Object.entries(lampDiagnostics).map(([uuid, metric]) => {
        const entry = configManager.mapping.find(item => item.hue_uuid === uuid) || {};
        const meta = serviceToDeviceMap[uuid] || {};
        return {
            uuid,
            name: metric.name,
            befehle: metric.befehle,
            bestaetigt: metric.bestaetigt,
            widersprueche: metric.widersprueche,
            quote: metric.befehle > 0 ? Math.round((metric.widersprueche / metric.befehle) * 1000) / 10 : 0,
            letzteDauerMs: metric.letzteDauerMs,
            letzterWiderspruch: metric.letzterWiderspruch,
            verifiziert: metric.verifiziert,
            nachgesteuert: metric.nachgesteuert,
            letzteVerifikation: metric.letzteVerifikation,
            communicationErrors: metric.communicationErrors,
            angefordert: lampExpectedStates[uuid] ? {
                on: lampExpectedStates[uuid].on, bri: lampExpectedStates[uuid].bri
            } : null,
            angenommenAt: metric.angenommenAt || null,
            letzterFehler: metric.letzterFehler,
            mapping: {
                loxoneName: entry.loxone_name || metric.name,
                hueName: entry.hue_name || '',
                hueType: entry.hue_type || 'light',
                deviceId: meta.deviceId || '',
                deviceName: meta.deviceName || '',
                multiSync: entry.multi_sync === true,
                multiSyncGroup: normalizeMultiSyncGroupId(entry.multi_sync_group),
                syncCluster: normalizeSyncCluster(entry.sync_cluster)
            }
        };
    }).sort((a, b) => b.widersprueche - a.widersprueche || b.quote - a.quote || String(a.name).localeCompare(String(b.name)));
}

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
        sameClusterSpacingMs: clampNumber(source.sameClusterSpacingMs, MULTI_SYNC_DEFAULTS.sameClusterSpacingMs, 0, 50),
        bridgeMaxCommandsPerSecond: getBridgeMaxCommandsPerSecond()
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
        if (commandsStopped || (task.isCurrent && !task.isCurrent())) { task.resolve(false); continue; }
        const now = Date.now();
        const waitUntil = Math.max(nextHueSchedulerSlotAt, hueSchedulerPenaltyUntil);
        const waitMs = Math.max(0, waitUntil - now);
        if (waitMs > 0) await sleep(waitMs);

        let executed = false;
        const startedAt = Date.now();
        try {
            if (commandsStopped || (task.isCurrent && !task.isCurrent())) { task.resolve(false); continue; }
            executed = true;
            const result = await task.execute();
            if (result === false) executed = false;
            task.resolve(result);
        } catch (error) {
            task.reject(error);
        } finally {
            if (executed) {
                const requestedSpacingMs = Number.isFinite(Number(task.schedulerSpacingMs))
                    ? Math.max(0, Math.min(5000, Math.round(Number(task.schedulerSpacingMs))))
                    : getHueSchedulerSpacingMs(task.resourceType, task.source);
                const spacingMs = Math.max(Math.ceil(1000 / getBridgeMaxCommandsPerSecond()), requestedSpacingMs);
                nextHueSchedulerSlotAt = Math.max(startedAt, lastHuePutStartedAt) + spacingMs;
            }
        }
    }

    hueSchedulerProcessing = false;
}

function scheduleHuePutTask(task) {
    if (commandsStopped) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        hueSchedulerQueue.push({
            resourceType: task.resourceType || 'light',
            source: task.source || 'normal',
            uuid: task.uuid,
            payload: task.payload,
            loxoneName: task.loxoneName,
            schedulerSpacingMs: task.schedulerSpacingMs,
            isCurrent: task.isCurrent,
            execute: task.execute,
            resolve,
            reject
        });

        processHueScheduler();
    });
}

function resetHueSchedulerForTests() {
    commandsStopped = false;
    hueSchedulerQueue = [];
    hueSchedulerProcessing = false;
    nextHueSchedulerSlotAt = 0;
    hueSchedulerPenaltyUntil = 0;
    lastHuePutStartedAt = 0;
    huePutGate = Promise.resolve();
    multiSyncCommandVersions = new Map();
    resetLampDiagnosticsForTests();
    setReliabilityTimingsForTests();
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

function appendEventStreamChunk(buffer, chunk, decoder = null) {
    const text = Buffer.isBuffer(chunk)
        ? (decoder ? decoder.write(chunk) : chunk.toString('utf8'))
        : String(chunk);
    const combined = buffer + text;
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
    return multiSyncTiming.buildSchedule(items, settings, getMultiSyncClusterInfo);
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
            sameClusterSpacingMs: Math.max(Math.ceil(1000 / getBridgeMaxCommandsPerSecond()), settings.sameClusterSpacingMs),
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

function getHueRequestConfig(extra = {}) {
    const { headers, ...rest } = extra || {};
    return {
        headers: {
            ...getHueHeaders(),
            ...(headers || {})
        },
        httpsAgent,
        timeout: getHueRequestTimeoutMs(),
        ...rest,
        maxRedirects: 0
    };
}

async function loadHueResources(resourceNames) {
    const results = await Promise.allSettled(resourceNames.map(name =>
        axios.get(`https://${configManager.config.bridgeIp}/clip/v2/resource/${name}`, getHueRequestConfig())
    ));

    const resources = {};
    results.forEach((result, index) => {
        const name = resourceNames[index];
        if (result.status === 'fulfilled') {
            resources[name] = result.value.data?.data || [];
        } else {
            resources[name] = null;
            logger.warn(`Hue Ressource ${name} nicht abrufbar: ${result.reason?.message || result.reason}`, 'SYSTEM');
        }
    });
    return resources;
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

function waitForHuePutSlot(isCurrent = () => true) {
    const ready = huePutGate.then(async () => {
        let waitMs;
        while ((waitMs = Math.max(lastHuePutStartedAt + Math.ceil(1000 / getBridgeMaxCommandsPerSecond()), hueSchedulerPenaltyUntil) - Date.now()) > 0) {
            if (commandsStopped || !isCurrent()) return false;
            await sleep(waitMs);
        }
        if (commandsStopped || !isCurrent()) return false;
        lastHuePutStartedAt = Date.now();
        return true;
    });
    huePutGate = ready.catch(() => {});
    return ready;
}

async function putHueWithRateLimitRetry(url, payload, options = {}) {
    const maxRetries = options.maxRetries ?? HUE_RATE_LIMIT_RETRY_DELAYS_MS.length;
    const { maxRetries: _maxRetries, retryDelaysMs: _retryDelaysMs, diagnosticTarget, isCurrent = () => true, onAttempt, ...requestOptions } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (!isCurrent() || !await waitForHuePutSlot(isCurrent)) return null;
            onAttempt?.(attempt);
            const response = await axios.put(url, payload, getHueRequestConfig(requestOptions));
            const errors = response.data?.errors;
            if (Array.isArray(errors) && errors.length) {
                if (diagnosticTarget) recordHueCommunicationErrors(diagnosticTarget.uuid, diagnosticTarget.name, response);
                const error = new Error(errors.map(item => item.description || item.error_code || 'Hue error').join('; '));
                error.code = 'HUE_RESPONSE_ERROR';
                error.response = response;
                throw error;
            }
            return response;
        } catch (error) {
            if (!isHueRateLimitError(error) || attempt >= maxRetries) throw error;

            const delayMs = getHueRateLimitRetryDelayMs(error, attempt);
            noteHueSchedulerRateLimit(delayMs);
            logger.warn(`HUE RATE LIMIT (429), retry in ${delayMs}ms`, 'LIGHT');
            await sleep(delayMs);
        }
    }
}

async function readHueResourceState(uuid, type) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/${type}/${uuid}`;
    const response = await axios.get(url, getHueRequestConfig());
    return response.data?.data?.[0] || null;
}

function checkStateDeviation(actualState, expectedState) {
    const deviations = [];
    if (!actualState || !expectedState) return deviations;

    if (expectedState.on !== undefined && actualState.on?.on !== undefined && actualState.on.on !== expectedState.on) {
        deviations.push(`on=${actualState.on.on} statt ${expectedState.on}`);
    }

    const actualBrightness = actualState.dimming?.brightness;
    if (expectedState.bri !== undefined && actualBrightness !== undefined
        && Math.abs(actualBrightness - expectedState.bri) > LAMP_DIAGNOSTIC_BRIGHTNESS_TOLERANCE) {
        deviations.push(`bri=${actualBrightness} statt ${expectedState.bri}`);
    }

    return deviations;
}

function recordVerificationResult(uuid, level, deviations) {
    const metric = lampDiagnostics[uuid];
    if (!metric) return;
    metric.verifiziert += 1;
    if (deviations.length) metric.nachgesteuert += 1;
    metric.letzteVerifikation = {
        zeit: Date.now(),
        stufe: level,
        abweichungen: deviations
    };
}

function scheduleStateVerification(uuid, type, payload, loxName, commandGeneration, options = {}) {
    if (type !== 'light') return;
    const expectedState = getExpectedStateFromPayload(payload);
    if (!expectedState) return;
    const pending = () => isReliabilityCurrent(uuid, commandGeneration)
        && !(lampExpectedStates[uuid]?.generation === commandGeneration && lampExpectedStates[uuid]?.confirmed);

    verifyDelaysMs.forEach((delayMs, index) => {
        const level = index + 1;
        const timer = setTimeout(() => {
            if (!pending()) return;

            (async () => {
                if (!pending()) return;
                let actualState;
                try {
                    actualState = await readHueResourceState(uuid, type);
                } catch (error) {
                    logger.warn(`Zustand von ${loxName} nicht lesbar: ${error.message}`, 'LIGHT');
                    return;
                }

                if (!pending() || !actualState) return;
                const deviations = checkStateDeviation(actualState, expectedState);
                recordVerificationResult(uuid, level, deviations);

                if (!deviations.length) {
                    if (lampExpectedStates[uuid]) lampExpectedStates[uuid].confirmed = true;
                    logger.debug(`Zustand ${loxName} bestätigt [Stufe ${level}]`, 'LIGHT');
                    return;
                }

                logger.warn(`${loxName} weicht ab (${deviations.join(', ')}) - wird nachgesteuert [Stufe ${level}]`, 'LIGHT');
                await updateLightWithQueue(uuid, type, clonePayload(payload), loxName, options.forcedDuration ?? null, {
                    ...options,
                    commandGeneration,
                    reliabilityFollowUp: true,
                    verificationFollowUp: true,
                    verifyAfterSend: false,
                    repeatAfterSend: false,
                    splitOnSend: false
                });
            })().catch(error => logger.hueError(error, 'LIGHT'));
        }, delayMs);
        timer.unref?.();
    });
}

function scheduleRepeatCommand(uuid, type, payload, loxName, commandGeneration, options = {}) {
    if (type !== 'light') return;
    const timer = setTimeout(() => {
        if (!isReliabilityCurrent(uuid, commandGeneration)) return;
        updateLightWithQueue(uuid, type, clonePayload(payload), loxName, options.forcedDuration ?? null, {
            ...options,
            commandGeneration,
            reliabilityFollowUp: true,
            verifyAfterSend: false,
            repeatAfterSend: false,
            splitOnSend: false
        }).catch(error => logger.hueError(error, 'LIGHT'));
    }, repeatDelayMs);
    timer.unref?.();
}

function shouldSplitOnCommand(entry, type, payload, options = {}) {
    return type === 'light'
        && entry?.split_on === true
        && options.reliabilityFollowUp !== true
        && payload?.on?.on === true
        && Object.keys(payload).some(key => key !== 'on');
}

function setReliabilityTimingsForTests(overrides = {}) {
    verifyDelaysMs = Array.isArray(overrides.verifyDelaysMs)
        ? overrides.verifyDelaysMs
        : [...DEFAULT_VERIFY_DELAYS_MS];
    repeatDelayMs = Number.isFinite(Number(overrides.repeatDelayMs))
        ? Math.max(0, Number(overrides.repeatDelayMs))
        : DEFAULT_REPEAT_DELAY_MS;
    splitDelayMs = Number.isFinite(Number(overrides.splitDelayMs))
        ? Math.max(0, Number(overrides.splitDelayMs))
        : DEFAULT_SPLIT_DELAY_MS;
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
    if (isOffPayload(nextPayload)) return { on: { on: false } };
    if (isOffPayload(previousPayload)) {
        return nextPayload.on?.on === true ? { ...nextPayload } : { on: { on: false } };
    }

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

async function putHuePayload(uuid, type, payload, loxName, options = {}) {
    const url = `https://${configManager.config.bridgeIp}/clip/v2/resource/${type}/${uuid}`;
    const isCurrent = () => getLampCommandGeneration(uuid) === options.commandGeneration
        && (!options.reliabilityFollowUp || isReliabilityCurrent(uuid, options.commandGeneration))
        && (!options.verificationFollowUp || !lampExpectedStates[uuid]?.confirmed);
    return scheduleHuePutTask({
        resourceType: type,
        source: options.source || 'normal',
        uuid,
        payload,
        loxoneName: loxName,
        schedulerSpacingMs: options.schedulerSpacingMs,
        isCurrent,
        execute: async () => {
            let commandGeneration = Number(options.commandGeneration);
            if (!Number.isFinite(commandGeneration) || commandGeneration <= 0) {
                commandGeneration = getLampCommandGeneration(uuid) || bumpLampCommandGeneration(uuid);
            }
            const isFollowUp = options.reliabilityFollowUp === true || options.skipMetricRecord === true;
            const response = await putHueWithRateLimitRetry(url, payload, {
                diagnosticTarget: type === 'light' ? { uuid, name: loxName } : null,
                isCurrent,
                onAttempt: attempt => {
                    logger.debug(`OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT');
                    if (type === 'light' && attempt === 0) recordLampCommand(uuid, loxName, payload, commandGeneration, isFollowUp);
                }
            });
            if (!response) return false;
            if (type === 'light') getLampDiagnostic(uuid, loxName).angenommenAt = Date.now();

            if (!isFollowUp && options.verifyAfterSend === true) {
                scheduleStateVerification(uuid, type, options.logicalPayload || payload, loxName, commandGeneration, options);
            }
            if (!isFollowUp && options.repeatAfterSend === true) {
                scheduleRepeatCommand(uuid, type, options.logicalPayload || payload, loxName, commandGeneration, options);
            }

            return response;
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

    const resources = await loadHueResources(['room', 'zone', 'device']);

    groupLightMembersCache = {
        expiresAt: now + 30000,
        rooms: resources.room || groupLightMembersCache.rooms || [],
        zones: resources.zone || groupLightMembersCache.zones || [],
        devices: resources.device || groupLightMembersCache.devices || []
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
    const isCurrent = () => getLampCommandGeneration(uuid) === options.commandGeneration;
    return scheduleHuePutTask({
        resourceType: 'light',
        source: 'effect',
        uuid,
        payload,
        loxoneName: loxName,
        schedulerSpacingMs: options.schedulerSpacingMs,
        isCurrent,
        execute: async () => {
            const response = await putHueWithRateLimitRetry(url, payload, {
                diagnosticTarget: { uuid, name: loxName }, isCurrent,
                onAttempt: () => logger.debug(`EFFECT OUT -> Hue (${loxName}): ${JSON.stringify(payload)}`, 'LIGHT')
            });
            return response || false;
        }
    });
}

function scheduleEffectTargets(targets, payloadBuilder, options = {}) {
    const effectTargets = options.effectName
        ? filterEffectTargetsByCapabilities(targets, options.effectName, options.timed === true)
        : targets;
    const groupedTargets = new Map();
    const seen = new Set();

    effectTargets.forEach(target => {
        if (seen.has(target.uuid)) return;
        seen.add(target.uuid);
        const groupId = target.entry.multi_sync === true ? getMultiSyncGroupId(target.entry) : 'default';
        if (!groupedTargets.has(groupId)) groupedTargets.set(groupId, []);
        groupedTargets.get(groupId).push({ ...target, commandGeneration: bumpLampCommandGeneration(target.uuid) });
    });

    groupedTargets.forEach((groupTargets, groupId) => {
        const settings = groupId === 'default'
            ? { ...MULTI_SYNC_DEFAULTS, bridgeMaxCommandsPerSecond: getBridgeMaxCommandsPerSecond(), maxCommandsPerSecond: Math.min(MULTI_SYNC_DEFAULTS.maxCommandsPerSecond, getBridgeMaxCommandsPerSecond()) }
            : getMultiSyncSettings(groupId);
        const items = groupTargets.map(target => ({ entry: target.entry, target }));

        buildMultiSyncSchedule(items, settings).forEach(({ item, delayMs, schedulerSpacingMs }) => {
            setTimeout(() => {
                if (getLampCommandGeneration(item.target.uuid) !== item.target.commandGeneration) {
                    logger.debug(`Effect-Sync ${String(groupId).toUpperCase()}: verwerfe alten Timer für ${item.target.entry.loxone_name}`, 'LIGHT');
                    return;
                }

                putLightEffectPayload(
                    item.target.uuid,
                    payloadBuilder(),
                    item.target.entry.loxone_name,
                    { schedulerSpacingMs, commandGeneration: item.target.commandGeneration }
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
            const nextCommand = commandState[uuid].next;
            commandState[uuid].busy = false;
            if (nextCommand) {
                commandState[uuid].next = null;
                if (nextCommand.payload) {
                    await updateLightWithQueue(
                        uuid,
                        nextCommand.type || type,
                        nextCommand.payload,
                        nextCommand.loxName || loxName,
                        nextCommand.forcedDuration ?? null,
                        nextCommand.options || options
                    );
                } else {
                    await updateLightWithQueue(uuid, type, nextCommand, loxName, null, options);
                }
            }
        }
    };

    await task();
}

async function updateLightWithQueue(uuid, type, payload, loxName, forcedDuration = null, options = {}) {
    if (commandsStopped) return;
    if (options.commandGeneration && getLampCommandGeneration(uuid) !== options.commandGeneration) return;
    if (options.reliabilityFollowUp && !isReliabilityCurrent(uuid, options.commandGeneration)) return;
    if (!commandState[uuid]) commandState[uuid] = { busy: false, next: null };
    const entry = configManager.getMappingByLoxoneName(loxName);
    const preparedOptions = {
        ...options,
        forcedDuration
    };
    if (!Number.isFinite(Number(preparedOptions.commandGeneration)) || Number(preparedOptions.commandGeneration) <= 0) {
        preparedOptions.commandGeneration = bumpLampCommandGeneration(uuid);
    } else {
        preparedOptions.commandGeneration = Number(preparedOptions.commandGeneration);
    }
    const isReliabilityFollowUp = preparedOptions.reliabilityFollowUp === true;
    if (!isReliabilityFollowUp) {
        preparedOptions.verifyAfterSend = type === 'light' && entry?.verify_state === true;
        preparedOptions.repeatAfterSend = type === 'light' && entry?.repeat_command === true;
        preparedOptions.splitOnSend = type === 'light' && entry?.split_on === true;
    } else {
        preparedOptions.verifyAfterSend = false;
        preparedOptions.repeatAfterSend = false;
        preparedOptions.splitOnSend = false;
    }

    let duration = configManager.config.transitionTime !== undefined ? configManager.config.transitionTime : 400;
    
    const caps = lightCapabilities[uuid];
    
    if ((caps && !caps.supportsDimming) || (entry && entry.ignore_dynamics === true)) {
        duration = 0;
    }

    const isDigitalSwitch = Object.keys(payload).length === 1 && payload.on !== undefined;
    if (isDigitalSwitch && payload.on.on === true) duration = 0; 
    
    if (forcedDuration !== null) duration = forcedDuration;
    if (duration > 0) payload.dynamics = { duration: duration };
    
    if (commandState[uuid].busy) {
        commandState[uuid].next = {
            type,
            payload,
            loxName,
            forcedDuration,
            options: preparedOptions
        };
        return;
    }

    commandState[uuid].busy = true;

    if (shouldSplitOnCommand(entry, type, payload, preparedOptions)) {
        const logicalPayload = clonePayload(payload);
        const restPayload = clonePayload(payload);
        delete restPayload.on;
        recordLampCommand(uuid, loxName, logicalPayload, preparedOptions.commandGeneration, false);

        const followUpOptions = {
            ...preparedOptions,
            logicalPayload,
            reliabilityFollowUp: true,
            skipMetricRecord: true,
            verifyAfterSend: false,
            repeatAfterSend: false,
            splitOnSend: false
        };

        const timer = setTimeout(() => {
            if (!isReliabilityCurrent(uuid, preparedOptions.commandGeneration)) return;
            updateLightWithQueue(uuid, type, restPayload, loxName, forcedDuration, followUpOptions)
                .catch(error => logger.hueError(error, 'LIGHT'));
        }, splitDelayMs);
        timer.unref?.();

        await sendToHueRecursive(uuid, type, { on: { on: true } }, loxName, followUpOptions);
        return;
    }

    await sendToHueRecursive(uuid, type, payload, loxName, preparedOptions);
}

function scheduleMultiSyncedLightCommand(entry, uuid, type, payload, forcedTransition = null) {
    if (type !== 'light' || entry.multi_sync !== true) {
        return updateLightWithQueue(uuid, type, payload, entry.loxone_name, forcedTransition);
    }

    const groupId = getMultiSyncGroupId(entry);
    const buffer = getMultiSyncBuffer(groupId);
    const uuidVersion = bumpMultiSyncCommandVersion(groupId, uuid);
    const commandGeneration = bumpLampCommandGeneration(uuid);

    const previous = buffer.get(uuid);
    buffer.set(uuid, {
        entry,
        uuid,
        type,
        payload: mergeHuePayload(previous?.payload, payload),
        forcedTransition,
        uuidVersion,
        commandGeneration
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
                    { source: 'multi_sync', schedulerSpacingMs, commandGeneration: item.commandGeneration }
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
        if (/^20\d{7}$/.test(s)) {
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
    if (rtype === 'grouped_light') invalidateGroupReliability(rid);
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
            execute: async () => {
                await putHueWithRateLimitRetry(url, { alert: { action: 'breathe' } }, {
                    diagnosticTarget: rtype === 'light' ? { uuid: rid, name: entry.loxone_name } : null
                });
            }
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
    const resources = await loadHueResources(['zigbee_connectivity', 'bridge']);
    if (!resources.zigbee_connectivity && !resources.bridge) return null;
    return {
        connectivity: resources.zigbee_connectivity || [],
        bridge: resources.bridge?.[0] || null
    };
}

async function buildDeviceMap() {
    if (!configManager.isConfigured) return;
    try {
        const resources = await loadHueResources(['device', 'light']);
        if (resources.device) {
            serviceToDeviceMap = {};
            resources.device.forEach(d => (d.services || []).forEach(s => serviceToDeviceMap[s.rid] = { deviceId: d.id, deviceName: d.metadata?.name || '', serviceType: s.rtype }));
        }
        if (!resources.light) return;

        lightCapabilities = {};
        resources.light.forEach(l => {
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
        const resources = await loadHueResources([
            'light', 'grouped_light', 'motion', 'contact',
            'temperature', 'light_level', 'device_power'
        ]);

        const findMapping = (id) => configManager.mapping.find(m => m.hue_uuid === id) || configManager.mapping.find(m => {
             const meta = serviceToDeviceMap[id];
             const mapMeta = serviceToDeviceMap[m.hue_uuid];
             return meta && mapMeta && meta.deviceId === mapMeta.deviceId;
        });

        if(resources.light) resources.light.forEach(d => {
            const entry = findMapping(d.id);
            if (entry) {
                const name = entry.loxone_name;
                if(d.on) updateStatus(name, 'on', d.on.on ? 1 : 0);
                if(d.dimming) updateStatus(name, 'bri', d.dimming.brightness);
                if(d.color_temperature?.mirek) { updateStatus(name, 'mirek', d.color_temperature.mirek); updateStatus(name, 'hex', mirekToHex(d.color_temperature.mirek)); }
                if(d.color?.xy) updateStatus(name, 'hex', xyToHex(d.color.xy.x, d.color.xy.y));
            }
        });
        if(resources.grouped_light) resources.grouped_light.forEach(d => {
            const entry = findMapping(d.id);
            if (entry) {
                const name = entry.loxone_name;
                if(d.on) updateStatus(name, 'on', d.on.on ? 1 : 0);
                if(d.dimming) updateStatus(name, 'bri', d.dimming.brightness);
            }
        });
        if(resources.motion) resources.motion.forEach(d => { const entry = findMapping(d.id); if (entry && d.motion) updateStatus(entry.loxone_name, 'motion', d.motion.motion ? 1 : 0); });
        if(resources.contact) resources.contact.forEach(d => { const entry = findMapping(d.id); if (entry && d.contact_report) updateStatus(entry.loxone_name, 'contact', d.contact_report.state === 'no_contact' ? 1 : 0); });
        if(resources.temperature) resources.temperature.forEach(d => { const entry = findMapping(d.id); if (entry && d.temperature) updateStatus(entry.loxone_name, 'temp', d.temperature.temperature); });
        if(resources.light_level) resources.light_level.forEach(d => { const entry = findMapping(d.id); if (entry && d.light) updateStatus(entry.loxone_name, 'lux', hueLightToLux(d.light.light_level)); });
        if(resources.device_power) resources.device_power.forEach(d => { if(d.owner && d.owner.rid) { const deviceId = d.owner.rid; configManager.mapping.forEach(m => { const meta = serviceToDeviceMap[m.hue_uuid]; if(meta && meta.deviceId === deviceId) { updateStatus(m.loxone_name, 'bat', d.power_state.battery_level); } }); } });
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
                    if (entry.hue_type === 'light') recordLampEvent(d.id, d);
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

let eventStreamActive = false; let eventStreamRequest = null; let watchdogInterval = null; let lastEventTimestamp = Date.now(); let eventStreamReconnectTimer = null; let eventStreamGeneration = 0; let eventStreamStopped = false;
let eventStreamController = null;
let commandsStopped = false;
let eventStreamConnectTimer = null;
function abortEventStreamConnection() {
    if (eventStreamConnectTimer) clearTimeout(eventStreamConnectTimer);
    eventStreamConnectTimer = null;
    const controller = eventStreamController;
    eventStreamController = null;
    controller?.abort();
}
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
    watchdogInterval.unref?.();
}
function scheduleEventStreamReconnect(delayMs, stream = null, generation = eventStreamGeneration) {
    if (eventStreamStopped || generation !== eventStreamGeneration) return;
    if (stream && eventStreamRequest && stream !== eventStreamRequest) return;
    if (eventStreamReconnectTimer) return;
    eventStreamActive = false;
    eventStreamRequest = null;
    eventStreamReconnectTimer = setTimeout(() => {
        eventStreamReconnectTimer = null;
        if (eventStreamStopped || generation !== eventStreamGeneration) return;
        startEventStream();
    }, delayMs);
    eventStreamReconnectTimer.unref?.();
    abortEventStreamConnection();
    stream?.destroy();
}
function restartEventStream() {
    eventStreamGeneration += 1;
    abortEventStreamConnection();
    eventStreamActive = false;
    if (eventStreamRequest) { try { eventStreamRequest.destroy(); } catch (e) { console.error(e); } }
    eventStreamRequest = null;
    scheduleEventStreamReconnect(1000, null, eventStreamGeneration);
}
function stopEventStream() {
    eventStreamStopped = true;
    eventStreamGeneration += 1;
    abortEventStreamConnection();
    if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
    if (eventStreamReconnectTimer) { clearTimeout(eventStreamReconnectTimer); eventStreamReconnectTimer = null; }
    if (eventStreamRequest) {
        try { eventStreamRequest.destroy(); } catch (e) { console.error(e); }
        eventStreamRequest = null;
    }
    eventStreamActive = false;
}
async function startEventStream() {
    if (commandsStopped || !configManager.isConfigured || eventStreamActive) return;
    eventStreamStopped = false;
    const streamGeneration = eventStreamGeneration + 1;
    eventStreamGeneration = streamGeneration;
    if (eventStreamReconnectTimer) { clearTimeout(eventStreamReconnectTimer); eventStreamReconnectTimer = null; }
    eventStreamActive = true; lastEventTimestamp = Date.now(); startWatchdog(); await buildDeviceMap(); await syncInitialStates();
    if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
    logger.info("Starte EventStream...", 'SYSTEM');
    const controller = new AbortController();
    eventStreamController = controller;
    const connectTimer = setTimeout(() => controller.abort(), getHueRequestTimeoutMs());
    eventStreamConnectTimer = connectTimer;
    connectTimer.unref?.();
    try {
        const response = await axios({ method: 'get', url: `https://${configManager.config.bridgeIp}/eventstream/clip/v2`, headers: { 'hue-application-key': configManager.config.appKey, 'Accept': 'text/event-stream' }, httpsAgent, responseType: 'stream', timeout: 0, signal: controller.signal, maxRedirects: 0 });
        clearTimeout(connectTimer);
        if (eventStreamStopped || streamGeneration !== eventStreamGeneration || controller.signal.aborted) {
            response.data.destroy();
            return;
        }
        eventStreamRequest = response.data;
        const decoder = new StringDecoder('utf8');
        let eventBuffer = '';
        response.data.on('data', (chunk) => {
            if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
            lastEventTimestamp = Date.now();
            const parsed = appendEventStreamChunk(eventBuffer, chunk, decoder);
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
        response.data.on('end', () => {
            if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
            logger.warn("EventStream vom Server beendet.", 'SYSTEM');
            scheduleEventStreamReconnect(5000, response.data, streamGeneration);
        });
        response.data.on('error', (err) => {
            if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
            logger.error("EventStream Fehler: " + err.message, 'SYSTEM');
            scheduleEventStreamReconnect(5000, response.data, streamGeneration);
        });
        response.data.on('close', () => {
            if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
            logger.warn("EventStream geschlossen.", 'SYSTEM');
            scheduleEventStreamReconnect(5000, response.data, streamGeneration);
        });
    } catch (error) {
        if (eventStreamStopped || streamGeneration !== eventStreamGeneration) return;
        logger.error("EventStream Verbindungsfehler: " + error.message, 'SYSTEM');
        scheduleEventStreamReconnect(10000, null, streamGeneration);
    } finally {
        clearTimeout(connectTimer);
        if (eventStreamConnectTimer === connectTimer) eventStreamConnectTimer = null;
        if (eventStreamController === controller) eventStreamController = null;
    }
}

module.exports = {
    close() {
        commandsStopped = true;
        stopEventStream();
        for (const task of hueSchedulerQueue.splice(0)) task.resolve(false);
        httpsAgent.destroy();
    },
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
    getHueRequestConfig,
    buildAllCommandTargets,
    buildDeviceMap,
    startEventStream,
    stopEventStream,
    getLampDiagnostics,
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
        clonePayload,
        appendEventStreamChunk,
        extractSseData,
        getHueRequestConfig,
        loadHueResources,
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
        readHueResourceState,
        checkStateDeviation,
        recordVerificationResult,
        getExpectedStateFromPayload,
        compareLightDataToExpected,
        recordLampCommand,
        recordLampEvent,
        scheduleStateVerification,
        scheduleRepeatCommand,
        shouldSplitOnCommand,
        getHueCommunicationErrors,
        recordHueCommunicationErrors,
        getLampDiagnostic,
        getLampDiagnostics,
        resetLampDiagnosticsForTests,
        getLampCommandGeneration,
        bumpLampCommandGeneration,
        setReliabilityTimingsForTests,
        DEFAULT_VERIFY_DELAYS_MS,
        DEFAULT_REPEAT_DELAY_MS,
        DEFAULT_SPLIT_DELAY_MS,
        LAMP_DIAGNOSTIC_BRIGHTNESS_TOLERANCE,
        LAMP_DIAGNOSTIC_CONFIRMATION_WINDOW_MS,
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
