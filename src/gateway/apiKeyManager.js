const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let db = null;
try {
    db = require('../database/db');
} catch (e) {
    console.warn('[ApiKeyManager] DB load notice (using fallback JSON store):', e.message);
}

const FALLBACK_FILE = path.join(__dirname, '../../database/settings.json');

function readSetting(key) {
    if (db && typeof db.getSetting === 'function') {
        try {
            const val = db.getSetting(key);
            if (val !== undefined && val !== null) return val;
        } catch (e) {}
    }
    try {
        if (fs.existsSync(FALLBACK_FILE)) {
            const json = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8') || '{}');
            return json[key];
        }
    } catch (e) {}
    return null;
}

function writeSetting(key, value) {
    if (db && typeof db.setSetting === 'function') {
        try {
            db.setSetting(key, value);
        } catch (e) {}
    }
    try {
        const dir = path.dirname(FALLBACK_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let json = {};
        if (fs.existsSync(FALLBACK_FILE)) {
            json = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8') || '{}');
        }
        json[key] = value;
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(json, null, 2), 'utf8');
    } catch (e) {}
}

/**
 * Generate cryptographically secure random API key with prefix
 */
function generateKey(prefix = 'sk_live') {
    const randomHex = crypto.randomBytes(16).toString('hex');
    return `${prefix}_${randomHex}`;
}

/**
 * Initialize and load API keys from SQLite / fallback settings
 */
function initApiKeys() {
    let pubKey = readSetting('api_public_key');
    let secKey = readSetting('api_secret_key');
    let rotatedAt = readSetting('api_keys_rotated_at');

    if (!secKey) {
        secKey = process.env.API_SECRET_KEY || process.env.API_KEY;
        if (!secKey || !secKey.startsWith('sk_')) {
            secKey = generateKey('sk_live');
        }
        writeSetting('api_secret_key', secKey);
    }

    if (!pubKey) {
        pubKey = process.env.API_PUBLIC_KEY;
        if (!pubKey || !pubKey.startsWith('pk_')) {
            pubKey = generateKey('pk_live');
        }
        writeSetting('api_public_key', pubKey);
    }

    if (!rotatedAt) {
        rotatedAt = new Date().toISOString();
        writeSetting('api_keys_rotated_at', rotatedAt);
    }

    return { publicKey: pubKey, secretKey: secKey, rotatedAt };
}

/**
 * Get current API Keys
 */
function getApiKeys() {
    const publicKey = readSetting('api_public_key') || process.env.API_PUBLIC_KEY;
    const secretKey = readSetting('api_secret_key') || process.env.API_SECRET_KEY || process.env.API_KEY;
    const rotatedAt = readSetting('api_keys_rotated_at') || new Date().toISOString();
    return { publicKey, secretKey, rotatedAt };
}

/**
 * Regenerate new pair of Public Key and Secret Key
 */
function regenerateApiKeys() {
    const newPublicKey = generateKey('pk_live');
    const newSecretKey = generateKey('sk_live');
    const rotatedAt = new Date().toISOString();

    writeSetting('api_public_key', newPublicKey);
    writeSetting('api_secret_key', newSecretKey);
    writeSetting('api_keys_rotated_at', rotatedAt);

    console.log(`[ApiKeyManager] API Keys successfully rotated at ${rotatedAt}`);
    return {
        publicKey: newPublicKey,
        secretKey: newSecretKey,
        rotatedAt
    };
}

/**
 * Extract token from request (Headers: x-api-key, Authorization: Bearer <key>, or query param)
 */
function extractToken(req) {
    if (req.headers && req.headers['x-api-key']) {
        return req.headers['x-api-key'].trim();
    }
    if (req.headers && req.headers['authorization']) {
        const parts = req.headers['authorization'].split(' ');
        if (parts.length === 2 && (parts[0].toLowerCase() === 'bearer' || parts[0].toLowerCase() === 'basic')) {
            return parts[1].trim();
        }
    }
    if (req.query && req.query.api_key) {
        return String(req.query.api_key).trim();
    }
    if (req.body && req.body.api_key) {
        return String(req.body.api_key).trim();
    }
    return null;
}

/**
 * Validate token against Secret Key (Full backend administrative privileges)
 */
function isSecretKeyValid(token) {
    if (!token) return false;
    const { secretKey } = getApiKeys();
    const envKey = process.env.API_KEY;
    const envSecret = process.env.API_SECRET_KEY;
    return token === secretKey || token === envKey || token === envSecret;
}

/**
 * Validate token against Public Key (Client-side / checkout privileges)
 */
function isPublicKeyValid(token) {
    if (!token) return false;
    const { publicKey } = getApiKeys();
    const envPublic = process.env.API_PUBLIC_KEY;
    return token === publicKey || token === envPublic;
}

/**
 * Middleware: Require Secret Key (or authenticated admin session)
 */
function requireSecretKey(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'UNAUTHORIZED',
            message: 'Akses ditolak: Masukkan Secret Key (sk_live_...) pada header x-api-key atau Authorization: Bearer <token>'
        });
    }
    if (!isSecretKeyValid(token)) {
        return res.status(403).json({
            success: false,
            error: 'INVALID_SECRET_KEY',
            message: 'Secret Key tidak valid. Periksa Secret Key pada dashboard YuriPay Anda.'
        });
    }
    req.apiKeyRole = 'secret';
    next();
}

/**
 * Middleware: Allow either Secret Key OR Public Key (or admin session)
 */
function requireAnyApiKey(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'UNAUTHORIZED',
            message: 'Akses ditolak: Masukkan Public Key (pk_live_...) atau Secret Key (sk_live_...) pada header'
        });
    }
    if (isSecretKeyValid(token)) {
        req.apiKeyRole = 'secret';
        return next();
    }
    if (isPublicKeyValid(token)) {
        req.apiKeyRole = 'public';
        return next();
    }
    return res.status(403).json({
        success: false,
        error: 'INVALID_API_KEY',
        message: 'Kunci API (Public/Secret Key) yang diberikan tidak valid.'
    });
}

// Initialize on module load
initApiKeys();

module.exports = {
    generateKey,
    getApiKeys,
    regenerateApiKeys,
    extractToken,
    isSecretKeyValid,
    isPublicKeyValid,
    requireSecretKey,
    requireAnyApiKey
};
