# ENV PRODUKSI — FINZZ STORE (build PostgreSQL)

Project: `finzzstore` · team `xcxzoomcs-projects` · domain `https://finzzstore.nightvale.xyz`
Build: v2, 26 Oktober 2026 · Supabase Auth **sudah dihapus**, data layer = `pg` langsung.

Dokumen ini menjawab satu pertanyaan: **variabel mana yang tidak dipakai lagi dan
harus dihapus dari dashboard Vercel**, dan variabel mana yang wajib ada sebelum
deploy berikutnya.

> Status 26 Okt 2026 13:22 UTC: build PostgreSQL **sudah live** di
> `https://finzzstore.nightvale.xyz` (`database.driver: "pg"`, supplier `live`,
> `contractVerified: true`, 140 layanan nyata). Env di bawah adalah kondisi
> **aktual**, bukan rencana.

---

## 1. Sudah tidak dibutuhkan — aman dihapus

Semua ini dibaca oleh build **Supabase-era** dan **tidak dibaca sama sekali** oleh
kode sekarang (`grep` di `src/`, `server.js`, `scripts/` tidak menemukan satupun
pembacaannya):

| Variabel | Kenapa tidak dipakai lagi |
|---|---|
| `SUPABASE_URL` | Dulu endpoint PostgREST. Data layer sekarang memakai `pg` langsung ke `DATABASE_URL`. |
| `SUPABASE_ANON_KEY` | Dulu kunci signup/signin Supabase Auth. Auth sekarang milik aplikasi sendiri (Argon2id) dan **browser tidak pernah menerima kunci apa pun**. |
| `SUPABASE_SERVICE_ROLE_KEY` | Dulu untuk melewati RLS. Sekarang server memakai satu koneksi PostgreSQL dengan parameterized query; RLS tetap aktif untuk peran `anon`/`authenticated`. |
| `SUPABASE_JWT_SECRET` | Dulu untuk verifikasi JWT Supabase. Sesi sekarang berupa token acak 32 byte, di-hash di tabel `auth_tokens`, dikirim lewat cookie HttpOnly. |
| `SUPABASE_DB_URL` | Alias lama untuk `DATABASE_URL`. **Dihapus dari `src/config.js` pada putaran ini** — dulu alias ini diam-diam dipakai kalau `DATABASE_URL` kosong, dan itu menyembunyikan deployment yang salah konfigurasi. Kalau hanya `SUPABASE_DB_URL` yang diisi, produksi sekarang **menolak boot** dengan pesan jelas. |
| `DEMO_MODE`, `DEMO_SEED`, `DEMO_*_EMAIL`, `DEMO_*_PASSWORD` | Mode demo memakai database in-memory dan menolak boot kalau `NODE_ENV=production`. Tidak boleh ada di produksi. |
| `NODE_ENV` | Vercel menyuntiknya sendiri. Override manual berbahaya (kalau jadi `development`, penjagaan `https://` mati). |
| `PORT`, `HOST` | Platform yang menentukan. |
| `ALLOWED_ORIGINS` | Duplikat `APP_URL` — `config.js` selalu menambahkan `APP_URL` ke allowlist. |
| `AUTH_EXPOSE_DEV_TOKENS` | Kalau `true` di produksi, aplikasi justru menolak boot. Jangan diset. |
| `TRUST_PROXY` | Default `true`, sudah benar untuk Vercel. |
| `JOBS_ENABLED`, `UPLOAD_DIR`, `ORDER_POLLER_ENABLED`, `RECONCILIATION_ENABLED` | `server.js` mengisinya otomatis saat mendeteksi `VERCEL` (timer in-process dimatikan; kerja terjadwal lewat `/api/cron/*`). |
| `SUPPLIER_MODE` | Disimpulkan otomatis: ada `TELEKOS_API_KEY` → `live`, tidak ada → `off`. Menyetel `mock` di produksi justru membuat boot gagal. |
| `TELEKOS_BASE_URL` | Default `https://telekos.id/v1` sudah benar. |

Catatan keamanan: kalau service role key Supabase pernah tersimpan di Vercel,
**rotasi/disable key itu di dashboard Supabase** setelah dihapus dari Vercel —
menghapus env tidak membatalkan kunci yang sudah bocor.

---

## 2. Wajib ada (tanpa ini deploy gagal)

Divalidasi di `src/config.js` saat boot. Gagal cepat lebih baik daripada melayani
dengan database yang salah.

| Variabel | Bentuk | Kalau kosong/salah |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` (pakai host pooler port 6543 untuk serverless) | **boot gagal**: `DATABASE_URL is required in production` |
| `DATABASE_SSL` | **`no-verify`** · `require` · `disable` | Pooler Supabase memakai sertifikat yang tidak terverifikasi (`SELF_SIGNED_CERT_IN_CHAIN`), jadi `require` **gagal konek**. `no-verify` tetap terenkripsi, hanya tanpa verifikasi rantai. Ini kompromi sadar, bukan default yang aman. |
| `APP_ENCRYPTION_KEY` | 32 byte acak, base64 | **boot gagal** |
| `APP_URL` | `https://…` | **boot gagal** kalau bukan https |
| `CRON_SECRET` | ≥ 16 karakter acak | **boot gagal**. Dipakai cron-job.org & Vercel Cron (`Authorization: Bearer …`). |
| `TELEKOS_API_KEY` | API key TeleKos yang **valid** | supplier `off`: katalog kosong, tidak ada pembelian |
| `TELEKOS_WEBHOOK_SECRET` | secret webhook TeleKos | webhook selalu `401 INVALID_SIGNATURE` |

Rekomendasi kuat (bukan syarat boot, tapi tanpa ini fitur redup):

| Variabel | Akibat kalau kosong |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` (+ `SMTP_USER`, `SMTP_PASS`) | OTP verifikasi & reset password **tidak terkirim**. Registrasi tetap jujur melaporkan `emailSent:false` — tidak memalsukan "email terkirim". |

---

## 3. Opsional (nyalakan hanya kalau dipakai)

| Variabel | Efek |
|---|---|
| `TURNSTILE_ENABLED=true` + `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | Captcha Cloudflare di register/login/lupa-password. Fail-closed: token tidak valid = ditolak 400. Kalau `true` tanpa secret → boot gagal. |
| `GOOGLE_OAUTH_ENABLED=true` + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` | Tombol "Masuk dengan Google". Tombol disembunyikan kalau tidak lengkap. |
| `PAYMENT_PROVIDER`, `PAYMENT_MODE`, `PAYMENT_SECRET` | Top-up otomatis. Biarkan kosong/`disabled`: UI berkata "pembayaran otomatis belum aktif" dan deposit manual tetap jalan. |
| `DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT`, `DATABASE_IDLE_TIMEOUT`, `DATABASE_STATEMENT_TIMEOUT` | Tuning pool (default 10 / 10 dtk / 30 dtk / 15 dtk). |
| `LOG_LEVEL` | Default `info` di produksi. |
| `CATALOG_BOOT_DELAY_MS`, `ORDER_POLL_*`, `RECONCILE_INTERVAL_MS` | Hanya berlaku bila timer in-process dinyalakan (VPS). Di Vercel tidak dipakai. |

---

## 4. Cara mengisi

```bash
export PATH=/home/user/.local/node24/bin:$PATH
cd /home/user/prod/finzz-store

vercel link --yes --project finzzstore --scope team_BOLzu0FwElfirJfuk38cIl7S

printf '%s' "$DATABASE_URL"   | vercel env add DATABASE_URL production
printf 'require'              | vercel env add DATABASE_SSL production
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
                              | vercel env add APP_ENCRYPTION_KEY production
printf 'https://finzzstore.vercel.app' | vercel env add APP_URL production
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" \
                              | vercel env add CRON_SECRET production
printf '%s' "$TELEKOS_API_KEY"        | vercel env add TELEKOS_API_KEY production
printf '%s' "$TELEKOS_WEBHOOK_SECRET" | vercel env add TELEKOS_WEBHOOK_SECRET production
```

Lalu hapus variabel Supabase-era yang masih ada:

```bash
for v in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET SUPABASE_DB_URL; do
  vercel env rm "$v" production --yes 2>/dev/null && echo "dihapus: $v"
done
```

Cek hasilnya: `vercel env ls production` harus **hanya** berisi variabel dari
bagian 2 dan 3 di atas.

---

## 4b. Jadwal yang harus didaftarkan di cron-job.org

Vercel Hobby hanya mengizinkan **2 cron harian**, jadi jadwal menit-jam harus
dari luar. Semua request wajib menyertakan header
`Authorization: Bearer $CRON_SECRET`.

| Tugas | URL | Jadwal | Kenapa |
|---|---|---|---|
| Polling order | `POST /api/cron/poll` | tiap 1 menit | OTP & status order muncul cepat |
| Rekonsiliasi | `POST /api/cron/reconcile` | tiap 15 menit | order ambigu, refund, sinkron katalog |
| Katalog saja | `POST /api/cron/catalog` | tiap 30 menit | harga & stok tetap segar (durasi ±22 dtk) |

Kalau cron tidak jalan: landing tetap menampilkan harga terakhir yang tersimpan
(tidak pernah mengarang), tetapi stok dan OTP akan tertinggal.

## 5. Urutan deploy yang benar — SATU PERINTAH

Deploy dan migrasi tidak dipisah. `deploy.sh` menjalankan enam langkah berurutan
dan **berhenti** kalau ada yang gagal:

```bash
DATABASE_URL='postgresql://...' \
VERCEL_TOKEN=xxx \
FINZZ_CRON_SECRET=xxx \
./deploy.sh
```

| Langkah | Yang dilakukan | Gagal → |
|---|---|---|
| 1/6 preflight | membaca `vercel env ls`, memastikan 6 variabel wajib ada | berhenti (exit 2) |
| 2/6 kode sehat | `npm run check` + `npm test` | berhenti |
| 3/6 **migrasi** | `npm run db:migrate` ke `DATABASE_URL` | berhenti (exit 4 kalau URL tidak ada) |
| 4/6 **verifikasi skema** | `npm run db:verify` | berhenti (exit 5) |
| 5/6 deploy | `vercel deploy --prod` | berhenti |
| 6/6 verifikasi runtime | `verify-production.mjs` + cron katalog | berhenti (exit 6/7) |

Kenapa migrasi **sebelum** deploy: aplikasi menolak melayani kalau kolom
`password_hash`, tabel `auth_tokens`, tabel `cron_locks`, atau
`orders.pricing_snapshot` belum ada. Tanpa migrasi, kegagalannya muncul sebagai
500 di produksi — bukan di terminal Anda. Migrasi bersifat aditif dan idempoten,
jadi aman dijalankan saat versi lama masih melayani.

`DATABASE_URL` untuk migrasi sebaiknya memakai **session pooler (port 5432)**.
Port 6543 (mode transaksi) sah untuk aplikasi, tetapi DDL beruntun lebih aman di
sesi penuh.

Peringatan: `SKIP_MIGRATE=1 ./deploy.sh` ada untuk keadaan darurat saja. Ia
mengunggah kode tanpa memastikan skema — persis kesalahan yang dihindari rantai ini.

### Perintah database yang berdiri sendiri

```bash
npm run db:migrate          # terapkan yang tertunda (idempoten)
npm run db:migrate:status   # apa yang sudah/belum, tanpa menulis apa pun
npm run db:migrate:dry      # dry-run
npm run db:bootstrap        # skema dasar + migrasi (database benar-benar kosong)
npm run db:baseline         # tandai sudah diterapkan TANPA mengeksekusi
npm run db:verify           # buktikan skema cocok dengan kontrak aplikasi
```

`db:migrate` mencatat setiap file di `public.schema_migrations`, jadi menjalankan
ulang adalah no-op — bukan "jalan lagi, mudah-mudahan aman".

### Verifikasi manual setelah deploy

4. Verifikasi, jangan percaya "build sukses":
   - `GET /api/health` → `database.driver` **harus** `pg`, `supplier.mode` **live**,
     `supplier.lastError` **null**.
   - `POST /api/cron/catalog` dengan `Bearer $CRON_SECRET` → `status: "ok"`.
   - `GET /api/public/catalog` → jumlah layanan > 0 (angka nyata dari TeleKos).
   - Buka `/` (landing) → tabel harga terisi, badge sumber data bukan "mock".
   - Buka `/status` → semua baris hijau **hanya** kalau datanya benar.
