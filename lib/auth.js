const crypto = require('crypto');
const { promisify } = require('node:util');
const configManager = require('./config');

const HASH_ALGORITHM = 'sha256';
const HASH_ITERATIONS = 210000;
const HASH_KEY_LENGTH = 32;
const pbkdf2 = promisify(crypto.pbkdf2);
const cacheKey = crypto.randomBytes(32);
const credentialCache = new Map();
const pendingChecks = new Map();
const attempts = new Map();
let activeHashes = 0;

function busyError() {
    return Object.assign(new Error('Zu viele Anmeldeversuche. Bitte kurz warten.'), { statusCode: 429 });
}

async function derive(password, salt, iterations) {
    if (activeHashes >= 2) throw busyError();
    activeHashes++;
    try { return await pbkdf2(password, salt, iterations, HASH_KEY_LENGTH, HASH_ALGORITHM); }
    finally { activeHashes--; }
}

function authFingerprint() {
    return JSON.stringify([configManager.config.authEnabled, configManager.config.authUser,
        configManager.config.authPasswordHash, getLegacyAuthToken()]);
}

function getLegacyAuthToken() {
    return String(configManager.config.authToken || process.env.LOXHUE_AUTH_TOKEN || '').trim();
}

function isAuthEnabled() {
    return configManager.config.authEnabled === true || (!!getLegacyAuthToken() && configManager.config.authEnabled !== false);
}

async function hashPassword(password) {
    if (typeof password !== 'string' || password.length > 1024) throw new Error('Ungültiges Passwort.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, HASH_ITERATIONS)).toString('hex');
    return `pbkdf2$${HASH_ITERATIONS}$${salt}$${hash}`;
}

async function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || password.length > 1024) return false;
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = Buffer.from(parts[3], 'hex');
    if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 600000 ||
        !/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{64}$/i.test(parts[3])) return false;

    const actual = await derive(password, salt, iterations);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function extractBearerToken(req) {
    const header = req.headers?.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function extractBasicCredentials(req) {
    const header = req.headers?.authorization || '';
    const match = header.match(/^Basic\s+(.+)$/i);
    if (!match) return null;

    try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        return {
            user: separator >= 0 ? decoded.slice(0, separator) : '',
            password: separator >= 0 ? decoded.slice(separator + 1) : decoded
        };
    } catch (e) {
        return null;
    }
}

function extractBasicToken(req) {
    const credentials = extractBasicCredentials(req);
    return credentials ? credentials.password : null;
}

function requestHasValidToken(req, expectedToken = getLegacyAuthToken()) {
    if (!expectedToken) return false;
    const queryToken = req.query?.token;
    return queryToken === expectedToken ||
        extractBearerToken(req) === expectedToken ||
        extractBasicToken(req) === expectedToken;
}

async function requestHasValidPassword(req) {
    const credentials = extractBasicCredentials(req);
    if (!credentials) return false;

    const expectedUser = String(configManager.config.authUser || 'admin');
    if (credentials.user !== expectedUser) return false;
    const fingerprint = authFingerprint();
    const key = crypto.createHmac('sha256', cacheKey).update(JSON.stringify([fingerprint, credentials])).digest('hex');
    if (credentialCache.get(key) > Date.now()) return true;
    if (pendingChecks.has(key)) return pendingChecks.get(key);
    const check = (async () => {
        const valid = await verifyPassword(credentials.password, configManager.config.authPasswordHash);
        if (fingerprint !== authFingerprint()) return false;
        if (valid) {
            if (credentialCache.size >= 128) credentialCache.delete(credentialCache.keys().next().value);
            credentialCache.set(key, Date.now() + 60000);
        }
        return valid;
    })();
    pendingChecks.set(key, check);
    try { return await check; }
    finally { pendingChecks.delete(key); }
}

async function requestHasValidCredentials(req) {
    if (!isAuthEnabled()) return true;
    return requestHasValidToken(req) || await requestHasValidPassword(req);
}

function isSetupPath(path, isConfigured = configManager.isConfigured) {
    return !isConfigured;
}

function isControlPath(path, method = 'GET') {
    if (method !== 'GET') return false;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 2) return !['api', 'setup.html', 'description.xml', 'upnp', 'ssdp', 'xml'].includes(parts[0].toLowerCase());
    if (parts.length === 3 && parts[1].toLowerCase() === 'sunrise') return true;
    return false;
}

function needsAuth(req) {
    if (!isAuthEnabled()) return false;
    if (isSetupPath(req.path)) return false;
    if (isControlPath(req.path, req.method)) return false;
    return true;
}

async function requireAuth(req, res, next) {
    if (!needsAuth(req)) return next();
    const key = req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [address, value] of attempts) if (value.until <= now) attempts.delete(address);
    let entry = attempts.get(key);
    try {
        if (entry?.count >= 10) throw busyError();
        if (await requestHasValidCredentials(req)) {
            attempts.delete(key);
            return next();
        }
        if (req.headers?.authorization || req.query?.token) {
            if (!entry) {
                if (attempts.size >= 1024) throw busyError();
                entry = { count: 0, until: now + 60000 };
                attempts.set(key, entry);
            }
            entry.count++;
        }
        res.set('WWW-Authenticate', 'Basic realm="loxHueBridge"');
        return res.status(401).send('Unauthorized');
    } catch (error) {
        if (error.statusCode === 429) {
            res.set('Retry-After', '60');
            return res.status(429).send(error.message);
        }
        return next(error);
    }
}

module.exports = {
    requireAuth,
    hashPassword,
    verifyPassword,
    _internals: {
        getLegacyAuthToken,
        isAuthEnabled,
        hashPassword,
        verifyPassword,
        extractBearerToken,
        extractBasicCredentials,
        extractBasicToken,
        requestHasValidToken,
        requestHasValidPassword,
        requestHasValidCredentials,
        isSetupPath,
        isControlPath,
        needsAuth
    }
};
