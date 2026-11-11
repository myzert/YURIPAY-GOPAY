const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_FILE_GATEWAY = path.join(__dirname, '.GOPAY_SESI_JANGAN_DIHAPUS.json');
const SESSION_FILE_ROOT = path.join(__dirname, '../../.GOPAY_SESI_JANGAN_DIHAPUS.json');

const GOBIZ_REQUEST_OTP_URL = 'https://api.gobiz.co.id/goid/login/request';
const GOBIZ_TOKEN_URL = 'https://api.gobiz.co.id/goid/token';
const GOBIZ_CONFIG_URL = 'https://api.gobiz.co.id/goresto/v5/public/users/config';

// Modern, realistic Chrome desktop User-Agent
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Persistent or cached BrowserId (x-uniqueid)
let persistentUniqueId = null;

function getPersistentUniqueId() {
    if (!persistentUniqueId) {
        // Try reading existing session to reuse unique ID if available
        const s = loadSession();
        persistentUniqueId = s?.unique_id || crypto.randomUUID();
    }
    return persistentUniqueId;
}

// Dynamic appversion cache
let cachedAppVersion = 'platform-v3.129.0-edffae48';
let lastVersionFetch = 0;

/**
 * Fetch latest production build tag from GoBiz Merchant portal
 */
async function getLatestAppVersion() {
    const now = Date.now();
    if (now - lastVersionFetch < 30 * 60 * 1000 && cachedAppVersion) {
        return cachedAppVersion;
    }
    try {
        const res = await axios.get('https://portal.gofoodmerchant.co.id/login', {
            timeout: 5000,
            headers: { 'User-Agent': DEFAULT_USER_AGENT }
        });
        const match = res.data.match(/REACT_APP_DOCKER_IMAGE_TAG\":\s*\"([^\"]+)\"/);
        if (match && match[1]) {
            cachedAppVersion = match[1];
            lastVersionFetch = now;
            return cachedAppVersion;
        }
    } catch (e) {
        // Use latest known stable tag
    }
    return cachedAppVersion || 'platform-v3.129.0-edffae48';
}

/**
 * Generate standard GoBiz request headers matching the official portal
 */
async function getGoBizHeaders(userAgent = DEFAULT_USER_AGENT, accessToken = null, uniqueId = null) {
    const appVersion = await getLatestAppVersion();
    const uid = uniqueId || getPersistentUniqueId();

    const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'id',
        'authentication-type': 'go-id',
        'content-type': 'application/json',
        'gojek-country-code': 'ID',
        'gojek-timezone': 'Asia/Jakarta',
        'origin': 'https://portal.gofoodmerchant.co.id',
        'referer': 'https://portal.gofoodmerchant.co.id/',
        'user-agent': userAgent,
        'x-appid': 'go-biz-web-dashboard',
        'x-appversion': appVersion,
        'x-deviceos': 'Web',
        'x-phonemake': 'Windows 10 64-bit',
        'x-phonemodel': 'Chrome 131.0.0.0 on Windows 10 64-bit',
        'x-platform': 'Web',
        'x-uniqueid': uid,
        'x-user-locale': 'id-ID',
        'x-user-type': 'merchant'
    };

    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
        headers['Cookie'] = `access_token=${accessToken}; auth_method=goid`;
    }

    return headers;
}

/**
 * Request OTP via SMS/WA from GoBiz
 * @param {string} phoneNumber - Example: '085119772671' or '+6285119772671'
 */
async function requestOtp(phoneNumber) {
    let cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('62')) {
        cleanPhone = cleanPhone.substring(2);
    } else if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
    }

    const uniqueId = getPersistentUniqueId();
    const headers = await getGoBizHeaders(DEFAULT_USER_AGENT, null, uniqueId);

    const payload = {
        client_id: 'go-biz-web-new',
        phone_number: cleanPhone,
        country_code: '62'
    };

    try {
        const response = await axios.post(GOBIZ_REQUEST_OTP_URL, payload, {
            headers,
            timeout: 12000
        });

        if (response.data && response.data.data && response.data.data.otp_token) {
            return {
                success: true,
                otp_token: response.data.data.otp_token,
                expires_in: response.data.data.otp_expires_in || response.data.data.expires_in || 720,
                phone: `+62${cleanPhone}`,
                unique_id: uniqueId
            };
        }

        return {
            success: false,
            message: response.data?.errors?.[0]?.message || 'Gagal mengirim OTP dari server GoBiz'
        };
    } catch (err) {
        const errMsg = err.response?.data?.errors?.[0]?.message || err.response?.data?.message || err.message;
        return {
            success: false,
            message: errMsg
        };
    }
}

/**
 * Verify OTP code and save session
 * @param {string} otpCode - 4 digit OTP code
 * @param {string} otpToken - Token received from requestOtp
 * @param {string} formattedPhone - E.g. '+6285119772671'
 * @param {string} uniqueId - The exact same uniqueId used when requesting OTP
 */
async function verifyOtp(otpCode, otpToken, formattedPhone = '', uniqueId = null) {
    const uid = uniqueId || getPersistentUniqueId();
    const headers = await getGoBizHeaders(DEFAULT_USER_AGENT, null, uid);

    const payload = {
        client_id: 'go-biz-web-new',
        grant_type: 'otp',
        data: {
            otp: String(otpCode).trim(),
            otp_token: String(otpToken).trim()
        }
    };

    try {
        const response = await axios.post(GOBIZ_TOKEN_URL, payload, {
            headers,
            timeout: 12000
        });

        const tokenData = response.data?.data || response.data;
        if (!tokenData || !tokenData.access_token) {
            return {
                success: false,
                message: 'Verifikasi gagal: access_token tidak ditemukan dalam respon GoBiz.'
            };
        }

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const expiresInSeconds = tokenData.expires_in || 86400 * 30; // 30 Days
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

        // Fetch merchant and outlet info
        let merchantId = process.env.GOPAY_MERCHANT_ID || 'G538138242';
        let outletName = 'Outlet GoBiz Merchant';

        try {
            const configHeaders = await getGoBizHeaders(DEFAULT_USER_AGENT, accessToken, uid);
            const configRes = await axios.get(GOBIZ_CONFIG_URL, {
                headers: configHeaders,
                timeout: 8000
            });

            const configData = configRes.data?.data || configRes.data;
            if (configData && configData.merchants && configData.merchants.length > 0) {
                const firstMerchant = configData.merchants[0];
                merchantId = firstMerchant.id || merchantId;
                outletName = firstMerchant.name || firstMerchant.restaurant_name || outletName;
            } else if (configData && configData.user) {
                outletName = configData.user.name || outletName;
            }
        } catch (confErr) {
            console.warn('[GoPayAuth] Could not fetch user config, using fallback:', confErr.message);
        }

        const sessionData = {
            phone_number: formattedPhone,
            merchant_id: merchantId,
            outlet_name: outletName,
            access_token: accessToken,
            refresh_token: refreshToken,
            unique_id: uid,
            cookie: `access_token=${accessToken}; refresh_token=${refreshToken}; auth_method=goid`,
            updated_at: new Date().toISOString(),
            expires_at: expiresAt
        };

        // Save to file
        saveSession(sessionData);

        return {
            success: true,
            message: 'Login OTP GoBiz berhasil!',
            session: sessionData
        };
    } catch (err) {
        const errObj = err.response?.data?.errors?.[0];
        const errMsg = errObj?.message || err.response?.data?.message || err.message;
        const errTitle = errObj?.message_title ? ` [${errObj.message_title}]` : '';
        return {
            success: false,
            message: `Verifikasi OTP Gagal: ${errMsg}${errTitle}`
        };
    }
}

/**
 * Save manual session from access token / cookie
 */
async function saveManualSession(rawInput, formattedPhone = '', customMerchantId = null) {
    let accessToken = rawInput.trim();
    let refreshToken = '';

    // If input contains full cookie string
    if (accessToken.includes('access_token=')) {
        const match = accessToken.match(/access_token=([^;]+)/);
        if (match) accessToken = match[1];
    }
    if (rawInput.includes('refresh_token=')) {
        const matchRef = rawInput.match(/refresh_token=([^;]+)/);
        if (matchRef) refreshToken = matchRef[1];
    }

    // Strip "Bearer " prefix if user pasted full header
    accessToken = accessToken.replace(/^Bearer\s+/i, '').trim();

    if (!accessToken || accessToken.length < 20) {
        return { success: false, message: 'Format access_token tidak valid atau terlalu pendek.' };
    }

    const uid = getPersistentUniqueId();
    let merchantId = customMerchantId || process.env.GOPAY_MERCHANT_ID || 'G538138242';
    let outletName = 'Outlet GoBiz Merchant';

    // Verify token validity by checking GoBiz config endpoint
    try {
        const configHeaders = await getGoBizHeaders(DEFAULT_USER_AGENT, accessToken, uid);
        const configRes = await axios.get(GOBIZ_CONFIG_URL, {
            headers: configHeaders,
            timeout: 8000
        });

        const configData = configRes.data?.data || configRes.data;
        if (configData && configData.merchants && configData.merchants.length > 0) {
            const firstMerchant = configData.merchants[0];
            merchantId = firstMerchant.id || merchantId;
            outletName = firstMerchant.name || firstMerchant.restaurant_name || outletName;
        } else if (configData && configData.user) {
            outletName = configData.user.name || outletName;
        }
    } catch (err) {
        // If config endpoint rejects, token might be invalid or expired
        console.warn('[GoPayAuth] Token check warning:', err.response?.data || err.message);
    }

    const sessionData = {
        phone_number: formattedPhone || '-',
        merchant_id: merchantId,
        outlet_name: outletName,
        access_token: accessToken,
        refresh_token: refreshToken || accessToken,
        unique_id: uid,
        cookie: `access_token=${accessToken}; auth_method=goid`,
        updated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };

    saveSession(sessionData);
    return {
        success: true,
        session: sessionData
    };
}

/**
 * Save session to both locations
 */
function saveSession(data) {
    try {
        // Save to src/gateway/.GOPAY_SESI_JANGAN_DIHAPUS.json
        fs.writeFileSync(SESSION_FILE_GATEWAY, JSON.stringify(data, null, 2), 'utf8');
        // Save to root directory .GOPAY_SESI_JANGAN_DIHAPUS.json
        fs.writeFileSync(SESSION_FILE_ROOT, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[GoPayAuth] Save session error:', e.message);
        return false;
    }
}

/**
 * Load session from file
 */
function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE_GATEWAY)) {
            return JSON.parse(fs.readFileSync(SESSION_FILE_GATEWAY, 'utf8'));
        }
        if (fs.existsSync(SESSION_FILE_ROOT)) {
            return JSON.parse(fs.readFileSync(SESSION_FILE_ROOT, 'utf8'));
        }
    } catch (e) {}
    return null;
}

module.exports = {
    requestOtp,
    verifyOtp,
    saveManualSession,
    saveSession,
    loadSession,
    getGoBizHeaders,
    getLatestAppVersion,
    SESSION_FILE: SESSION_FILE_GATEWAY
};
