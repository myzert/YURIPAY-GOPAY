const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../database/settings.json');
const AUDIT_LOG_FILE = path.join(__dirname, '../../database/audit_logs.json');

// Memory buffer for fast audit log access (last 100 entries)
let auditLogs = [];

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
        }
    } catch (e) {
        console.warn('[AdminAuth] Error loading settings file:', e.message);
    }
    return {};
}

function saveSettings(settings) {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
        console.error('[AdminAuth] Error saving settings file:', e.message);
    }
}

function loadAuditLogs() {
    try {
        if (fs.existsSync(AUDIT_LOG_FILE)) {
            auditLogs = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, 'utf8') || '[]');
        }
    } catch (e) {
        auditLogs = [];
    }
}

function saveAuditLogs() {
    try {
        const dir = path.dirname(AUDIT_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(auditLogs.slice(-100), null, 2), 'utf8');
    } catch (e) {
        console.error('[AdminAuth] Error saving audit logs:', e.message);
    }
}

// Initial load
loadAuditLogs();

/**
 * Hash a password using PBKDF2 with SHA-512 (NIST Approved, 100,000 iterations)
 */
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

/**
 * Record an event to the security audit trail
 */
function recordAuditLog({ action, ip = 'unknown', userAgent = 'unknown', status = 'SUCCESS', details = '' }) {
    const entry = {
        id: 'LOG-' + crypto.randomUUID().substring(0, 8).toUpperCase(),
        timestamp: new Date().toISOString(),
        action,
        status,
        ip: String(ip).replace('::ffff:', ''),
        userAgent: String(userAgent).substring(0, 100),
        details: String(details)
    };
    auditLogs.unshift(entry);
    if (auditLogs.length > 100) {
        auditLogs = auditLogs.slice(0, 100);
    }
    saveAuditLogs();
    return entry;
}

/**
 * Get current admin email
 */
function getAdminEmail() {
    const s = loadSettings();
    if (s.admin_email) return s.admin_email;
    if (process.env.ADMIN_EMAIL) return process.env.ADMIN_EMAIL;
    return 'admin@example.com';
}

/**
 * Verify admin login credentials
 * Seamlessly verifies against PBKDF2 hash, or initial .env password with auto-migration to hash
 */
function verifyLogin(email, password, reqMeta = {}) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPassword = String(password || '').trim();
    const currentEmail = getAdminEmail().toLowerCase();

    const s = loadSettings();
    let isPasswordCorrect = false;

    if (cleanEmail !== currentEmail) {
        recordAuditLog({
            action: 'ADMIN_LOGIN_FAILED',
            ip: reqMeta.ip,
            userAgent: reqMeta.userAgent,
            status: 'FAILED',
            details: `Email tidak cocok (${cleanEmail})`
        });
        return { success: false, message: 'Email atau kata sandi admin tidak cocok!' };
    }

    if (s.admin_password_hash && s.admin_password_salt) {
        const testHash = hashPassword(cleanPassword, s.admin_password_salt);
        isPasswordCorrect = crypto.timingSafeEqual(
            Buffer.from(testHash, 'hex'),
            Buffer.from(s.admin_password_hash, 'hex')
        );
    } else {
        // Fallback to .env password if no custom hash has been generated yet
        const envPassword = process.env.ADMIN_PASSWORD || 'admin#yuripay2026';
        isPasswordCorrect = (cleanPassword === envPassword);

        // Auto-migrate to secure PBKDF2 hash on first successful login
        if (isPasswordCorrect) {
            const salt = crypto.randomBytes(16).toString('hex');
            const hash = hashPassword(cleanPassword, salt);
            s.admin_email = currentEmail;
            s.admin_password_salt = salt;
            s.admin_password_hash = hash;
            s.admin_credentials_updated_at = new Date().toISOString();
            saveSettings(s);
        }
    }

    if (isPasswordCorrect) {
        recordAuditLog({
            action: 'ADMIN_LOGIN_SUCCESS',
            ip: reqMeta.ip,
            userAgent: reqMeta.userAgent,
            status: 'SUCCESS',
            details: `Login berhasil untuk ${currentEmail}`
        });
        return { success: true, email: currentEmail };
    } else {
        recordAuditLog({
            action: 'ADMIN_LOGIN_FAILED',
            ip: reqMeta.ip,
            userAgent: reqMeta.userAgent,
            status: 'FAILED',
            details: `Kata sandi salah untuk ${currentEmail}`
        });
        return { success: false, message: 'Email atau kata sandi admin tidak cocok!' };
    }
}

/**
 * Manually update admin email & password with strong verification
 */
function updateCredentials({ currentPassword, newEmail, newPassword, confirmPassword }, reqMeta = {}) {
    if (!currentPassword) {
        return { success: false, message: 'Kata sandi saat ini wajib diisi untuk verifikasi keamanan!' };
    }

    const currentEmail = getAdminEmail();
    const loginCheck = verifyLogin(currentEmail, currentPassword, { ip: reqMeta.ip, userAgent: 'internal_verify' });
    if (!loginCheck.success) {
        return { success: false, message: 'Kata sandi saat ini salah! Perubahan kredensial ditolak.' };
    }

    const s = loadSettings();
    let updatedFields = [];

    // 1. Update Email if provided
    if (newEmail && newEmail.trim()) {
        const cleanNewEmail = newEmail.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanNewEmail)) {
            return { success: false, message: 'Format email baru tidak valid!' };
        }
        s.admin_email = cleanNewEmail;
        updatedFields.push('email');
    }

    // 2. Update Password if provided
    if (newPassword && newPassword.trim()) {
        const cleanNewPass = newPassword.trim();
        if (cleanNewPass.length < 8) {
            return { success: false, message: 'Kata sandi baru minimal harus 8 karakter demi keamanan!' };
        }
        if (confirmPassword && cleanNewPass !== confirmPassword.trim()) {
            return { success: false, message: 'Konfirmasi kata sandi tidak cocok dengan kata sandi baru!' };
        }

        const newSalt = crypto.randomBytes(16).toString('hex');
        const newHash = hashPassword(cleanNewPass, newSalt);

        s.admin_password_salt = newSalt;
        s.admin_password_hash = newHash;
        updatedFields.push('password');
    }

    if (updatedFields.length === 0) {
        return { success: false, message: 'Tidak ada perubahan yang dikirimkan.' };
    }

    s.admin_credentials_updated_at = new Date().toISOString();
    saveSettings(s);

    recordAuditLog({
        action: 'ADMIN_CREDENTIALS_UPDATED',
        ip: reqMeta.ip,
        userAgent: reqMeta.userAgent,
        status: 'SUCCESS',
        details: `Kredensial diperbarui: ${updatedFields.join(', ')}`
    });

    return {
        success: true,
        message: `Kredensial admin (${updatedFields.join(' & ')}) berhasil diperbarui secara permanen!`,
        email: s.admin_email || currentEmail
    };
}

/**
 * Get public security status & audit logs for dashboard view
 */
function getSecurityOverview() {
    const s = loadSettings();
    return {
        adminEmail: getAdminEmail(),
        isCustomPasswordSet: !!(s.admin_password_hash && s.admin_password_salt),
        updatedAt: s.admin_credentials_updated_at || null,
        encryptionType: 'PBKDF2-SHA512 (100k Iterations)',
        auditLogs: auditLogs.slice(0, 30),
        totalAuditLogs: auditLogs.length
    };
}

module.exports = {
    getAdminEmail,
    verifyLogin,
    updateCredentials,
    recordAuditLog,
    getSecurityOverview
};
