const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGS_FILE = path.join(__dirname, '../../database/system_logs.json');
const MAX_LOGS = 1000;

let logBuffer = [];

function loadLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            const raw = fs.readFileSync(LOGS_FILE, 'utf8');
            logBuffer = JSON.parse(raw || '[]');
        }
    } catch (e) {
        console.warn('[SystemLogger] Error loading logs:', e.message);
        logBuffer = [];
    }
}

function saveLogs() {
    try {
        const dir = path.dirname(LOGS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logBuffer.slice(0, MAX_LOGS), null, 2), 'utf8');
    } catch (e) {
        console.error('[SystemLogger] Error saving logs:', e.message);
    }
}

// Initial load
loadLogs();

function extractReqMeta(req) {
    if (!req) return { ip: 'system', userAgent: 'internal' };
    const ip = req.headers?.['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers?.['user-agent'] || 'unknown';
    return {
        ip: String(ip).replace('::ffff:', ''),
        userAgent: String(userAgent).substring(0, 150)
    };
}

/**
 * Core log recording function
 */
function recordLog({
    category = 'SYSTEM',
    severity = 'INFO',
    action = 'EVENT',
    message = '',
    ip = 'system',
    userAgent = 'internal',
    details = null
}) {
    const entry = {
        id: 'LOG-' + crypto.randomUUID().substring(0, 8).toUpperCase(),
        timestamp: new Date().toISOString(),
        category: String(category).toUpperCase(),
        severity: String(severity).toUpperCase(),
        action: String(action).toUpperCase(),
        message: String(message),
        ip: String(ip).replace('::ffff:', ''),
        userAgent: String(userAgent).substring(0, 150),
        details: details || {}
    };

    logBuffer.unshift(entry);
    if (logBuffer.length > MAX_LOGS) {
        logBuffer = logBuffer.slice(0, MAX_LOGS);
    }

    // Debounced or direct save
    saveLogs();
    return entry;
}

function logActivity(action, message, details = {}, req = null) {
    const meta = extractReqMeta(req);
    return recordLog({
        category: 'ACTIVITY',
        severity: 'INFO',
        action,
        message,
        ip: meta.ip,
        userAgent: meta.userAgent,
        details
    });
}

function logAuth(action, message, severity = 'SUCCESS', req = null, details = {}) {
    const meta = extractReqMeta(req);
    return recordLog({
        category: 'AUTH',
        severity,
        action,
        message,
        ip: meta.ip,
        userAgent: meta.userAgent,
        details
    });
}

function logSystem(action, message, severity = 'INFO', details = {}) {
    return recordLog({
        category: 'SYSTEM',
        severity,
        action,
        message,
        ip: 'system',
        userAgent: 'internal-daemon',
        details
    });
}

function logPayment(action, message, severity = 'INFO', details = {}) {
    return recordLog({
        category: 'PAYMENT',
        severity,
        action,
        message,
        ip: details.ip || 'gateway',
        userAgent: details.userAgent || 'payment-engine',
        details
    });
}

function logWebhook(action, message, severity = 'SUCCESS', details = {}) {
    return recordLog({
        category: 'WEBHOOK',
        severity,
        action,
        message,
        ip: 'webhook-worker',
        userAgent: 'yuripay-notifier',
        details
    });
}

function logError(action, message, error = null, req = null, details = {}) {
    const meta = extractReqMeta(req);
    const errDetails = {
        ...details,
        errorMessage: error?.message || String(error || ''),
        errorStack: error?.stack ? error.stack.substring(0, 500) : null
    };
    return recordLog({
        category: 'ERROR',
        severity: 'ERROR',
        action,
        message,
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: errDetails
    });
}

/**
 * Filtered retrieval for dashboard UI
 */
function getLogs({ category = 'ALL', severity = 'ALL', search = '', limit = 50, offset = 0 } = {}) {
    let result = logBuffer;

    if (category && category !== 'ALL') {
        const catUpper = category.toUpperCase();
        result = result.filter(l => l.category === catUpper);
    }

    if (severity && severity !== 'ALL') {
        const sevUpper = severity.toUpperCase();
        result = result.filter(l => l.severity === sevUpper);
    }

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        result = result.filter(l => {
            const msgMatch = (l.message || '').toLowerCase().includes(q);
            const actionMatch = (l.action || '').toLowerCase().includes(q);
            const ipMatch = (l.ip || '').toLowerCase().includes(q);
            const idMatch = (l.id || '').toLowerCase().includes(q);
            const detailsMatch = JSON.stringify(l.details || {}).toLowerCase().includes(q);
            return msgMatch || actionMatch || ipMatch || idMatch || detailsMatch;
        });
    }

    const total = result.length;
    const paginated = result.slice(offset, offset + limit);

    return {
        total,
        limit,
        offset,
        logs: paginated
    };
}

function getLogStats() {
    const stats = {
        total: logBuffer.length,
        byCategory: {
            ACTIVITY: 0,
            AUTH: 0,
            SYSTEM: 0,
            PAYMENT: 0,
            WEBHOOK: 0,
            ERROR: 0
        },
        bySeverity: {
            INFO: 0,
            SUCCESS: 0,
            WARNING: 0,
            ERROR: 0,
            CRITICAL: 0
        }
    };

    for (const l of logBuffer) {
        if (stats.byCategory[l.category] !== undefined) stats.byCategory[l.category]++;
        if (stats.bySeverity[l.severity] !== undefined) stats.bySeverity[l.severity]++;
    }

    return stats;
}

module.exports = {
    recordLog,
    logActivity,
    logAuth,
    logSystem,
    logPayment,
    logWebhook,
    logError,
    getLogs,
    getLogStats
};
