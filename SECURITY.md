# 🛡️ Kebijakan Keamanan (Security Policy)

Kami di proyek **YuriPay** menganggap keamanan sistem dan data transaksi sangat penting. Dokumen ini menjelaskan kebijakan keamanan, versi yang didukung, prosedur pelaporan kerentanan secara bertanggung jawab (*responsible disclosure*), serta panduan pengamanan implementasi mandiri (*self-hosted*).

---

## 📦 Versi yang Didukung (Supported Versions)

Pembaruan keamanan dan perbaikan celah kritis secara aktif dirilis untuk versi-versi berikut:

| Versi | Status Dukungan Keamanan | Catatan |
| :--- | :---: | :--- |
| **1.0.x** (Current / Main) | :white_check_mark: Didukung Penuh | Mendapatkan patch keamanan reguler & pembaruan dependensi |
| **< 1.0.0** | :x: Tidak Didukung | Harap segera lakukan upgrade ke versi terbaru |

---

## 🚨 Melaporkan Kerentanan (Reporting a Vulnerability)

> [!CAUTION]
> **JANGAN PERNAH** mempublikasikan informasi kerentanan keamanan, celah *exploit*, atau bukti konsep (*Proof of Concept / PoC*) ke publik melalui GitHub Issues, Pull Request publik, atau media sosial sebelum celah tersebut diperbaiki dan dirilis patch resminya.

Jika Anda menemukan atau mencurigai adanya celah keamanan pada YuriPay, harap laporkan secara privat melalui salah satu jalur berikut:

1. **Email Resmi:** Kirimkan laporan ke [zerttcihuy@gmail.com](mailto:zerttcihuy@gmail.com)
2. **Subjek Email:** `[SECURITY] YuriPay Vulnerability Report - <Ringkasan Masalah>`
3. **GitHub Security Advisory:** Jika Anda memiliki akses ke fitur pelaporan privat GitHub Security Advisories pada repositori ini, Anda juga dapat mengirimkannya melalui tab **Security** > **Advisories**.

### Informasi yang Perlu Disertakan dalam Laporan:
Agar kami dapat mereproduksi dan memvalidasi masalah dengan cepat, sertakan:
- **Deskripsi Kerentanan:** Penjelasan teknis mengenai potensi risiko atau dampak celah tersebut.
- **Komponen Terdampak:** Endpoint API, sistem autentikasi, handler webhook, database, poller mutasi, atau file sesi.
- **Langkah Reproduksi (Steps to Reproduce):** Instruksi langkah demi langkah atau skrip *Proof-of-Concept* (PoC) non-destruktif.
- **Dampak Potensial:** Analisis risiko (misal: bypass autentikasi, eksfiltrasi token sesi, *tampering* nilai transaksi, atau denial of service).
- **Usulan Perbaikan (Opsional):** Jika Anda memiliki rekomendasi kode atau konfigurasi mitigasi.

---

## ⏱️ Komitmen dan Alur Penanganan

Setelah laporan Anda diterima:

1. **Konfirmasi Awal (1–2 Hari Kerja):** Kami akan memverifikasi penerimaan laporan Anda dan melakukan peninjauan teknis awal.
2. **Investigasi & Triase:** Kami mengevaluasi tingkat keparahan celah (CVSS / Severity) dan menyiapkan perbaikan pada branch privat.
3. **Penyusunan Patch & Pengujian:** Patch diuji untuk memastikan tidak ada *breaking change* atau regresi pada transaksi pembayaran.
4. **Rilis Keamanan & Pengakuan (Credit):** Kami akan merilis versi perbaikan ke branch utama dan memberikan atribusi pengakuan (*security credit*) kepada pelapor (kecuali jika pelapor meminta untuk tetap anonim).

---

## 🔒 Praktik Terbaik Pengamanan Pengguna (Security Best Practices)

YuriPay adalah sistem *self-hosted* yang memproses transaksi keuangan riil. Pastikan Anda menerapkan langkah-langkah mitigasi berikut saat melakukan deployment:

### 1. Isolasi Port Ganda (Dual-Port Isolation)
- Port Public (default: `3000`) hanya membuka antarmuka checkout dan endpoint pembuatan invoice publik.
- Port Internal Admin (default: `3001`) berisi dashboard kontrol dan manajemen mutasi. **Wajib dibatasi** menggunakan firewall (UFW/iptables), VPN lokal, atau konfigurasi reverse proxy (Nginx/Caddy) agar tidak dapat diakses bebas dari internet publik.

### 2. Perlindungan File Rahasia & Kredensial
- Simpan file konfigurasi `.env` dan token sesi GoBiz (`.GOPAY_SESI_JANGAN_DIHAPUS.json`) dengan izin akses ketat:
  ```bash
  chmod 600 .env .GOPAY_SESI_JANGAN_DIHAPUS.json
  ```
- **Jangan pernah** menyertakan atau melakukan commit file `.env` maupun file token sesi ke dalam repositori Git publik.

### 3. Enkripsi Transport (HTTPS / TLS Wajib)
- Gunakan sertifikat SSL/TLS valid (misal: Let's Encrypt via Nginx / Cloudflare Full Strict).
- Jangan operasikan transaksi produksi melalui HTTP tanpa enkripsi untuk mencegah penyadapan data kartu / invoice / sesi (*Man-in-the-Middle*).

### 4. Validasi Tanda Tangan Webhook
- Selalu aktifkan dan validasi signature hash SHA-512 pada integrasi webhook (kompatibilitas Midtrans) untuk memastikan notifikasi pembayaran berasal dari server sah dan bukan injeksi palsu.

---

## 🏷️ Ruang Lingkup (Scope)

### Dalam Cakupan (In-Scope):
- Bypass autentikasi dan otorisasi pada endpoint YuriPay.
- Kebocoran token sesi GoBiz atau kredensial merchant melalui response API atau log.
- Manipulasi status pembayaran (*race condition*, replay attack, tampering status invoice).
- Kerentanan Injeksi SQL (*SQL Injection* pada SQLite database) dan *Command Injection*.
- Celah *Server-Side Request Forgery* (SSRF) atau *Cross-Site Scripting* (XSS) pada dashboard.

### Di Luar Cakupan (Out-of-Scope):
- Serangan Distributed Denial of Service (DDoS) berskala jaringan pada infrastruktur hosting Anda.
- Kelemahan keamanan pada aplikasi pihak ketiga (aplikasi resmi Gojek / GoBiz / Android OS).
- Rekayasa sosial (*phishing*, *social engineering*) terhadap pemilik akun merchant.
- Akses fisik tanpa izin ke server atau perangkat hosting Anda.
