#!/usr/bin/env node

/**
 * ============================================================================
 * ⚡ YuriPay - GoBiz / GoPay Official Merchant Login Assistant
 * ============================================================================
 * Tool interaktif resmi untuk mengotentikasi akun GoBiz / GoFood Merchant Anda
 * dan menghasilkan file sesi aman (.GOPAY_SESI_JANGAN_DIHAPUS.json) untuk YuriPay.
 */

const readline = require('readline');
const { requestOtp, verifyOtp, saveManualSession, getLatestAppVersion } = require('./src/gateway/gopayAuth');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// ANSI Color Helpers
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    bgBlue: '\x1b[44m',
};

async function handleOtpLogin() {
    console.log(`\n${colors.cyan}${colors.bright}--- METODE 1: LOGIN OTOMATIS VIA OTP SMS/WA ---${colors.reset}`);
    const rawPhone = await ask(`${colors.bright}>> Masukkan Nomor HP GoBiz Anda (contoh: 085119772671): ${colors.reset}`);
    if (!rawPhone || rawPhone.trim().length < 9) {
        console.log(`\n${colors.red}[✕] Error: Nomor HP tidak valid atau terlalu pendek!${colors.reset}`);
        return;
    }

    const currentVersion = await getLatestAppVersion();
    console.log(`\n${colors.dim}[*] Versi build GoBiz portal aktif: ${currentVersion}${colors.reset}`);
    console.log(`${colors.cyan}[*] Menghubungi GoBiz API untuk meminta kode OTP ke: ${rawPhone.trim()}...${colors.reset}`);
    
    const otpRes = await requestOtp(rawPhone.trim());

    if (!otpRes.success) {
        console.log(`\n${colors.red}[✕] Gagal mengirim OTP: ${otpRes.message}${colors.reset}`);
        console.log(`\n${colors.yellow}💡 Tips Troubleshooting:${colors.reset}`);
        console.log(` • Pastikan nomor HP terdaftar aktif sebagai Pemilik/Admin di GoBiz.`);
        console.log(` • Jika server GoBiz membatasi OTP, Anda bisa menggunakan Opsi [2] Input Manual Access Token.`);
        return;
    }

    console.log(`\n${colors.green}[✔] Permintaan OTP BERHASIL!${colors.reset}`);
    console.log(`${colors.dim}Kode OTP 4 digit telah dikirim ke SMS/WhatsApp nomor Anda. Berlaku selama ${otpRes.expires_in} detik.${colors.reset}\n`);

    const otpCode = await ask(`${colors.bright}>> Masukkan 4 Digit Kode OTP: ${colors.reset}`);
    if (!otpCode || otpCode.trim().length !== 4) {
        console.log(`\n${colors.red}[✕] Error: Kode OTP harus berupa 4 digit angka!${colors.reset}`);
        return;
    }

    console.log(`\n${colors.cyan}[*] Memverifikasi kode OTP ke server resmi GoBiz...${colors.reset}`);
    const verifyRes = await verifyOtp(otpCode.trim(), otpRes.otp_token, otpRes.phone, otpRes.unique_id);

    if (!verifyRes.success) {
        console.log(`\n${colors.red}[✕] Verifikasi Gagal: ${verifyRes.message}${colors.reset}`);
        console.log(`\n${colors.yellow}💡 Alternatif Cepat:${colors.reset}`);
        console.log(` Jika OTP Anda dibatasi oleh server GoBiz, Anda dapat menggunakan opsi:`);
        console.log(`   ${colors.green}[2] Masukkan Access Token / Cookie Sesi GoBiz Secara Manual${colors.reset}`);
        console.log(` (Cukup salin token dari portal https://portal.gofoodmerchant.co.id)`);
        return;
    }

    displaySuccess(verifyRes.session);
}

async function handleManualToken() {
    console.log(`\n${colors.cyan}${colors.bright}--- METODE 2: INPUT ACCESS TOKEN / COOKIE GOBIZ (BYPASS OTP) ---${colors.reset}`);
    console.log(`${colors.dim}Cara mendapatkan token dari browser:${colors.reset}`);
    console.log(` 1. Buka dan login ke: ${colors.cyan}https://portal.gofoodmerchant.co.id${colors.reset}`);
    console.log(` 2. Buka DevTools (F12) -> Tab Application (atau Storage) -> Cookies.`);
    console.log(` 3. Salin isi nilai cookie ${colors.yellow}access_token${colors.reset}.`);
    console.log(`${colors.dim}----------------------------------------------------------------------${colors.reset}\n`);

    const rawToken = await ask(`${colors.bright}>> Tempelkan (Paste) access_token atau cookie GoBiz Anda: ${colors.reset}`);
    if (!rawToken || rawToken.trim().length < 20) {
        console.log(`\n${colors.red}[✕] Error: Token tidak boleh kosong atau terlalu pendek!${colors.reset}`);
        return;
    }

    console.log(`\n${colors.cyan}[*] Menghubungi GoBiz API untuk memvalidasi token dan mengambil info outlet...${colors.reset}`);
    const res = await saveManualSession(rawToken.trim());

    if (!res.success) {
        console.log(`\n${colors.red}[✕] Gagal memvalidasi token: ${res.message}${colors.reset}`);
        return;
    }

    displaySuccess(res.session);
}

function displaySuccess(s) {
    console.log(`\n${colors.green}${colors.bright}======================================================================${colors.reset}`);
    console.log(`${colors.green}${colors.bright}   🎉 [SUCCESS] OTENTIKASI BERHASIL & SESI GOBIZ AKTIF!               ${colors.reset}`);
    console.log(`${colors.green}${colors.bright}======================================================================${colors.reset}`);
    console.log(`  Nama Outlet  : ${colors.bright}${s.outlet_name || 'Outlet Merchant'}${colors.reset}`);
    console.log(`  Merchant ID  : ${colors.cyan}${s.merchant_id || '-'}${colors.reset}`);
    console.log(`  Nomor HP     : ${s.phone_number || '-'}`);
    console.log(`  Masa Berlaku : ${s.expires_at}`);
    console.log(`\n${colors.yellow}File sesi telah disimpan ke:${colors.reset}`);
    console.log(`  📂 ${colors.green}.GOPAY_SESI_JANGAN_DIHAPUS.json${colors.reset}`);
    console.log(`\n${colors.cyan}Sekarang Anda dapat menjalankan server YuriPay:${colors.reset}`);
    console.log(`  ${colors.bright}npm start${colors.reset}\n`);
}

async function main() {
    console.clear();
    console.log(`${colors.cyan}${colors.bright}
  ██╗   ██╗██╗   ██╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗
  ╚██╗ ██╔╝██║   ██║██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝
   ╚████╔╝ ██║   ██║██████╔╝██║██████╔╝███████║ ╚████╔╝ 
    ╚██╔╝  ██║   ██║██╔══██╗██║██╔═══╝ ██╔══██║  ╚██╔╝  
     ██║   ╚██████╔╝██║  ██║██║██║     ██║  ██║   ██║   
     ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝  ╚═╝   ╚═╝   
    ${colors.reset}`);
    console.log(`${colors.bright}⚡ YURIPAY by myzert - GoBiz Official Merchant Authentication Assistant${colors.reset}`);
    console.log(`${colors.dim}----------------------------------------------------------------------${colors.reset}`);
    console.log(`${colors.yellow}Pilih Metode Login GoBiz:${colors.reset}`);
    console.log(` [1] Login Otomatis via OTP SMS/WA (Versi Portal Terbaru: ${await getLatestAppVersion()})`);
    console.log(` [2] Masukkan Access Token / Cookie Sesi GoBiz Secara Manual (Bypass OTP)`);
    console.log(`${colors.dim}----------------------------------------------------------------------${colors.reset}\n`);

    const choice = await ask(`${colors.bright}>> Pilih Opsi [1/2] (Default: 1): ${colors.reset}`);

    if (choice.trim() === '2') {
        await handleManualToken();
    } else {
        await handleOtpLogin();
    }

    rl.close();
}

main().catch(err => {
    console.error(`\n${colors.red}Fatal Error:${colors.reset}`, err.message);
    rl.close();
});
