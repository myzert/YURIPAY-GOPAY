require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const gopayClient = require('./src/gateway/gopayClient');
const paymentStore = require('./src/gateway/paymentStore');
const webhookEngine = require('./src/gateway/webhookEngine');
const apiKeyManager = require('./src/gateway/apiKeyManager');
const adminAuth = require('./src/gateway/adminAuth');
const systemLogger = require('./src/gateway/systemLogger');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const PAYMENT_PORT = parseInt(process.env.PAYMENT_PORT || '3001', 10);
const STORE_NAME = process.env.STORE_NAME || 'YuriDev';
const APP_NAME = 'YURI PAY';
const STORE_LOGO_URL = process.env.STORE_LOGO_URL || '';
const STORE_WEBSITE_URL = process.env.STORE_WEBSITE_URL || '';
const DEFAULT_SUCCESS_THEME = process.env.DEFAULT_SUCCESS_THEME || 'anime';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin#yuripay2026';
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
        const currentStoreName = adminAuth.getStoreName();
        if (customName) {
            customName = String(customName).replace(/<[^>]*>?/gm, '').trim().substring(0, 80);
        } else {
            customName = orderId ? `Pesanan ${orderId}` : `Pembayaran ${currentStoreName}`;
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

// Login Form Submit (Rate Limited to prevent brute force & verified by adminAuth)
dashboardApp.post('/login', loginRateLimiter, (req, res) => {
    const { email, password } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    const authResult = adminAuth.verifyLogin(email, password, { ip: clientIp, userAgent });

    if (authResult.success) {
        req.session.isAdmin = true;
        req.session.adminEmail = authResult.email;
        return res.redirect('/');
    }

    res.render('login', {
        appName: APP_NAME,
        storeName: STORE_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        error: authResult.message || 'Email atau Kata Sandi admin salah! Silakan coba lagi.',
        email: email || ''
    });
});

// Logout
dashboardApp.get('/logout', (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    if (req.session && req.session.adminEmail) {
        adminAuth.recordAuditLog({
            action: 'ADMIN_LOGOUT',
            ip: clientIp,
            userAgent,
            status: 'SUCCESS',
            details: `Admin ${req.session.adminEmail} keluar sesi`
        });
    }
    if (req.session) {
        req.session.destroy(() => {
            res.redirect('/login');
        });
    } else {
        res.redirect('/login');
    }
});

// ----------------------------------------------------
// Dashboard Page SSR Renderer Helper
// ----------------------------------------------------
function renderDashboardPage(req, res, activeSection = 'overview') {
    const session = gopayClient.getSessionInfo();
    const stats = paymentStore.getStats();
    const recentPayments = paymentStore.getRecentPayments(200);
    const baseUrl = getPaymentBaseUrl(req);
    const dashboardBaseUrl = getDashboardBaseUrl(req);
    const keys = apiKeyManager.getApiKeys();
    const currentAdminEmail = adminAuth.getAdminEmail();
    const currentStoreName = adminAuth.getStoreName();

    res.render('index', {
        storeName: currentStoreName,
        appName: APP_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        storeWebsiteUrl: STORE_WEBSITE_URL,
        defaultSuccessTheme: DEFAULT_SUCCESS_THEME,
        apiKey: keys.secretKey,
        secretKey: keys.secretKey,
        publicKey: keys.publicKey,
        keysRotatedAt: keys.rotatedAt,
        adminEmail: currentAdminEmail,
        paymentPort: PAYMENT_PORT,
        dashboardPort: DASHBOARD_PORT,
        baseUrl,
        dashboardBaseUrl,
        paymentBaseUrl: baseUrl,
        sessionValid: !!session?.access_token,
        stats,
        recentPayments,
        formatRupiah,
        activeSection
    });
}

// Protected Structured Dashboard Routes
dashboardApp.get('/', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'overview'));
dashboardApp.get('/transactions', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'transactions'));
dashboardApp.get('/financial', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'financial'));
dashboardApp.get('/logs', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'logs'));
dashboardApp.get('/pos', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'pos'));
dashboardApp.get('/developer', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'developer'));
dashboardApp.get('/settings', requireAdminAuth, (req, res) => renderDashboardPage(req, res, 'security'));

// Financial Analytics API
dashboardApp.get('/api/financial/summary', requireAdminAuth, (req, res) => {
    try {
        const allPayments = paymentStore.getRecentPayments(5000);
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        let todayVolume = 0, todayCount = 0;
        let weekVolume = 0, weekCount = 0;
        let monthVolume = 0, monthCount = 0;
        let allVolume = 0, allCount = 0;
        let pendingVolume = 0, pendingCount = 0;

        // Daily chart data for last 7 days
        const dailyBuckets = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const dStr = d.toISOString().slice(0, 10);
            dailyBuckets[dStr] = {
                date: dStr,
                label: d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }),
                volume: 0,
                count: 0
            };
        }

        for (const p of allPayments) {
            const created = new Date(p.created_at || p.createdAt || 0);
            const dStr = created.toISOString().slice(0, 10);
            const amt = Number(p.total_amount || p.totalAmount || 0);
            const isPaid = (p.status || '').toUpperCase() === 'PAID';
            const isPending = (p.status || '').toUpperCase() === 'PENDING';

            if (isPaid) {
                allVolume += amt;
                allCount++;

                if (dStr === todayStr) {
                    todayVolume += amt;
                    todayCount++;
                }
                if (created >= sevenDaysAgo) {
                    weekVolume += amt;
                    weekCount++;
                }
                if (created >= thirtyDaysAgo) {
                    monthVolume += amt;
                    monthCount++;
                }
                if (dailyBuckets[dStr]) {
                    dailyBuckets[dStr].volume += amt;
                    dailyBuckets[dStr].count++;
                }
            } else if (isPending) {
                pendingVolume += amt;
                pendingCount++;
            }
        }

        const mdrRate = 0.00; // ASPI QRIS 0% Tier
        const expenses = Math.round(allVolume * mdrRate);
        const netProfit = allVolume - expenses;
        const avgTransaction = allCount > 0 ? Math.round(allVolume / allCount) : 0;

        res.json({
            success: true,
            summary: {
                todayVolume,
                todayCount,
                weekVolume,
                weekCount,
                monthVolume,
                monthCount,
                allVolume,
                allCount,
                pendingVolume,
                pendingCount,
                expenses,
                netProfit,
                avgTransaction,
                mdrRate: '0% (ASPI QRIS UMKM)',
                chartData: Object.values(dailyBuckets)
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Financial CSV Export
dashboardApp.get('/api/financial/export-csv', requireAdminAuth, (req, res) => {
    try {
        const payments = paymentStore.getRecentPayments(5000);
        systemLogger.logActivity('EXPORT_CSV', 'Admin mengekspor laporan transaksi ke CSV', { count: payments.length }, req);

        const headers = [
            'ID Transaksi',
            'Order ID',
            'TRX ID GoPay',
            'Keterangan / Pelanggan',
            'Nominal Dasar',
            'Kode Unik',
            'Total Bayar (IDR)',
            'Status',
            'Waktu Dibuat',
            'Waktu Kedaluwarsa',
            'Waktu Bayar',
            'Webhook Status'
        ];

        const escapeCsv = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        const rows = payments.map(p => [
            escapeCsv(p.id),
            escapeCsv(p.order_id || p.orderId),
            escapeCsv(p.trx_id || p.trxId || '-'),
            escapeCsv(p.custom_name || p.customName || '-'),
            p.base_amount || p.baseAmount || 0,
            p.unique_code || p.uniqueCode || 0,
            p.total_amount || p.totalAmount || 0,
            escapeCsv(p.status),
            escapeCsv(p.created_at || p.createdAt),
            escapeCsv(p.expires_at || p.expiresAt),
            escapeCsv(p.paid_at || p.paidAt || '-'),
            escapeCsv(p.webhook_sent || p.webhookSent ? 'TERKIRIM' : 'BELUM')
        ].join(','));

        const csvContent = '\uFEFF' + [headers.map(h => `"${h}"`).join(','), ...rows].join('\r\n');
        const filename = `yuripay_financial_${new Date().toISOString().slice(0, 10)}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(csvContent);
    } catch (e) {
        res.status(500).send(`Gagal mengekspor CSV: ${e.message}`);
    }
});

// Dedicated Transactions Query & Search API
dashboardApp.get('/api/transactions', requireAdminAuth, (req, res) => {
    try {
        const rawPayments = paymentStore.getRecentPayments(1000);
        let list = [...rawPayments];
        const search = String(req.query.search || '').trim().toLowerCase();
        const status = String(req.query.status || 'ALL').toUpperCase();
        const sortBy = String(req.query.sortBy || 'created_at');
        const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 15));

        // Filter by status
        if (status !== 'ALL') {
            list = list.filter(p => (p.status || '').toUpperCase() === status);
        }

        // Filter by search
        if (search) {
            list = list.filter(p => {
                const idMatch = (p.id || '').toLowerCase().includes(search);
                const orderMatch = (p.order_id || '').toLowerCase().includes(search);
                const trxMatch = (p.trx_id || '').toLowerCase().includes(search);
                const nameMatch = (p.custom_name || '').toLowerCase().includes(search);
                const amountMatch = String(p.total_amount || '').includes(search);
                return idMatch || orderMatch || trxMatch || nameMatch || amountMatch;
            });
        }

        // Sorting
        list.sort((a, b) => {
            let valA = a[sortBy];
            let valB = b[sortBy];
            if (sortBy === 'created_at' || sortBy === 'paid_at') {
                valA = new Date(valA || 0).getTime();
                valB = new Date(valB || 0).getTime();
            } else if (sortBy === 'total_amount' || sortBy === 'base_amount') {
                valA = Number(valA || 0);
                valB = Number(valB || 0);
            }
            if (sortOrder === 'asc') {
                return valA > valB ? 1 : (valA < valB ? -1 : 0);
            }
            return valA < valB ? 1 : (valA > valB ? -1 : 0);
        });

        const total = list.length;
        const totalPages = Math.ceil(total / limit) || 1;
        const startIndex = (page - 1) * limit;
        const paginated = list.slice(startIndex, startIndex + limit);

        res.json({
            success: true,
            transactions: paginated,
            total,
            page,
            limit,
            totalPages
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Single Transaction Detail (for Drawer)
dashboardApp.get('/api/transaction/:id', requireAdminAuth, (req, res) => {
    try {
        const payment = paymentStore.getPayment(req.params.id);
        if (!payment) {
            return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
        }
        const baseUrl = getPaymentBaseUrl(req);
        const publicData = paymentStore.sanitizePublic(payment, baseUrl);
        res.json({ success: true, transaction: payment, publicData });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Unified Logging System API
dashboardApp.get('/api/logs', requireAdminAuth, (req, res) => {
    try {
        const { category, severity, search, limit, offset } = req.query;
        const result = systemLogger.getLogs({
            category,
            severity,
            search,
            limit: parseInt(limit, 10) || 50,
            offset: parseInt(offset, 10) || 0
        });
        const stats = systemLogger.getLogStats();
        res.json({ success: true, ...result, stats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get Current API Keys (Admin only)
dashboardApp.get('/api/keys', requireAdminAuth, (req, res) => {
    res.json({ success: true, data: apiKeyManager.getApiKeys() });
});

// Regenerate API Keys (Admin only)
dashboardApp.post('/api/keys/regenerate', requireAdminAuth, (req, res) => {
    try {
        const newKeys = apiKeyManager.regenerateApiKeys();
        systemLogger.logActivity('REGENERATE_KEYS', 'Admin men-generate ulang Kunci API (Public Key & Secret Key)', {}, req);
        res.json({
            success: true,
            message: 'Kunci API (Public Key & Secret Key) berhasil digenerate ulang!',
            data: newKeys
        });
    } catch (e) {
        systemLogger.logError('REGENERATE_KEYS_ERROR', e.message, e, req);
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
        systemLogger.logActivity('TEST_WEBHOOK_DISPATCH', `Uji coba simulasi webhook ke ${webhook_url}`, { webhook_url, amount, order_id }, req);
        const result = await webhookEngine.sendNotification(testPayment);
        res.json({
            success: true,
            message: 'Simulasi notifikasi webhook berhasil dikirim ke server merchant',
            result
        });
    } catch (err) {
        systemLogger.logError('TEST_WEBHOOK_ERROR', err.message, err, req);
        res.status(500).json({
            success: false,
            message: `Gagal mengirim webhook: ${err.message}`
        });
    }
});

// Admin Credentials Management API (Manual Email & Password setup)
dashboardApp.post('/api/admin/change-credentials', requireAdminAuth, (req, res) => {
    const { current_password, new_email, new_password, confirm_password } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    const result = adminAuth.updateCredentials({
        currentPassword: current_password,
        newEmail: new_email,
        newPassword: new_password,
        confirmPassword: confirm_password
    }, { ip: clientIp, userAgent });

    if (result.success) {
        if (result.email) {
            req.session.adminEmail = result.email;
        }
        systemLogger.logActivity('CHANGE_CREDENTIALS', 'Admin berhasil memperbarui kredensial akun', { email: result.email }, req);
        return res.json({ success: true, message: result.message, email: result.email });
    }
    systemLogger.logAuth('CHANGE_CREDENTIALS_FAILED', result.message, 'WARNING', req);
    return res.status(400).json({ success: false, message: result.message });
});

// Admin Security Overview & Audit Logs API
dashboardApp.get('/api/admin/security-info', requireAdminAuth, (req, res) => {
    const info = adminAuth.getSecurityOverview();
    res.json({ success: true, data: info });
});

// Update Merchant Store Name
dashboardApp.post('/api/admin/store-name', requireAdminAuth, (req, res) => {
    const { store_name } = req.body;
    if (!store_name || typeof store_name !== 'string' || !store_name.trim()) {
        return res.status(400).json({ success: false, message: 'Nama toko tidak boleh kosong.' });
    }
    const updated = adminAuth.updateStoreName(store_name.trim());
    systemLogger.logActivity('UPDATE_STORE_NAME', `Nama toko diubah menjadi "${updated}"`, { store_name: updated }, req);
    res.json({ success: true, message: 'Nama toko berhasil diperbarui!', store_name: updated });
});

// Redirect customer payment routes from Dashboard Port (3000) to Customer Gateway (3001)
dashboardApp.get(['/payment/:id', '/pay/:id', '/payment/x/:id'], (req, res) => {
    const { id } = req.params;
    const targetUrl = `${getPaymentBaseUrl(req)}/payment/${id}`;
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

// Customer Checkout Page Handler (Supports UUID e.g. /payment/68fe4f26-dda7-11f1-9ba3-cee239a73494)
async function renderCustomerCheckout(req, res) {
    const { id } = req.params;
    let payment = paymentStore.getPayment(id);
    const currentStoreName = adminAuth.getStoreName() || STORE_NAME;

    if (!payment) {
        return res.status(404).render('checkout', {
            error: 'Tagihan pembayaran tidak ditemukan atau sudah dihapus.',
            storeName: currentStoreName,
            appName: APP_NAME,
            storeLogoUrl: STORE_LOGO_URL,
            payment: null,
            formatRupiah
        });
    }

    // If still PENDING, run a quick check with GoPay before rendering
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
        storeName: currentStoreName,
        appName: APP_NAME,
        storeLogoUrl: STORE_LOGO_URL,
        payment: publicPayment,
        formatRupiah
    });
}

// Enterprise customer checkout route (clean direct path, without /x/)
paymentApp.get('/payment/:id', renderCustomerCheckout);
paymentApp.get('/pay/:id', renderCustomerCheckout);

// Backward-compatible redirect for legacy /payment/x/:id
paymentApp.get('/payment/x/:id', (req, res) => {
    res.redirect(301, `/payment/${req.params.id}`);
});

// Full Transparent Invoice API
paymentApp.get('/api/invoice/:id', async (req, res) => {
    const { id } = req.params;
    const payment = paymentStore.getPayment(id);
    if (!payment) {
        return res.status(404).json({ success: false, message: 'Tagihan pembayaran tidak ditemukan' });
    }
    const baseUrl = getPaymentBaseUrl(req);
    res.json({
        success: true,
        invoice: paymentStore.sanitizePublic(payment, baseUrl)
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

// 404 Handler for Dashboard App
dashboardApp.use((req, res) => {
    if (req.accepts('html')) {
        return res.status(404).render('login', {
            appName: APP_NAME,
            storeName: STORE_NAME,
            storeLogoUrl: STORE_LOGO_URL,
            error: 'Halaman 404: Endpoint dashboard yang Anda minta tidak ditemukan.',
            email: ''
        });
    }
    res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Halaman dashboard tidak ditemukan' });
});

// 500 Error Handler for Dashboard App
dashboardApp.use((err, req, res, next) => {
    console.error('[Dashboard Error]:', err);
    systemLogger.logError('DASHBOARD_ERROR', err.message, err, req);
    if (res.headersSent) return next(err);
    if (req.accepts('html')) {
        return res.status(500).send(`
            <div style="font-family:sans-serif;padding:40px;text-align:center;background:#090d16;color:#fff;min-height:100vh;">
                <h1 style="color:#ef4444;font-size:24px;">500 Internal Server Error</h1>
                <p style="color:#94a3b8;font-size:14px;">Terjadi kesalahan internal. Kesalahan telah dicatat di log sistem.</p>
                <a href="/" style="display:inline-block;margin-top:20px;padding:10px 20px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:12px;font-weight:bold;">Kembali ke Dashboard</a>
            </div>
        `);
    }
    res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: err.message });
});

// ----------------------------------------------------
// START SERVERS ON BOTH PORTS
// ----------------------------------------------------
dashboardApp.listen(DASHBOARD_PORT, () => {
    console.log('================================================================');
    console.log(`📊 ${APP_NAME} DASHBOARD & KASIR: http://localhost:${DASHBOARD_PORT}`);
    console.log(`🔐 Admin: ${adminAuth.getAdminEmail()} (PBKDF2 Password Protected)`);
    console.log(`🏬 Merchant: ${STORE_NAME} | Keamanan Port Terisolasi`);
    console.log('================================================================');
    systemLogger.logSystem('SERVER_START', `${APP_NAME} Dashboard berjalan pada port ${DASHBOARD_PORT}`, 'SUCCESS');
});

paymentApp.listen(PAYMENT_PORT, () => {
    console.log('================================================================');
    console.log(`💳 ${APP_NAME} CUSTOMER GATEWAY: http://localhost:${PAYMENT_PORT}/payment/:uuid`);
    console.log(`🔐 Port Customer Terpisah (Bebas dari Bocoran Token/Rahasia)`);
    console.log('================================================================');
});
