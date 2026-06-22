const configManager = require('./config');

function getAuthToken() {
    return String(configManager.config.authToken || process.env.LOXHUE_AUTH_TOKEN || '').trim();
}

function extractBearerToken(req) {
    const header = req.headers?.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function extractBasicToken(req) {
    const header = req.headers?.authorization || '';
    const match = header.match(/^Basic\s+(.+)$/i);
    if (!match) return null;

    try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        return separator >= 0 ? decoded.slice(separator + 1) : decoded;
    } catch (e) {
        return null;
    }
}

function requestHasValidToken(req, expectedToken = getAuthToken()) {
    if (!expectedToken) return true;
    const queryToken = req.query?.token;
    return queryToken === expectedToken ||
        extractBearerToken(req) === expectedToken ||
        extractBasicToken(req) === expectedToken;
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
    const token = getAuthToken();
    if (!token) return false;
    if (isSetupPath(req.path)) return false;
    if (isControlPath(req.path, req.method)) return false;
    return true;
}

function requireAuth(req, res, next) {
    const token = getAuthToken();
    if (!token || !needsAuth(req) || requestHasValidToken(req, token)) return next();

    res.set('WWW-Authenticate', 'Basic realm="loxHueBridge"');
    return res.status(401).send('Unauthorized');
}

module.exports = {
    requireAuth,
    _internals: {
        getAuthToken,
        extractBearerToken,
        extractBasicToken,
        requestHasValidToken,
        isSetupPath,
        isControlPath,
        needsAuth
    }
};
