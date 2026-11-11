require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const gopayClient = require('./src/gateway/gopayClient');
const paymentStore = require('./src/gateway/paymentStore');
const webhookEngine = require('./src/gateway/webhookEngine');
const apiKeyManager = require('./src/gateway/apiKeyManager');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const PAYMENT_PORT = parseInt(process.env.PAYMENT_PORT || '3001', 10);
const STORE_NAME = process.env.STORE_NAME || 'YuriDev';
const APP_NAME = process.env.APP_NAME || 'YURIPAY by myzert';
const STORE_LOGO_URL = process.env.STORE_LOGO_URL || '';
const STORE_WEBSITE_URL = process.env.STORE_WEBSITE_URL || '';
const DEFAULT_SUCCESS_THEME = process.env.DEFAULT_SUCCESS_THEME || 'anime';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'zertcihuy@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'zertcihuy@admin#123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'yuripay_super_secret_session_key_9981248712';
const PAYMENT_ROOT_REDIRECT_URL = process.env.PAYMENT_ROOT_REDIRECT_URL || process.env.STEALTH_REDIRECT_URL || STORE_WEBSITE_URL || 'https://github.com/myzert/YURIPAY-GOPAY';

/**
 * Detect client protocol (HTTPS / HTTP) respecting reverse proxies (Cloudflare, Nginx, cPanel)
 */
function getClientProtocol(req) {
    if (req.headers['x-forwarded-proto']) {
        return req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase();
    }
    if (req.headers['x-forwarded-ssl'] === 'on' || req.headers['front-end-https'] === 'on') {
        return 'https';
    }
    return req.protocol || (req.secure ? 'https' : 'http');
}

/**
 * Resolve Public Customer Checkout Gateway Base URL
 * Intelligently handles custom domains, reverse proxies (Nginx/Cloudflare/cPanel), and localhost
 */
function getPaymentBaseUrl(req) {
    if (process.env.PAYMENT_BASE_URL) {
        return process.env.PAYMENT_BASE_URL.replace(/\/$/, '');
    }
    if (process.env.PUBLIC_PAYMENT_URL) {
        return process.env.PUBLIC_PAYMENT_URL.replace(/\/$/, '');
    }
    if (process.env.APP_URL) {
        return process.env.APP_URL.replace(/\/$/, '');
    }

    const proto = getClientProtocol(req);
    const hostHeader = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    const hostWithoutPort = hostHeader.split(':')[0];
    const incomingPort = hostHeader.includes(':') ? hostHeader.split(':')[1] : null;

    const isLocalhost = hostWithoutPort === 'localhost' || hostWithoutPort === '127.0.0.1' || hostWithoutPort === '::1';
    const isRawIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostWithoutPort);

    // If request comes through a real domain name (production reverse proxy like pay.merchant.com)
    if (!isLocalhost && !isRawIp) {
        if (incomingPort && incomingPort !== '80' && incomingPort !== '443') {
            return `${proto}://${hostWithoutPort}:${incomingPort}`;
        }
        return `${proto}://${hostWithoutPort}`;
    }

    // Local / direct IP development
    const port = PAYMENT_PORT ? `:${PAYMENT_PORT}` : '';
    return `${proto}://${hostWithoutPort}${port}`;
}

/**
 * Resolve Internal Admin Dashboard Base URL
 */
function getDashboardBaseUrl(req) {
    if (process.env.DASHBOARD_BASE_URL) {
        return process.env.DASHBOARD_BASE_URL.replace(/\/$/, '');
    }
    const proto = getClientProtocol(req);
    const hostHeader = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    const hostWithoutPort = hostHeader.split(':')[0];
    const isLocalhost = hostWithoutPort === 'localhost' || hostWithoutPort === '127.0.0.1' || hostWithoutPort === '::1';
    const isRawIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostWithoutPort);

    if (!isLocalhost && !isRawIp) {
        return `${proto}://${hostWithoutPort}`;
    }
    const port = DASHBOARD_PORT ? `:${DASHBOARD_PORT}` : '';
    return `${proto}://${hostWithoutPort}${port}`;
}

function formatRupiah(number) {
    return 'Rp ' + Number(number || 0).toLocaleString('id-ID');
}

// ----------------------------------------------------
// CREATE DUAL EXPRESS APPS & SECURITY HARDENING
// ----------------------------------------------------
const dashboardApp = express();
const paymentApp = express();

// Disable x-powered-by to prevent server fingerprinting
dashboardApp.disable('x-powered-by');
paymentApp.disable('x-powered-by');

// Check if running in a Serverless environment (Vercel, AWS Lambda, Netlify)
const isServerless = !!(
    process.env.VERCEL || 
    process.env.AWS_LAMBDA_FUNCTION_NAME || 
    process.env.NETLIFY || 
    process.env.NOW_REGION || 
    process.env.SERVERLESS
);

if (isServerless) {
    console.error(`
================================================================
⚠️  PERINGATAN KRITIS: YURIPAY TIDAK BISA BERJALAN DI SERVERLESS (VERCEL/AWS LAMBDA)
================================================================
YuriPay dirancang secara fundamental sebagai DAEMON STATEFUL:
1. Realtime Background Polling: Membutuhkan event loop tanpa henti untuk
   mengecek mutasi GoPay setiap 2-3 detik. Serverless langsung membekukan
   (freeze) proses background setelah request selesai!
2. Persistent Database: Menggunakan SQLite WAL Mode yang membutuhkan
   akses disk I/O permanen. Di Vercel, filesystem bersifat read-only / ephemeral.
3. Dual-Port Socket Binding: YuriPay membuka dua port terisolasi secara
   bersamaan (Port ${DASHBOARD_PORT} & Port ${PAYMENT_PORT}). Serverless hanya mengizinkan 1 port per fungsi.

💡 SOLUSI: Deploy di VPS (Ubuntu/Debian, Docker, PM2, Railway, Coolify)
   atau jalankan langsung di Termux Android.
================================================================
    `);
}

// Security Headers Middleware
function applySecurityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
}

// In-Memory Sliding Window Rate Limiter (Zero external dependencies)
function createRateLimiter({ windowMs, maxRequests, message }) {
    const hits = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of hits.entries()) {
            if (now - record.startTime > windowMs) {
                hits.delete(ip);
            }
        }
    }, 5 * 60 * 1000).unref();

    return function rateLimitMiddleware(req, res, next) {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const record = hits.get(ip);

        if (!record || (now - record.startTime > windowMs)) {
            hits.set(ip, { count: 1, startTime: now });
            return next();
        }

        record.count++;
        if (record.count > maxRequests) {
            const retryAfterSec = Math.ceil((record.startTime + windowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfterSec);
            return res.status(429).json({
                success: false,
                error: 'TOO_MANY_REQUESTS',
                message: message || 'Terlalu banyak permintaan. Silakan tunggu beberapa saat.'
            });
        }

        next();
    };
}

// Rate limiters for security
const loginRateLimiter = createRateLimiter({
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
    message: 'Terlalu banyak percobaan login admin. Akses dibatasi sementara selama 5 menit demi keamanan.'
});

const createPaymentLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Batas pembuatan transaksi tercapai (Maks 60 trx/menit). Silakan coba sebentar lagi.'
});

const statusPollLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 150,
    message: 'Polling rate limit tercapai.'
});

// Middleware for Dashboard App (Port 3000)
dashboardApp.use(applySecurityHeaders);
dashboardApp.use(cors());
dashboardApp.use(express.json());
dashboardApp.use(express.urlencoded({ extended: true }));
dashboardApp.use(express.static(path.join(__dirname, 'public')));
dashboardApp.set('views', path.join(__dirname, 'views'));
dashboardApp.set('view engine', 'ejs');

// Session middleware for Dashboard Admin
dashboardApp.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Days
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Admin Authentication Guard Middleware
function requireAdminAuth(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/login');
}

// Middleware for Payment App (Port 3001) - Public facing
paymentApp.use(applySecurityHeaders);
paymentApp.use(cors());
paymentApp.use(express.json());
paymentApp.use(express.urlencoded({ extended: true }));
paymentApp.use(express.static(path.join(__dirname, 'public')));
paymentApp.set('views', path.join(__dirname, 'views'));
paymentApp.set('view engine', 'ejs');

// ====================================================
// SHARED HANDLER: CREATE PAYMENT API (WITH IDEMPOTENCY & VALIDATION)
// ====================================================
async function handleCreatePayment(req, res) {
    try {
        // 0. Authorization & Token Verification (Admin Session, Secret Key, or Public Key)
        const isSessionAdmin = req.session && req.session.isAdmin;
        const token = apiKeyManager.extractToken(req);
        let authType = 'session_admin';

        if (!isSessionAdmin) {
            if (!token) {
                return res.status(401).json({
                    success: false,
                    error: 'UNAUTHORIZED',
                    message: 'Akses ditolak: Gunakan header x-api-key atau Authorization: Bearer <SecretKey/PublicKey>'
                });
            }
            if (apiKeyManager.isSecretKeyValid(token)) {
                authType = 'secret_key';
            } else if (apiKeyManager.isPublicKeyValid(token)) {
                authType = 'public_key';
            } else {
                return res.status(403).json({
                    success: false,
                    error: 'INVALID_API_KEY',
                    message: 'Kunci API (Public Key / Secret Key) yang diberikan tidak valid.'
                });
            }
        }

        const rawNominal = req.body.nominal || req.body.amount;
        const rawOrderId = req.body.order_id || req.body.orderId || null;
        let customName = req.body.custom_name || req.body.memo || '';
        let redirectUrl = req.body.redirect_url || req.body.redirectUrl || '';
        let webhookUrl = req.body.webhook_url || req.body.callback_url || req.body.webhookUrl || '';
        const useUniqueCode = req.body.use_unique_code !== false && req.body.use_unique_code !== 'false';

        // 1. Strict Nominal Validation
        const baseAmount = parseInt(rawNominal, 10);
        if (isNaN(baseAmount) || baseAmount < 50 || baseAmount > 100000000) {
            return res.status(400).json({
                success: false,
                message: 'Nominal pembayaran tidak valid (Minimal Rp 50, Maksimal Rp 100.000.000)'
            });
        }

        // 2. Order ID Sanitization (alphanumeric, dash, underscore, dot, max 64 chars)
        let orderId = null;
        if (rawOrderId) {
            orderId = String(rawOrderId).trim().substring(0, 64);
            if (!/^[a-zA-Z0-9_\-\.]+$/.test(orderId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Format order_id tidak valid (hanya huruf, angka, strip, underscore, dan titik diperbolehkan)'
                });
            }
        }

        // 3. Custom Name Sanitization (strip HTML tags, max 80 chars)
        if (customName) {
            customName = String(customName).replace(/<[^>]*>?/gm, '').trim().substring(0, 80);
        } else {
            customName = orderId ? `Pesanan ${orderId}` : `Pembayaran ${STORE_NAME}`;
        }

        // 4. URL Validation (must be http:// or https:// if provided)
        if (redirectUrl) {
            redirectUrl = String(redirectUrl).trim();
            if (!/^https?:\/\//i.test(redirectUrl)) {
                return res.status(400).json({
                    success: false,
                    message: 'redirect_url harus berupa URL valid berawalan http:// atau https://'
                });
            }
        }

        if (webhookUrl) {
            webhookUrl = String(webhookUrl).trim();
            if (!/^https?:\/\//i.test(webhookUrl)) {
                return res.status(400).json({
                    success: false,
                    message: 'webhook_url harus berupa URL valid berawalan http:// atau https://'
                });
            }
        }

        const rawSuccessTheme = req.body.success_theme || req.body.successTheme || DEFAULT_SUCCESS_THEME;
        const successTheme = String(rawSuccessTheme).toLowerCase() === 'default' ? 'default' : 'anime';

        // Idempotency: If order_id exists and payment is already created,
        // it returns the exact existing payment rather than creating a new one!
        const payment = await paymentStore.createPayment({
            nominal: baseAmount,
            orderId,
            customName,
            redirectUrl,
            webhookUrl,
            successTheme,
            useUniqueCode
        });

        const baseUrl = getPaymentBaseUrl(req);
        const publicData = paymentStore.sanitizePublic(payment, baseUrl);
        const keys = apiKeyManager.getApiKeys();

        publicData.auth_type = authType;
        publicData.client_key = keys.publicKey;

        res.json({
            success: true,
            data: publicData
        });
    } catch (err) {
        console.error('[API Create Payment] Error:', err.message);
        res.status(500).json({ success: false, message: 'Gagal membuat tagihan pembayaran' });
    }
}

// ====================================================
// 1. DASHBOARD APP ROUTES (PORT 3000)
// ====================================================

// Login Page
dashboardApp.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/');
    }
    res.render('login', {
        appName: APP_NAME,
        storeName: STORE_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        error: null,
        email: ''
    });
});

// Login Form Submit (Rate Limited to prevent brute force)
dashboardApp.post('/login', loginRateLimiter, (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        req.session.adminEmail = email;
        return res.redirect('/');
    }
    res.render('login', {
        appName: APP_NAME,
        storeName: STORE_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        error: 'Email atau Kata Sandi admin salah! Silakan coba lagi.',
        email: email || ''
    });
});

// Logout
dashboardApp.get('/logout', (req, res) => {
    if (req.session) {
        req.session.destroy(() => {
            res.redirect('/login');
        });
    } else {
        res.redirect('/login');
    }
});

// Admin Dashboard UI (Protected)
dashboardApp.get('/', requireAdminAuth, (req, res) => {
    const session = gopayClient.getSessionInfo();
    const stats = paymentStore.getStats();
    const recentPayments = paymentStore.getRecentPayments(100);
    const baseUrl = getPaymentBaseUrl(req);
    const dashboardBaseUrl = getDashboardBaseUrl(req);
    const keys = apiKeyManager.getApiKeys();

    res.render('index', {
        storeName: STORE_NAME,
        appName: APP_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        storeWebsiteUrl: STORE_WEBSITE_URL,
        defaultSuccessTheme: DEFAULT_SUCCESS_THEME,
        apiKey: keys.secretKey,
        secretKey: keys.secretKey,
        publicKey: keys.publicKey,
        keysRotatedAt: keys.rotatedAt,
        adminEmail: req.session.adminEmail || ADMIN_EMAIL,
        paymentPort: PAYMENT_PORT,
        dashboardPort: DASHBOARD_PORT,
        baseUrl,
        dashboardBaseUrl,
        paymentBaseUrl: baseUrl,
        sessionValid: !!session?.access_token,
        stats,
        recentPayments,
        formatRupiah
    });
});

// Get Current API Keys (Admin only)
dashboardApp.get('/api/keys', requireAdminAuth, (req, res) => {
    res.json({ success: true, data: apiKeyManager.getApiKeys() });
});

// Regenerate API Keys (Admin only)
dashboardApp.post('/api/keys/regenerate', requireAdminAuth, (req, res) => {
    try {
        const newKeys = apiKeyManager.regenerateApiKeys();
        res.json({
            success: true,
            message: 'Kunci API (Public Key & Secret Key) berhasil digenerate ulang!',
            data: newKeys
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Interactive Webhook Test Dispatcher
dashboardApp.post('/api/test-webhook-dispatch', requireAdminAuth, async (req, res) => {
    const { webhook_url, amount, order_id } = req.body;
    if (!webhook_url) {
        return res.status(400).json({ success: false, message: 'URL Webhook wajib diisi' });
    }
    const testPayment = {
        id: `YURI-TEST-${Date.now().toString().slice(-6)}`,
        orderId: order_id || `ORDER-${Date.now().toString().slice(-6)}`,
        totalAmount: parseInt(amount || 50000, 10),
        webhookUrl: webhook_url,
        createdAt: new Date(),
        paidAt: new Date()
    };
    try {
        const result = await webhookEngine.sendNotification(testPayment);
        res.json({
            success: true,
            message: 'Simulasi notifikasi webhook berhasil dikirim ke server merchant',
            result
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: `Gagal mengirim webhook: ${err.message}`
        });
    }
});

// Redirect customer pay route from Port 3000 to Port 3001
dashboardApp.get('/pay/:id', (req, res) => {
    const { id } = req.params;
    const targetUrl = `${getPaymentBaseUrl(req)}/pay/${id}`;
    res.redirect(targetUrl);
});

// Create Payment from Dashboard / Kasir or External API (Rate Limited)
dashboardApp.post('/api/create-payment', createPaymentLimiter, handleCreatePayment);
dashboardApp.post('/api/create-qris', createPaymentLimiter, handleCreatePayment);

// Check Payment Status
dashboardApp.get('/api/check-payment/:id', async (req, res) => {
    const { id } = req.params;
    const result = await paymentStore.checkPaymentStatus(id);
    res.json(result);
});

// Recent GoPay Mutations (Settlement)
dashboardApp.get('/api/recent-mutations', requireAdminAuth, async (req, res) => {
    try {
        const mutations = await gopayClient.getRecentTransactions(8);
        const formatted = mutations.map(tx => {
            const rawAmt = parseInt(tx.gross_amount || tx.real_gross_amount || tx.amount || 0, 10);
            const amount = rawAmt > 100000 ? Math.round(rawAmt / 100) : rawAmt;
            return {
                id: tx.id || tx.order_id,
                time: tx.transaction_time || tx.settlement_time,
                amount,
                issuer: tx.qris_provider_aspi_issuer || tx.payment_type || 'GOPAY',
                status: tx.transaction_status || 'SETTLEMENT'
            };
        });
        res.json({ success: true, mutations: formatted });
    } catch (e) {
        res.json({ success: false, mutations: [] });
    }
});

// Dashboard Live Stats & Transactions Table API
dashboardApp.get('/api/dashboard-data', requireAdminAuth, (req, res) => {
    const stats = paymentStore.getStats();
    const recent = paymentStore.getRecentPayments(100);
    const webhookLogs = webhookEngine.getWebhookLogs(10);
    res.json({ success: true, stats, recent, webhookLogs });
});

// Webhook Delivery Logs API
dashboardApp.get('/api/webhook-logs', requireAdminAuth, (req, res) => {
    const logs = webhookEngine.getWebhookLogs(20);
    res.json({ success: true, logs });
});

// Dummy Webhook Receiver for testing Midtrans notifications
dashboardApp.post('/api/webhook-test', (req, res) => {
    console.log('[Webhook Test Receiver] Received Midtrans Notification:');
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).json({ status: 'OK', message: 'Notification received successfully' });
});

// ====================================================
// 2. PAYMENT APP ROUTES (PORT 3001) - CUSTOMER FACING
// ====================================================

// Customer Checkout Page
paymentApp.get('/pay/:id', async (req, res) => {
    const { id } = req.params;
    let payment = paymentStore.getPayment(id);

    if (!payment) {
        return res.status(404).render('checkout', {
            error: 'Tagihan pembayaran tidak ditemukan atau sudah dihapus.',
            storeName: STORE_NAME,
            appName: APP_NAME,
            storeLogoUrl: STORE_LOGO_URL,
            payment: null,
            formatRupiah
        });
    }

    // If still PENDING, run a quick check with GoPay before rendering
    // so if the user reloads or re-opens after paying, it immediately renders the PAID state!
    if (payment.status === 'PENDING') {
        try {
            await paymentStore.checkPaymentStatus(id);
            payment = paymentStore.getPayment(id);
        } catch (e) {
            console.warn('[Checkout SSR check warning]:', e.message);
        }
    }

    const baseUrl = getPaymentBaseUrl(req);
    const publicPayment = paymentStore.sanitizePublic(payment, baseUrl);

    res.render('checkout', {
        error: null,
        storeName: STORE_NAME,
        appName: APP_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        payment: publicPayment,
        formatRupiah
    });
});

// Public Status Poller for Customer Checkout Page (Rate Limited)
paymentApp.get('/api/payment-status/:id', statusPollLimiter, async (req, res) => {
    const { id } = req.params;
    const result = await paymentStore.checkPaymentStatus(id);
    res.json(result);
});

paymentApp.get('/api/check-payment/:id', statusPollLimiter, async (req, res) => {
    const { id } = req.params;
    const result = await paymentStore.checkPaymentStatus(id);
    res.json(result);
});

// Create Payment API also available on Port 3001 for developers (Rate Limited)
paymentApp.post('/api/create-payment', createPaymentLimiter, handleCreatePayment);

// ====================================================
// STEALTH REDIRECT FOR PORT 3001 (ANTI-SCANNER & BOT PROTECTION)
// ====================================================
// Otomatis mengalihkan root port pembayaran (localhost:3001/) ke Google atau GitHub YuriPay
// agar aman dari probe scanner, bot crawling, atau pihak tidak bertanggung jawab.
paymentApp.get('/', (req, res) => {
    res.redirect(302, PAYMENT_ROOT_REDIRECT_URL);
});

paymentApp.get('/pay', (req, res) => {
    res.redirect(302, PAYMENT_ROOT_REDIRECT_URL);
});

paymentApp.get('/pay/', (req, res) => {
    res.redirect(302, PAYMENT_ROOT_REDIRECT_URL);
});

// Catch-all for unknown routes on Port 3001: Stealth bounce to Google / GitHub
paymentApp.use((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return res.redirect(302, PAYMENT_ROOT_REDIRECT_URL);
    }
    res.status(404).json({ success: false, message: 'Resource Not Found' });
});

// ----------------------------------------------------
// START SERVERS ON BOTH PORTS
// ----------------------------------------------------
dashboardApp.listen(DASHBOARD_PORT, () => {
    console.log('================================================================');
    console.log(`📊 ${APP_NAME} DASHBOARD & KASIR: http://localhost:${DASHBOARD_PORT}`);
    console.log(`🔐 Admin: ${ADMIN_EMAIL} (Password Protected)`);
    console.log(`🏬 Merchant: ${STORE_NAME} | Keamanan Port Terisolasi`);
    console.log('================================================================');
});

paymentApp.listen(PAYMENT_PORT, () => {
    console.log('================================================================');
    console.log(`💳 ${APP_NAME} CUSTOMER CHECKOUT GATEWAY: http://localhost:${PAYMENT_PORT}/pay/:id`);
    console.log(`🔐 Port Customer Terpisah (Bebas dari Bocoran Token/Rahasia)`);
    console.log('================================================================');
});
