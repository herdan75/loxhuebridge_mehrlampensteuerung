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


function validateMappings(items) {
    if (!Array.isArray(items)) throw invalid('Ungültiges Mapping');
    const names = new Set();
    return items.map(item => {
        if (!item || typeof item.loxone_name !== 'string') throw invalid('Loxone-Name fehlt');
        const name = item.loxone_name.trim().toLowerCase();
        if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,127}$/u.test(name)) throw invalid('Loxone-Name: nur Buchstaben, Zahlen, Punkt, Bindestrich und Unterstrich erlaubt');
        if (names.has(name)) throw invalid('Doppelter Loxone-Name: ' + name);
        names.add(name);
        const type = item.hue_type;
        if (!['light', 'group', 'sensor', 'button'].includes(type)) throw invalid('Ungültiger Gerätetyp: ' + name);
        if (typeof item.hue_uuid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(item.hue_uuid)) throw invalid('Ungültige Hue-Ressourcenkennung: ' + name);
        const isAll = type === 'group' && item.hue_uuid === 'pseudo-all';
        if (['api', 'description.xml', 'upnp', 'ssdp', 'xml', 'setup.html', 'app.js', 'style.css', 'favicon.svg'].includes(name) ||
            (['all', 'alles'].includes(name) && !isAll) || (item.hue_uuid === 'pseudo-all' && !isAll)) throw invalid('Reservierter Loxone-Name oder Globalbefehl: ' + name);
        return { ...item, loxone_name: name, ...sanitizeMappingSettings({
            sync_lox: false, ignore_dynamics: false, multi_sync: false, sync_offset_ms: 0, ...item
        }) };
    });
}

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

module.exports = { validateMappings, sanitizeMappingSettings, parseSyncOffsetSetting, parseSyncClusterSetting, parseOptionalBooleanSetting };
