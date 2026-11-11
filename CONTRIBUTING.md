# 🤝 Panduan Kontribusi (Contributing Guidelines)

Terima kasih atas ketertarikan Anda untuk berkontribusi pada **YuriPay**! YuriPay adalah proyek sumber terbuka (*open source*) independen yang dirancang untuk membantu para pelaku usaha dan pengembang mengelola pembayaran QRIS GoBiz secara mandiri.

Kontribusi dari komunitas sangat diapresiasi, baik berupa laporan *bug*, perbaikan kode, peningkatan dokumentasi, penambahan fitur, maupun saran arsitektur.

---

## 📜 Daftar Isi
1. [Kode Etik (Code of Conduct)](#-kode-etik-code-of-conduct)
2. [Bagaimana Cara Berkontribusi?](#-bagaimana-cara-berkontribusi)
   - [Melaporkan Bug](#1-melaporkan-bug)
   - [Mengajukan Ide atau Fitur Baru](#2-mengajukan-ide-atau-fitur-baru)
   - [Mengirimkan Pull Request (PR)](#3-mengirimkan-pull-request-pr)
3. [Setup Lingkungan Pengembangan Lokal](#-setup-lingkungan-pengembangan-lokal)
4. [Standar Penulisan Kode & Konvensi Git](#-standar-penulisan-kode--konvensi-git)
5. [Alur Pengujian & Review PR](#-alur-pengujian--review-pr)
6. [Daftar Kontributor](#-daftar-kontributor)

---

## 🕊️ Kode Etik (Code of Conduct)

Dalam berpartisipasi pada proyek ini, kami mengharapkan semua kontributor untuk:
- Bersikap ramah, sopan, dan inklusif kepada semua orang.
- Menghargai sudut pandang dan pengalaman teknis yang beragam.
- Memberikan kritik yang membangun dan menerima masukan dengan lapang dada.
- Mengutamakan keamanan data dan privasi pengguna.

---

## 💡 Bagaimana Cara Berkontribusi?

### 1. Melaporkan Bug
Jika Anda menemukan kesalahan teknis atau ketidaksesuaian perilaku sistem:
1. Periksa tab [Issues](https://github.com/myzert/YURIPAY-GOPAY/issues) untuk memastikan masalah serupa belum pernah dilaporkan atau sedang didiskusikan.
2. Jika belum ada, buat issue baru dengan menyertakan:
   - **Deskripsi Bug**: Penjelasan ringkas dan jelas tentang apa yang salah.
   - **Langkah Mereproduksi**: Urutan aksi yang memicu terjadinya bug.
   - **Perilaku yang Diharapkan vs Perilaku Aktual**.
   - **Informasi Lingkungan**: Versi Node.js (misal: v22.x), OS (Linux/Ubuntu, Docker, Termux, Windows), dan browser/klien HTTP yang digunakan.
   - **Log Error**: Salinan pesan error (pastikan telah menyensor data sensitif seperti token sesi atau nomor HP!).

> [!NOTE]
> Untuk masalah yang berkaitan dengan celah keamanan kritis, jangan buka issue publik. Ikuti prosedur pelaporan privat di [SECURITY.md](SECURITY.md).

### 2. Mengajukan Ide atau Fitur Baru
Kami terbuka untuk peningkatan fitur yang relevan dengan ekosistem gateway pembayaran mandiri:
- Buka issue bertipe *Feature Request*.
- Jelaskan *use case* (kebutuhan nyata) dan solusi yang Anda usulkan.
- Diskusikan bersama pengelola (*maintainers*) sebelum mulai menulis kode dalam jumlah besar agar desain fitur selaras dengan arsitektur YuriPay.

### 3. Mengirimkan Pull Request (PR)
1. Fork repositori ini ke akun GitHub Anda.
2. Buat branch baru dari branch `main` dengan nama yang deskriptif (lihat panduan branching di bawah).
3. Lakukan perubahan kode secara modular dan teruji.
4. Pastikan aplikasi berjalan normal tanpa error.
5. Push branch Anda dan buka **Pull Request** ke branch `main` repositori resmi.

---

## 🛠️ Setup Lingkungan Pengembangan Lokal

Pastikan Anda memiliki:
- **Node.js**: Versi 22.x LTS atau lebih baru (`node -v`)
- **NPM**: Versi 10.x atau lebih baru (`npm -v`)
- **Git** terpasang

### Langkah-langkah Setup:

1. **Clone Repositori Fork Anda:**
   ```bash
   git clone https://github.com/<username-anda>/YURIPAY-GOPAY.git
   cd YURIPAY-GOPAY
   ```

2. **Pasang Dependensi:**
   ```bash
   npm install
   ```

3. **Konfigurasi Environment:**
   ```bash
   cp .env.example .env
   ```
   Sesuaikan variabel konfigurasi lokal Anda pada `.env`.

4. **Jalankan Aplikasi Mode Development:**
   ```bash
   npm run dev
   ```
   Mode ini menggunakan fitur `--watch` bawaan Node.js yang otomatis me-reload server saat terdapat perubahan berkas.

---

## 📐 Standar Penulisan Kode & Konvensi Git

### Standar Penulisan Kode (Code Style)
- Gunakan JavaScript modern (ES6+) yang kompatibel dengan CommonJS (`require` / `module.exports`) sesuai basis kode saat ini.
- Tulis kode yang bersih, mudah dibaca, dan modular.
- Hindari hardcoding nilai kredensial atau URL; manfaatkan variabel environment (`process.env`).
- Selalu tangani *asynchronous errors* menggunakan blok `try...catch` dan pastikan respon error tidak membocorkan informasi sensitif ke klien.
- Pertahankan idempotensi pada proses mutasi dan callback webhook.

### Konvensi Nama Branch
Gunakan awalan branch yang jelas:
- `feat/nama-fitur` : Penambahan fitur baru.
- `fix/nama-bug` : Perbaikan bug.
- `docs/perubahan-dokumen` : Pembaruan dokumentasi README atau panduan.
- `refactor/nama-modul` : Restrukturisasi kode tanpa mengubah fungsionalitas.
- `chore/tugas-pemeliharaan` : Pembaruan dependensi, build tool, atau konfigurasi.

### Konvensi Pesan Commit
Disarankan mengikuti format [Conventional Commits](https://www.conventionalcommits.org/):
- `feat: tambah dukungan notifikasi telegram`
- `fix: tangani null pointer pada callback midtrans`
- `docs: perbarui panduan konfigurasi reverse proxy nginx`
- `chore: perbarui dependensi axios ke versi terbaru`

---

## 🧪 Alur Pengujian & Review PR

Sebelum mengirimkan PR, pastikan:
1. [x] Kode baru tidak merusak fungsionalitas yang sudah ada.
2. [x] File `.env` lokal atau file sesi GoBiz **TIDAK** ter-commit secara tidak sengaja (`git status`).
3. [x] Perubahan terdokumentasi jika terdapat penambahan endpoint API baru (perbarui Swagger jika relevan).
4. [x] Deskripsi PR mencantumkan ringkasan perubahan serta nomor issue terkait (contoh: `Closes #12`).

Setiap PR akan ditinjau oleh maintainer proyek. Harap perhatikan komentar ulasan dan lakukan penyesuaian jika diperlukan.

---

## 👥 Daftar Kontributor

Lihat daftar lengkap orang-orang luar biasa yang telah berkontribusi pada proyek ini di berkas [CONTRIBUTORS.md](CONTRIBUTORS.md).
