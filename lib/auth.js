const crypto = require('crypto');
const configManager = require('./config');

const HASH_ALGORITHM = 'sha256';
const HASH_ITERATIONS = 210000;
const HASH_KEY_LENGTH = 32;

function getLegacyAuthToken() {
    return String(configManager.config.authToken || process.env.LOXHUE_AUTH_TOKEN || '').trim();
}

function isAuthEnabled() {
    return configManager.config.authEnabled === true || (!!getLegacyAuthToken() && configManager.config.authEnabled !== false);
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(String(password), salt, HASH_ITERATIONS, HASH_KEY_LENGTH, HASH_ALGORITHM).toString('hex');
    return `pbkdf2$${HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = Buffer.from(parts[3], 'hex');
    if (!Number.isSafeInteger(iterations) || !salt || expected.length === 0) return false;

    const actual = crypto.pbkdf2Sync(String(password), salt, iterations, expected.length, HASH_ALGORITHM);
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

function requestHasValidPassword(req) {
    const credentials = extractBasicCredentials(req);
    if (!credentials) return false;

    const expectedUser = String(configManager.config.authUser || 'admin');
    return credentials.user === expectedUser &&
        verifyPassword(credentials.password, configManager.config.authPasswordHash);
}

function requestHasValidCredentials(req) {
    if (!isAuthEnabled()) return true;
    return requestHasValidPassword(req) || requestHasValidToken(req);
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

function requireAuth(req, res, next) {
    if (!needsAuth(req) || requestHasValidCredentials(req)) return next();

    res.set('WWW-Authenticate', 'Basic realm="loxHueBridge"');
    return res.status(401).send('Unauthorized');
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
