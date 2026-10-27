# LAPORAN AKHIR — FINZZ STORE

Tanggal: **26 Oktober 2026**
Basis kode: `/home/user/prod/finzz-store` (paket `finzz-store-FINAL-2026-10-26.zip`
sebelumnya, dilanjutkan — bukan ditulis ulang dari nol).
Node target: **24.x** · runtime: **`node:http` native** · ESM murni.

Laporan ini memisahkan tiga status supaya tidak ada klaim berlebih:

- **[SELESAI + TERUJI]** — diimplementasikan dan dibuktikan dengan tes otomatis atau
  eksekusi nyata terhadap PostgreSQL.
- **[SELESAI — BUTUH KREDENSIAL ANDA]** — kodenya ada dan teruji secara lokal,
  tetapi hanya bisa benar-benar berjalan setelah Anda mengisi env tertentu
  (SMTP, DATABASE_URL produksi, API key TeleKos).
- **[BELUM]** — belum dikerjakan, dengan alasan yang jelas.

---

## 1. Audit awal: apa yang sebenarnya ada di repo

Audit dilakukan sebelum mengubah apa pun. Temuan utama:

| Temuan | Dampak |
|---|---|
| 10 pemanggilan `supabase.auth.*` di `src/auth.js`, `src/auth-dev.js`, `src/database.js` | Auth bergantung penuh pada Supabase; tidak bisa jalan tanpa kunci Supabase |
| `connector` PostgREST (`supabase-js`) sebagai satu-satunya jalur database | Tidak ada koneksi PostgreSQL langsung; RLS bergantung pada JWT Supabase |
| Tidak ada penyimpanan password sendiri | Tidak ada Argon2id, tidak ada OTP, tidak ada reset token milik sendiri |
| `src/database-pg.js` belum ada | Ditambahkan pada putaran ini + diverifikasi terhadap PostgreSQL 17 |
| `rpc_sync_services` membuang `markup_bps` | Harga katalog bisa berbeda dari harga checkout (bug uang) |
| `services.markup_bps` selalu 1500 (nilai default kolom) | Markup per-layanan yang diatur admin tidak pernah dipakai saat quote live |
| `rpc_consume_email_token` mencari token hanya dengan `sha256(kode)` | Kode 6 digit tidak terikat akun → risiko sesi untuk akun lain |
| `attempts` hanya naik saat token **cocok** | Batas percobaan tidak pernah tercapai (brute force tidak terbatas di lapisan DB) |
| Cron endpoint hanya `GET`, membaca `process.env` langsung, tanpa lock | Dua invokasi bisa menjalankan job yang sama bersamaan |
| `pg` berada di `devDependencies` | `npm ci --omit=dev` (default Vercel) → aplikasi crash saat start |
| Halaman privasi & reset-password masih menyebut Supabase Auth | Klaim tidak benar setelah migrasi |

Semua temuan di atas diperbaiki pada putaran ini dan dikunci dengan tes.

---

## 2. Database: PostgreSQL langsung **[SELESAI + TERUJI]**

- Driver baru `src/database-pg.js`: pool `pg`, query berparameter, TLS
  (`DATABASE_SSL=require` memverifikasi sertifikat), timeout koneksi/idle/statement.
- `DATABASE_URL` sekarang **satu-satunya gerbang**: bila kosong di produksi,
  proses menolak start (`ConfigError`), tidak lagi diam-diam turun ke mode demo.
- `src/database-memory.js` dipertahankan sebagai driver demo lokal dan memakai
  kontrak yang sama (import test, `call`, `query`), sehingga tes API berjalan
  tanpa PostgreSQL.
- **Bukti runtime:** aplikasi dijalankan dengan `DATABASE_URL` ke PostgreSQL 17
  lokal; `GET /api/health` melaporkan `driver: pg`; register/login/order/cron
  berjalan; baris benar-benar tersimpan (`profiles`, `wallets`, `sessions`,
  `orders`, `cron_locks`).

Verifikasi file saat ini (`npm test` → 94/94, `npm run test:sql` → 43/43).

---

## 3. Supabase Auth dihapus total **[SELESAI + TERUJI]**

- `grep -rn "supabase.auth" src/ tests/` → **0 hasil**.
- `@supabase/supabase-js` dihapus dari dependency (`npm run check` mencetak daftar
  dependency: `argon2, nodemailer, pg`).
- `src/auth.js`, `src/auth-dev.js`, `src/database.js` dipindahkan ke
  `docs/removed/*.js.txt` (arsip, tidak ikut build) dengan penjelasan di
  `docs/removed/README.md`.
- Fitur yang dijaga tetap identik dari sisi pengguna: register, login,
  verifikasi email, lupa password, reset password, logout, logout-all, ganti
  password, refresh sesi, CSRF.

---

## 4. Auth kustom: Argon2id + OTP email + reset token **[SELESAI + TERUJI]**

Implementasi ada di `src/auth-local.js`, `src/auth/security.js`,
`src/auth/mailer.js`, dan `database/migrations/002_custom_auth.sql` (+004).

**Password**
- Argon2id, parameter m=19456 KiB, t=2, p=1 (rekomendasi OWASP).
- Dibuktikan di PostgreSQL nyata: `password_hash like '$argon2id$%'` → `true`,
  panjang hash 97; `select count(*) ... where password_hash not like '$argon2id$%'` → **0**.

**Kode verifikasi email (6 digit)**
- Dihasilkan `crypto.randomInt`, disimpan **sebagai hash**, TTL 600 detik
  (`AUTH_OTP_TTL_SECONDS`), sekali pakai, ada batas percobaan
  (`AUTH_TOKEN_MAX_ATTEMPTS`, default 5).
- **Diikat ke akun**: hash = `sha256("<user-id>:<kode>")`. Kode milik A tidak bisa
  dipakai untuk B, meski angkanya kebetulan sama.
- Percobaan salah **dihitung** dan kode dibakar setelah batas tercapai.

**Reset password**
- Token 32 byte acak (`randomToken(32)`), berlaku **tepat 10 menit**
  (`AUTH_RESET_TTL_SECONDS=600`), sekali pakai.
- Konsumsi token, penggantian hash password, dan pencabutan **semua sesi**
  terjadi dalam satu transaksi (`rpc_complete_password_reset`).
- `GET /api/auth/reset-password/validate?token=` memberi tahu
  `EXPIRED`/`USED`/`INVALID`/`MISSING` tanpa menghabiskan token.
- Link dibangun dari `APP_URL` tepercaya, bukan dari header `Host`.

**Email**
- Nodemailer dengan `SMTP_*`; bila SMTP belum diisi, API menjawab jujur
  `emailSent:false` dan UI memberi tahu bahwa email belum terkirim.
- `Referrer-Policy: no-referrer` dipasang **khusus** pada `/reset-password` dan
  `/verify-email` (halaman lain tetap `strict-origin-when-cross-origin`) agar
  token tidak bocor lewat header Referer — ada tesnya.

**Uji terkait (semua lulus)**
- kode hanya mengesahkan akunnya sendiri; percobaan silang → `INVALID_TOKEN`
  dan tidak ada sesi;
- 6 percobaan salah → kode terbakar, verifikasi gagal;
- kode benar → sesi dibuat, kode tidak bisa dipakai ulang;
- reset: sekali pakai, sesi lama langsung mati, password baru berfungsi;
- token kedaluwarsa ditolak (`TOKEN_EXPIRED`);
- `auth_tokens` tidak bisa dibaca `anon`/`authenticated` (privilege dicek di SQL).

---

## 5. Sesi, CSRF, dan proteksi akun **[SELESAI + TERUJI]**

- Cookie sesi `HttpOnly`, `Secure` (produksi), `SameSite=Lax`; **token mentah
  tidak disimpan** — database hanya menyimpan `sha256(token)`.
- Rotasi sesi saat login, idle/absolute expiry (`SESSION_TTL_SECONDS`), logout
  satu perangkat dan logout-semua.
- CSRF: header `x-csrf-token` wajib untuk request yang mengubah state; token
  diputar pada refresh.
- Lock akun sementara setelah `AUTH_MAX_FAILED_LOGINS` (default 5) gagal, selama
  `AUTH_LOCK_SECONDS` (default 900) — dibuktikan di SQL
  (`rpc_note_login` → `failed_login_count=3`, `locked_until` terisi).
- Login salah dan email tidak terdaftar memberi jawaban **identik**
  (`401 INVALID_CREDENTIALS`), tidak membocorkan keberadaan akun.
- Rate limit per IP dan per akun pada register/login/lupa password/verifikasi.

---

## 6. Wallet ganda: supplier vs pelanggan **[SELESAI + TERUJI]**

- Wallet pelanggan (`wallets` + `wallet_transactions`) **hanya** bertambah dari:
  deposit yang disetujui admin, penyesuaian admin beralasan (tercatat di audit
  log), atau refund order.
- Saldo supplier (TeleKos) **tidak pernah** masuk ke wallet pelanggan; ia dibaca
  terpisah lewat `GET /api/admin/supplier` dan hanya untuk diagnosa.
- Penyesuaian saldo admin **wajib** `reason` dan `reference` UUID (idempoten;
  referensi yang sama tidak menambah saldo dua kali).
- Batas order aktif per pengguna dan penolakan saldo kurang terjadi **sebelum**
  panggilan supplier (tidak ada pembelian yang menggantung).

---

## 7. Top-up: adapter gateway pembayaran **[SELESAI — BUTUH KREDENSIAL ANDA]**

- Adapter ada dan **sengaja non-aktif** sampai ada kontrak provider yang
  disetujui. Tanpa `PAYMENT_PROVIDER`, UI menampilkan "pembayaran otomatis belum
  aktif" dan deposit manual (bukti transfer + persetujuan admin) tetap berjalan.
- Persetujuan deposit mengkredit **tepat sekali**: deposit `approved` tidak bisa
  di-approve ulang, dan penolakan wajib alasan.
- Verifikasi signature callback **belum** diuji terhadap provider nyata karena
  tidak ada kredensial; strukturnya disiapkan di adapter.
- **Yang saya butuhkan dari Anda:** nama provider, dokumentasi signature, dan
  kredensial sandbox. Tanpa itu saya tidak akan mengarang endpoint.

---

## 8. TeleKos: katalog, pembelian, webhook **[SELESAI + TERUJI (mock) — BUTUH API KEY ANDA]**

**Katalog**
- `GET /servers → /apps → /countries → /prices`, harga termurah lebih dulu,
  offer kedaluwarsa ditandai `OFFER_EXPIRED` untuk refetch.
- Sinkronisasi menulis `supplier_price`, `markup_bps` yang **benar-benar
  dipakai**, dan `price` final dalam satu RPC (`rpc_sync_services`).
- Bukti runtime: 193 layanan tersinkron dari supplier mock dalam 27 ms.

**Pembelian**
- Header `Idempotency-Key` diisi UUID order (panjang 36, di dalam batas 8–128),
  dan **tidak pernah diganti** selama hasil masih ambigu.
- `OFFER_EXPIRED` / `INVALID_OFFER` / `OUT_OF_STOCK` diperlakukan **definitif**
  (supplier menyatakan tidak ada order): uang dikembalikan tepat sekali dan
  respons membawa `notice.refetchOffer=true` agar UI mengambil penawaran baru.
- Hasil ambigu (timeout/5xx/`MAINTENANCE`) **tidak** di-refund dan **tidak**
  membuat key baru: order tetap `pending`, `providerPending: true`, lalu
  direkonsiliasi. Ini dikunci oleh tes "supplier timeout neither refunds nor
  duplicates the purchase".
- Refund hanya dari status supplier terverifikasi (webhook bersignature valid
  atau polling sukses), tidak pernah dari timer lokal.

**Webhook `POST /api/webhooks/telekos`**
- HMAC-SHA256 `t=…,v1=…` dihitung atas `timestamp.raw_body` (body mentah, tidak
  di-parse ulang), `timingSafeEqual`, toleransi 300 detik.
- Dedupe per `X-Telekos-Delivery` di `supplier_webhook_events`; duplikat
  dijawab `{received:true, duplicate:true}`.
- OTP hanya terlihat oleh pemilik order (tes: user lain → 404 dan tidak ada kode
  yang bocor di respons).

**Yang belum bisa dibuktikan:** panggilan ke `https://telekos.id/v1` sungguhan.
Probe terakhir ke `/balance`, `/servers`, `/apps`, `/orders` semuanya menjawab
`401 INVALID_API_KEY` — artinya `TELEKOS_API_KEY` di Vercel tidak valid/kedaluwarsa.
Perbaiki kuncinya dan integrasi langsung aktif tanpa perubahan kode.

---

## 9. Markup engine **[SELESAI + TERUJI]**

Satu tempat yang menentukan harga pelanggan: `resolvePrice()` di `src/money.js`.

```
harga_pelanggan = harga_supplier
                + markup (persen + nominal tetap)
                + pajak
   → margin minimum dipaksa
   → pembulatan (none/nearest/up/down, kelipatan N)
```

- **Prioritas persen:** override layanan → override kategori → default kebijakan.
- **Uang selalu integer rupiah**; tidak ada `float` untuk nominal.
- Invarian `total = supplier + markup + pajak` dijaga di aplikasi **dan** di
  constraint database (`orders_price_math`).
- **Audit trail:** setiap order menyimpan `pricing_snapshot` (jsonb) berisi
  `markupBps`, `rule`, `adjustments`, `taxLabel`, `quotedAt`, `offerKey`.
  Kolom uang yang sudah ada tetap menjadi snapshot nominal.
- Admin punya **simulator** `POST /api/admin/pricing/preview` yang menghitung
  harga dengan kebijakan yang sedang diisi **sebelum** disimpan (read-only).
- Perubahan kebijakan tercatat di `admin_audit_logs` (`settings.update` dengan
  before/after).

**Bukti end-to-end (PostgreSQL nyata, kebijakan 20% + Rp750 + margin min Rp3.000
+ pembulatan ke atas 500 + override kategori `tg`=30%):**
- 193 layanan disinkronkan ulang;
- 50 layanan termurah dihitung ulang dengan engine secara independen →
  **semua cocok** dengan harga yang tersimpan;
- harga katalog **4500** = harga checkout **4500**;
- snapshot order: `rule=service bps=3000 adj=fixed:750|min_margin:3000|rounding:up:500`;
- invarian total → `ok`.

Bug yang ditemukan dan diperbaiki di sepanjang jalur ini:
1. quote live memakai markup default dan **mengabaikan** `services.markup_bps`;
2. `rpc_sync_services` tidak menyimpan `markup_bps` → katalog dan checkout bisa
   berbeda;
3. `pg` mengirim array JS sebagai *array literal* Postgres, bukan JSON, sehingga
   `rpc_sync_services` menolak payload (INVALID_INPUT) — kini semua nilai
   terstruktur di-`JSON.stringify` sebelum di-bind.

---

## 10. Cron: endpoint + lock PostgreSQL **[SELESAI + TERUJI]**

- `POST /api/cron/poll`, `/api/cron/reconcile`, `/api/cron/catalog`
  (`GET` juga diterima untuk kompatibilitas Vercel Cron).
- Autentikasi `Authorization: Bearer $CRON_SECRET`, perbandingan constant-time;
  prefix secret pun ditolak (ada tesnya). Produksi menolak boot bila
  `CRON_SECRET` kosong atau < 16 karakter.
- **Lock di PostgreSQL** (`public.cron_locks`, migrasi 003) dengan TTL:
  - dua invokasi bersamaan → yang kedua menjawab `{skipped:"locked"}` (HTTP 200,
    bukan error, supaya penjadwal tidak retry berlebihan);
  - lock kedaluwarsa sendiri bila proses mati di tengah jalan;
  - `run_count`, `last_run_at`, `last_status`, `last_result` tersimpan dan
    tampil di `GET /api/admin/dashboard` (`cron`).
- Jadwal yang disarankan untuk cron-job.org ada di `ENV-PRODUKSI.md` §4–5
  (poll 1 menit, reconcile 5 menit, catalog 30 menit).
- Catatan: Vercel Hobby membatasi 2 cron job harian, karena itu penjadwalan per
  menit memakai cron-job.org.

Bukti tes: tanpa secret → 401; secret salah → 401; dengan secret → `ran:true`;
saat lock dipegang pihak lain → `skipped:"locked"`; setelah dilepas → jalan lagi;
`run_count` bertambah di DB.

---

## 11. Frontend & panel admin **[SELESAI + TERUJI sebagian]**

- **Tanpa framework, tanpa file `.html` fisik, tanpa bundler.** Shell HTML
  dirender server (`src/render.js`), halaman adalah modul ESM
  (`public/js/pages/*.js`) — `npm run check` memverifikasi "no physical .html
  files" dan "source tree is pure ESM".
- **17 modul halaman** (15 rute terdaftar): landing, login, register,
  verify-email, forgot-password, reset-password, dashboard, services, orders,
  wallet, profile, admin, **status**, terms, privacy, not-found, forbidden.
- **Turnstile**: widget hanya dimount bila server melaporkan aktif + site key
  tersedia; token dikirim sebagai `turnstile_token` dan diverifikasi server-side
  **fail-closed** (tes: tanpa token → 400).
- Halaman auth diperbarui ke kontrak baru: verifikasi memakai **email + 6 digit
  kode**; reset memakai `?token=` dan memvalidasi tautan sebelum form tampil.
  Klaim "Supabase" di halaman privasi dan reset-password dihapus.
- **Panel admin** (tab): ringkasan (termasuk status cron), deposit, order
  (monitor + detail + aksi), pengguna, layanan (edit harga/markup per layanan),
  audit log, pengaturan (profil toko, **markup & harga lengkap dengan
  simulator**, deposit, operasional, supplier, status payment).
- Ikon memakai set SVG internal (`src/icons.js`, `public/js/icons.js`), bukan
  emoji.

- **Halaman `/status`** (publik, tanpa login) menampilkan data nyata dari
  `GET /api/health`: status + latensi database, driver yang dipakai, mode
  supplier (mock dilabeli **mock**, bukan "live"), status verifikasi kontrak,
  status webhook, status payment, versi, lingkungan, dan penghitung job. Bila
  `/api/health` gagal, halaman menyatakan bahwa status tidak dapat diperiksa —
  tidak pernah menampilkan lencana hijau tanpa data. Ada tes UI-nya, termasuk
  larangan menampilkan klaim "real-time".

---

## 12. Keamanan, konfigurasi, dan status akhir

**Keamanan**
- Tidak ada secret di frontend: `npm run check` memindai aset publik
  ("public assets contain no server secrets").
- Log disaring (`redact`/`scrubSecrets`) sehingga URL Supabase, token, dan
  password tidak pernah tertulis di log.
- `npm audit` → **0 vulnerabilities**.
- RLS tetap aktif; migrasi tidak menonaktifkan RLS dan tidak menghapus data.
- Produksi menolak boot pada konfigurasi berbahaya: `DEMO_MODE=true`,
  `AUTH_EXPOSE_DEV_TOKENS=true`, `AUTH_REQUIRE_EMAIL_VERIFICATION=false`,
  `SUPPLIER_MODE=mock`, `CRON_SECRET` kosong/pendek, `DATABASE_URL` kosong.

**Gerbang mutu (dijalankan ulang setelah semua perubahan)**

| Perintah | Hasil |
|---|---|
| `npm run check` | ✔ 78/78 file JS parse, tanpa `.html` fisik, ESM murni |
| `npm test` | **94/94 lulus** |

### Kenapa landing bisa kosong padahal semua hijau

Di Vercel timer in-process dimatikan (`JOBS_ENABLED=false`), jadi katalog **hanya**
tersinkron lewat `POST /api/cron/catalog`. Tanpa jadwal itu, landing menampilkan
"Data katalog belum tersedia" selamanya — itu perilaku benar (tidak mengarang
harga), tapi artinya cron katalog adalah syarat operasional, bukan pelengkap.
Urutan yang benar setelah deploy: jalankan `POST /api/cron/catalog` sekali,
pastikan `GET /api/public/catalog` berisi layanan, baru daftarkan jadwalnya di
cron-job.org.

### Perubahan pada putaran terakhir

- `SUPABASE_DB_URL` (alias lama `DATABASE_URL`) **dihapus dari `config.js`**.
  Sebelumnya alias ini menjadi fallback diam-diam: deployment yang salah isi
  tetap "hidup" lewat jalur yang tidak didokumentasikan. Sekarang hanya
  `DATABASE_URL`; kalau tidak ada, produksi menolak boot. Ada tesnya.
- `GET /api/public/catalog` kini melaporkan `available: true` **hanya** kalau
  katalog benar-benar berisi baris. Sebelumnya supplier yang terkonfigurasi tapi
  menolak API key tetap dilaporkan "tersedia" dengan 0 layanan.
- `ENV-VERCEL.md` diganti `ENV-PRODUKSI.md`: daftar tegas variabel yang **sudah
  tidak dipakai** (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_DB_URL`, `DEMO_*`,
  `NODE_ENV`, `PORT`, `HOST`, `ALLOWED_ORIGINS`, `AUTH_EXPOSE_DEV_TOKENS`,
  `TRUST_PROXY`, `JOBS_ENABLED`, `UPLOAD_DIR`, `SUPPLIER_MODE`,
  `TELEKOS_BASE_URL`), daftar wajib, opsional, dan urutan deploy yang benar.
- Log boot tidak lagi berbunyi "running without Supabase" (warisan era Supabase,
  menyesatkan). Sekarang: `in-memory database active (local demo only). Set
  DATABASE_URL to use PostgreSQL.`
- `scripts/verify-production.mjs` disesuaikan: dulu skrip ini justru
  **mewajibkan** `contractVerified:false` (kondisi era sebelum integrasi). Setelah
  ada API key yang valid, syarat itu akan selalu gagal. Sekarang yang diperiksa:
  supplier `mode=live`, `mock=false`, `contractVerified=true`, katalog `source`
  bukan `mock`, dan `available` konsisten dengan jumlah baris. Dijalankan ke demo
  mock lokal: 15/19 lulus dengan 4 kegagalan yang memang benar (itu bukan
  produksi).
- Halaman `/status` kini juga menampilkan **kartu katalog**: jumlah layanan siap
  jual, negara, aplikasi, dan waktu sinkron terakhir — semuanya dari
  `GET /api/public/summary` (dihitung database). Kalau katalog kosong, barisnya
  menyebutkan bahwa landing belum bisa menampilkan harga dan cron
  `POST /api/cron/catalog` perlu dijalankan. Tanpa ini, orang bisa melihat semua
  hijau di `/status` padahal landing kosong.
- `deploy.sh` ditulis ulang: pre-flight membaca `vercel env ls production`,
  menolak deploy kalau `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `APP_URL`,
  `CRON_SECRET`, `TELEKOS_API_KEY`, `TELEKOS_WEBHOOK_SECRET` belum ada,
  memperingatkan `SMTP_*` yang kosong, menandai variabel Supabase-era yang masih
  tertinggal, baru setelah itu deploy + verifikasi runtime. Token tidak valid
  gagal dengan exit code jelas (diuji).
- Rate limiter terdistribusi: `expectsDistributed` masih membandingkan
  `db.kind === 'supabase'`, padahal driver sekarang `pg` — akibatnya limiter
  bersama (tabel `rate_limits`) **tidak pernah** dianggap tersedia di PostgreSQL.
  Diperbaiki dan tes regresinya disesuaikan.


| `npm run test:sql` | **43/43 lulus** (PostgreSQL 17) |
| `npm audit` | 0 kerentanan |
| Simulasi `npm ci --omit=dev` | `pg` dan `argon2` terpasang dan berfungsi |

**Migrasi SQL (untuk Anda jalankan)**

Satu file, idempoten, divalidasi pada database kosong dan dijalankan dua kali
tanpa error:

```
database/BOOTSTRAP_SUPABASE.sql                  ← skema dasar (sekali)
database/MIGRATIONS_APPLY_IN_SQL_EDITOR.sql      ← 002 + 003 + 004 + 005 (boleh diulang)
```

Diagnostik di akhir file harus mencetak: `password_hash: t`, `auth_tokens: t`,
`anon bisa baca auth_tokens: f`, `cron_locks: 3`, `pricing_snapshot: t`,
`rpc_consume_email_token argumen: 3`.

**Status deploy — penting**

Koreksi terhadap catatan sebelumnya: domain `finzzstore.vercel.app` memang 404,
tetapi project-nya **hidup di domain lain**. Hasil pemeriksaan 26 Okt 2026
13:03 UTC:

```
GET https://finzzstore.nightvale.xyz/api/health  → 200
  database.driver : "supabase"      ← build LAMA, bukan build PostgreSQL ini
  supplier.mode   : "live"  contractVerified: false
GET /api/public/catalog → services: 0, available: true   ← bug yang sudah diperbaiki di build baru
```

Jadi yang berjalan sekarang adalah **build era Supabase**. Build v2 di paket ini
belum pernah ter-deploy, dan tidak bisa ter-deploy sampai `DATABASE_URL` diisi:
tanpa variabel itu proses menolak boot (`DATABASE_URL is required in production`).

Deploy belum bisa saya jalankan karena tidak ada kredensial Vercel yang valid:
token yang pernah Anda tempel di chat sudah diminta dicabut, dan saya tidak akan
memakai token yang sudah bocor. Langkah yang perlu Anda lakukan:

1. Buat token baru di Vercel → Account Settings → Tokens (scope: project
   `finzzstore`, team `team_BOLzu0FwElfirJfuk38cIl7S`).
2. Set env produksi di project: `DATABASE_URL`, `DATABASE_SSL=require`,
   `APP_ENCRYPTION_KEY`, `APP_URL`, `SMTP_HOST/SMTP_PORT/SMTP_FROM`
   (+ `SMTP_USER`/`SMTP_PASS`), `TELEKOS_API_KEY` (yang valid),
   `TELEKOS_WEBHOOK_SECRET`, `CRON_SECRET`.
3. Kirim token itu, dan deploy dijalankan (`vercel deploy --prod`).

Perhatian: build v2 **menolak start** tanpa `DATABASE_URL` dan `CRON_SECRET`.
Itu disengaja — lebih baik gagal saat deploy daripada melayani dengan database
yang salah. Jadi env harus diisi **sebelum** deploy, bukan sesudah.

**Yang masih menghalangi aplikasi "hidup penuh" di produksi**

1. `DATABASE_URL` produksi (Supabase → Connection string → URI, port pooler 6543).
2. Kredensial SMTP (host, port, user, pass, from) — tanpa ini verifikasi email
   tidak terkirim, dan API akan mengatakannya terus terang.
3. `TELEKOS_API_KEY` yang valid — kunci saat ini dijawab `401 INVALID_API_KEY`
   oleh TeleKos.
4. Menjalankan dua file SQL di atas di Supabase SQL Editor.
5. Token Vercel baru (token lama diminta dicabut).

**Yang belum dikerjakan (jujur)**

- Verifikasi signature callback payment gateway terhadap provider nyata
  (menunggu kredensial & dokumentasi provider).
- Google OAuth: konfigurasi dan pengecekan tersedia (`oauth.available`),
  alur callback lengkap belum saya aktifkan karena `GOOGLE_CLIENT_ID` tidak ada;
  tombolnya otomatis tersembunyi saat belum dikonfigurasi.
- Bukti panggilan TeleKos sungguhan (butuh API key valid).

---

## 13. DEPLOY PRODUKSI — 26 Okt 2026 (bukti runtime)

Bagian ini ditulis **setelah** deploy, bukan sebelum. Semua angka di bawah
diambil dari server yang sedang melayani, bukan dari build lokal.

### 13.1 Yang benar-benar terjadi

| Langkah | Hasil |
|---|---|
| Database Supabase diperiksa | Ternyata **belum dimigrasi**: tidak ada `app` schema, `password_hash`, `auth_tokens`, `cron_locks`, `pricing_snapshot`. Semua tabel bisnis 0 baris. |
| Backup diambil | `supabase-backup-sebelum-migrasi-20261026-1310.sql` (skema + data, 96K) + dump skema terpisah |
| `BOOTSTRAP_SUPABASE.sql` dijalankan | sukses tanpa error, 15 tabel + RLS + 28 RPC |
| `MIGRATIONS_APPLY_IN_SQL_EDITOR.sql` (002–005) | sukses; diagnostik: `password_hash t`, `auth_tokens t`, `anon baca auth_tokens f`, `cron_locks 3`, `pricing_snapshot t`, `argumen OTP 3` |
| Env Vercel | `DATABASE_URL`, `DATABASE_SSL=no-verify`, `TELEKOS_API_KEY`, `TELEKOS_WEBHOOK_SECRET`, `CRON_SECRET` diset; `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` **dihapus** |
| Deploy | `vercel deploy --prod` → `https://finzzstore.nightvale.xyz` |

### 13.2 Bukti hidup (26 Okt 2026 13:22 UTC)

```
GET /api/health
  ok: true        environment: "production"      version: "2.0.0"
  database: { driver: "pg", ok: true, latencyMs: 179 }
  supplier: { mode: "live", mock: false, contractVerified: true,
              verifiedEndpoints: ["servers","apps","countries","prices"],
              webhookConfigured: true, lastError: null }
  rateLimiter: { mode: "distributed", distributed: true, verifiedAt: "..." }
  payment: { enabled: false, mode: "disabled" }

GET /api/public/summary → activeServices: 140, countries: 73, apps: 14
GET /api/public/catalog → 140 layanan, source: "supplier", available: true
  contoh: Discord Ukraine Rp230 · Discord Brazil Rp230 · Google Chat Italy Rp4.715
POST /api/cron/catalog (Bearer CRON_SECRET) → status "success", upserted 140,
  durasi 22,3 dtk
POST /api/webhooks/telekos tanpa signature → 401 INVALID_SIGNATURE
POST /api/auth/login (password salah) → 401 INVALID_CREDENTIALS
```

`scripts/verify-production.mjs` terhadap domain produksi: **20/20 lulus**
(termasuk "katalog bukan data mock", "available konsisten dengan isi katalog",
"tidak ada secret di respons publik").

### 13.3 Bug yang hanya muncul setelah data asli masuk

Tiga cacat ini **tidak mungkin** ditemukan dengan data mock, dan semuanya
diperbaiki pada putaran ini:

1. **Semua layanan menumpuk di satu grup aplikasi.** `db.services.listPublic()`
   tidak mengambil kolom `provider_app_id`, sehingga setiap layanan tiba di
   browser dengan `appId: null`. Di landing, 140 layanan dari 14 aplikasi tampil
   sebagai **satu** grup. Diperbaiki + tes regresi (termasuk memastikan
   `supplier_price` tetap tidak pernah keluar ke publik).
2. **Sinkronisasi katalog 74 detik** karena 240 panggilan HTTP berurutan,
   sedangkan fungsi Vercel dibunuh pada batas waktu. Sekarang memakai
   konkurensi terbatas (6) + anggaran waktu 45 detik yang berhenti sendiri dan
   **tidak menulis payload separuh** (kalau ditulis, `rpc_sync_services` akan
   menonaktifkan baris yang belum terambil). Hasil: 19,7 dtk lokal, 22,3 dtk di
   Vercel. `maxDuration` dinaikkan 30 → 60.
3. **`contractVerified` di-hardcode `false`.** Dulu itu jujur karena belum ada
   kredensial. Sekarang justru menyesatkan: 140 harga nyata sudah tersinkron
   tapi UI bilang "belum terverifikasi". Diganti dengan bukti per-endpoint
   (`servers`, `apps`, `countries`, `prices`) — mock tetap tidak bisa
   terverifikasi, dan key yang belum pernah menjawab juga tidak.

### 13.4 Satu hal yang bertentangan dengan asumsi keamanan default

`DATABASE_SSL=require` (verifikasi TLS penuh) **gagal** ke pooler Supabase:
`SELF_SIGNED_CERT_IN_CHAIN`. Supabase memakai sertifikat yang tidak bisa
diverifikasi rantainya di pooler. Pilihannya: mematikan verifikasi
(`no-verify`, koneksi tetap terenkripsi) atau memakai koneksi langsung
(`db.<ref>.supabase.co`) yang hanya IPv6 dan tidak bisa dijangkau dari Vercel.
Keputusan: **`no-verify`** dengan catatan eksplisit di `ENV-PRODUKSI.md`.
Ini kompromi yang harus Anda ketahui, bukan sesuatu yang disembunyikan.

### 13.5 Belum selesai (dan tidak bisa saya selesaikan sendiri)

| Hal | Kenapa |
|---|---|
| **Registrasi & reset password belum bisa dipakai pengguna nyata** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` belum ada. Tanpa itu OTP tidak terkirim; aplikasi jujur melaporkan `emailSent:false`. Verifikasi email wajib di produksi, jadi pengguna tidak bisa menyelesaikan pendaftaran. |
| **Belum ada akun admin** | `profiles` 0 baris. Akun admin lahir dari pendaftaran + verifikasi email, yang terblokir SMTP. Saya **tidak** membuat akun manual — itu workaround yang Anda larang. |
| **Jadwal cron-job.org belum didaftarkan** | Vercel Hobby hanya boleh 2 cron harian; jadwal menit-jam harus dari luar. Perlu `CRON_SECRET` yang baru (lihat pesan). |
| **Cek visual di browser** | Sandbox tidak punya browser. Yang terbukti: HTML 200, bundel JS tersaji, semua endpoint data benar, dan tes UI (linkedom) lulus. Tangkapan layar harus Anda lakukan. |
| **Top-up otomatis** | `PAYMENT_*` sengaja nonaktif; deposit manual tetap jalan. |

---

## 14. Migrasi menjadi bagian dari deploy (26 Okt 2026)

### 14.1 Masalahnya

Sebelumnya deploy hanya mengunggah kode. Migrasi dijalankan manual lewat SQL
Editor. Itu bekerja sampai ada satu deploy yang lupa dimigrasi — dan karena
aplikasi menolak melayani tanpa `password_hash`, `auth_tokens`, `cron_locks`,
dan `orders.pricing_snapshot`, kegagalannya muncul sebagai **500 di produksi**,
bukan sebagai error di terminal.

### 14.2 Sekarang: satu perintah, enam langkah, berhenti di kegagalan pertama

```bash
DATABASE_URL='postgresql://…' VERCEL_TOKEN=xxx FINZZ_CRON_SECRET=xxx ./deploy.sh
```

| # | Langkah | Gagal |
|---|---|---|
| 1 | preflight env Vercel (6 variabel wajib) | exit 2 |
| 2 | `npm run check` + `npm test` | berhenti |
| 3 | **`npm run db:migrate`** | exit 4 bila `DATABASE_URL` tidak ada |
| 4 | **`npm run db:verify`** (skema vs kontrak aplikasi) | exit 5 |
| 5 | `vercel deploy --prod` | berhenti |
| 6 | verifikasi runtime + cron katalog sebagai bukti supplier | exit 6/7 |

Bukti eksekusi (26 Okt 2026 13:32 UTC):

```
3/6 — migrasi database
Semua 6 migrasi sudah diterapkan. Tidak ada yang perlu dijalankan.
4/6 — verifikasi skema database
✔ database matches the application contract
6/6 — verifikasi runtime
→ POST /api/cron/catalog → HTTP 200, upserted 140
✔ kontrak supplier terbukti di proses ini — endpoint: servers, apps, countries, prices
21/21 pemeriksaan lulus
```

### 14.3 `db:migrate` bukan sekadar `psql -f`

- **Ada ledger.** Setiap file dicatat di `public.schema_migrations`; jalan ulang = no-op.
- **Mendeteksi database kosong.** Kalau skema dasar belum ada, ia berhenti dan
  menyuruh `db:bootstrap` — bukan meledak dengan `schema "auth" does not exist`.
- **Membawa shim lokal.** `database/LOCAL_SHIM.sql` membuat role
  `anon/authenticated/service_role`, schema `auth`, `auth.uid()`, dan
  `auth.users` supaya bootstrap bisa diuji di PostgreSQL biasa. Diuji pada
  database kosong: shim → bootstrap → 001–006, semuanya OK dalam satu perintah.
- **Menghormati `DATABASE_SSL`** sama seperti aplikasi (`require` / `no-verify` /
  `disable`), jadi pooler Supabase yang sertifikatnya self-signed tetap bisa.
- **Satu transaksi per migrasi.** Satu gagal, sisanya tidak setengah jalan.

### 14.4 Celah keamanan yang ditemukan langkah 4/6

`db:verify` pada database produksi melaporkan:

```
✖ RPCs executable by untrusted roles:
  rpc_admin_adjust_balance, rpc_set_user_role, rpc_approve_deposit,
  rpc_refund_order, rpc_create_order, rpc_cron_claim, … (24 fungsi)
```

Di project Supabase, fungsi baru di schema `public` mewarisi `EXECUTE` untuk
peran Supabase lewat *default privileges*. `revoke` per-fungsi di `functions.sql`
tidak menutup fungsi yang ditambahkan kemudian (`rpc_cron_*`, `rpc_sync_services`,
`rpc_flag_orphan_pending_orders`, `rpc_record_webhook_event`) — jadi celahnya
tumbuh diam-diam setiap kali ada RPC baru. Kunci `anon` Supabase bersifat publik,
jadi ini bukan teori.

Migrasi **006_rpc_grant_lockdown.sql** menutupnya dengan membaca `pg_proc`
(bukan daftar nama yang ditulis tangan), sehingga RPC baru di masa depan otomatis
ikut terkunci. Satu pengecualian disengaja: `rpc_public_summary` (hanya agregat
katalog untuk landing page). Setelah 006: `✔ database matches the application contract`.

### 14.5 Gate runtime yang saya perbaiki karena terlalu ketat

`verify-production.mjs` mewajibkan `contractVerified === true`. Padahal status itu
**per-proses**: deployment yang baru hidup belum pernah memanggil TeleKos, jadi
release yang sehat pun akan selalu gagal di gate ini. Sekarang yang wajib:
`mode=live`, `mock=false`, `lastError=null`. `contractVerified` dilaporkan
terpisah, dan `deploy.sh` membuktikannya dengan benar-benar memanggil
`POST /api/cron/catalog` lebih dulu bila `FINZZ_CRON_SECRET` diberikan.

---

## 15. Prompt fitur terpadu — hasil nyata (26 Okt 2026)

Prompt ini meminta belasan fitur. Saya kerjakan **tiga blok yang paling
menentukan** sampai benar-benar jalan dan teruji, bukan menyebar tipis ke
semuanya. Sisanya dilaporkan apa adanya di §15.6.

### 15.1 Verifikasi email tanpa input ulang **[SELESAI + TERUJI]**

| Sebelum | Sesudah |
|---|---|
| `/register` → `/verify-email?email=…` → halaman meminta email **dan** kode | `/register` → `/verify-email` → dashboard. Halaman hanya meminta 6 digit |
| Email di URL = "bukti" kepemilikan dari browser | Bukti = cookie `fz_verify` HttpOnly; email di layar berasal dari database |

Cara kerjanya:

1. Registrasi berhasil → server membuat token **32 byte acak**, menyimpan
   **hanya SHA-256**-nya di `public.email_verification_contexts` (migrasi 007).
2. Token mentah dikirim ke browser sebagai cookie `fz_verify`
   (`HttpOnly; Secure; SameSite=Lax; Max-Age=1800`). Halaman tidak bisa
   membacanya, dan tidak ada OTP/token di URL atau `localStorage`.
3. OTP 6 digit dibuat `node:crypto`, disimpan sebagai
   `sha256("<user-id>:<kode>")` — terikat akun, jadi kode tidak bisa dipakai
   untuk akun lain.
4. Halaman memanggil `GET /api/auth/verification-context` → menerima
   `emailMasked` (`p***@finzz.test`), `expiresAt`, `resendAt`, dan status
   pengiriman email yang sebenarnya.
5. Verifikasi: `POST /api/auth/verify-email { code }` — **tanpa email**.
6. Sukses → sesi dibuat, konteks ditandai `consumed_at`, cookie dibersihkan.

Pencegahan pengiriman berulang (ini inti permintaan §1.2):

```sql
rpc_claim_verify_resend()   -- satu UPDATE bersyarat, cooldown 60 dtk, maks 5/jam
```

Pemeriksaan dan penaikan penghitung terjadi dalam **satu** pernyataan dengan
`SELECT … FOR UPDATE`, jadi dua tab atau dua instance serverless tidak bisa
sama-sama lolos. Diverifikasi:

```
resend#1  : ok
resend#2  : COOLDOWN, tunggu 60 detik
```

Login akun belum terverifikasi: **tidak** memberi sesi (403
`EMAIL_NOT_VERIFIED`), tetapi menyiapkan konteks baru + cookie, sehingga UI bisa
menawarkan "Lanjutkan verifikasi" tanpa mengetik apa pun.

Bukti runtime di PostgreSQL produksi:

```
register   : 201 | masked: e***@finzz.test | sent: false
context    : 200 | present: true
resend     : 429 RESEND_COOLDOWN 60
verify(kode saja): 200 | verified: true | session: 200
replay     : 400 INVALID_TOKEN
```

### 15.2 Landing marquee logo **[SELESAI + TERUJI]**

- Dua baris bergerak berlawanan arah, dibangun **dari katalog aktual** — bukan
  daftar tetap. Tanpa data, marquee tidak muncul (bukan menampilkan logo palsu).
- Aset **SVG lokal** di `public/assets/brands/` (Simple Icons, CC0; merek
  dagang tetap milik pemiliknya). Sumber, lisensi, panduan merek resmi, dan
  aturan sanitasi didokumentasikan di `public/assets/brands/LICENSE.md`.
- Sanitasi: hanya `<path>` yang disimpan, `fill="currentColor"`,
  `viewBox` tetap, tanpa `<script>`/`on*=`/URL luar. Ada tes yang memeriksa
  setiap berkas.
- Microsoft **tidak** punya aset (ditarik dari Simple Icons atas permintaan
  pemilik merek) → ini contoh jalur *fallback* wordmark yang berfungsi.
- `prefers-reduced-motion: reduce` → animasi dimatikan total, baris jadi bisa
  digeser manual. Tinggi baris tetap (56px) + `overflow: hidden` → nol layout
  shift. `aria-hidden` pada strip; nama layanan tetap terbaca pembaca layar di
  bagian katalog.

### 15.3 Katalog publik **[SELESAI + TERUJI]**

`/services` sekarang **200 untuk pengunjung tanpa akun** (sebelumnya 302 ke
login). Pengunjung bisa membandingkan harga; tombol berubah menjadi "Masuk untuk
membeli" dan membawa tujuan kembali (`/login?next=/services?service=…`).

Yang tetap dijaga server, bukan UI: `POST /api/orders` tanpa sesi → **401**.
Diuji di `tests/api.test.js`.

### 15.4 Celah keamanan yang berulang (dan cara menutupnya permanen)

Menjalankan migrasi 007 memunculkan 5 RPC baru yang **langsung bisa dipanggil
`anon`** — celah yang sama seperti yang ditutup migrasi 006. Penyebabnya:
Supabase memberi EXECUTE otomatis ke peran Supabase untuk **setiap** fungsi
baru di schema `public`.

Pelajarannya: penguncian tidak boleh berupa migrasi sekali jalan. Sekarang
`database/GRANT_SWEEP.sql` dijalankan **otomatis setiap kali** `npm run
db:migrate` selesai, sehingga RPC baru dari migrasi mana pun ikut terkunci.
Dibuktikan: `db:verify` kembali `✔ database matches the application contract`.

### 15.5 Repositori Git untuk GitHub **[SIAP — BUTUH TOKEN]**

`git init` + satu commit bersih (134 berkas), `.gitignore` menahan
`node_modules`/`.env*`/`.vercel`/`storage`/`logs`. Dua workflow disiapkan:

- `ci.yml` — check + test + **PostgreSQL 17 service container** + `test:sql`
- `deploy.yml` — migrasi → verifikasi skema → deploy Vercel → verifikasi runtime

**Belum terkirim ke GitHub**: konektor GitHub tidak tersedia di percakapan ini
dan tidak ada token di environment. Instruksi lengkap ada di `GITHUB.md`.
Kode yang sama **sudah live** di `https://finzzstore.nightvale.xyz`
(deploy Vercel, 20/20 pemeriksaan runtime lulus).

### 15.6 BELUM dikerjakan — dan alasannya

| Fitur | Status | Alasan spesifik |
|---|---|---|
| 1.3 Google OAuth | **BELUM** | `GOOGLE_*` belum ada di Vercel. Tanpa client ID/secret saya tidak bisa menguji callback; menulis kode OIDC yang tidak pernah dijalankan berarti klaim tanpa bukti. |
| 7. Pengumuman per layanan | **BELUM** | Butuh tabel + admin UI + tampilan katalog. Belum ada satu baris pun. |
| 10. Ledger/riwayat/audit terpisah | **SEBAGIAN** | Ledger wallet (`wallet_transactions`) dan audit admin sudah ada dan atomik. Yang belum: halaman riwayat transaksi terpisah dan ekspor. |
| 11. Tiket support | **BELUM** | Butuh 3 tabel, API pelanggan + admin, upload lampiran, dan UI. Ini blok terbesar yang tersisa. |
| 12. Pusat notifikasi | **BELUM** | Butuh tabel + emitter per kejadian + UI. |
| 13A. Halaman status insiden | **SEBAGIAN** | `/status` sudah ada (database, supplier, katalog, cron). Riwayat insiden belum. |
| 13B. Pusat bantuan/FAQ | **SEBAGIAN** | FAQ ada di landing. Halaman `/bantuan` khusus belum. |
| 13D. Kupon & referral | **BELUM** | Sengaja ditunda: menyentuh jalur uang dan butuh desain aturan + audit. |
| 13F. PWA | **BELUM** | Service worker yang salah bisa meng-cache halaman wallet/OTP — risiko lebih besar daripada manfaatnya sekarang. |
| 4. Pemilihan server per layanan | **SEBAGIAN** | Katalog sudah menyimpan `provider_server` dan harga per server, tetapi belum ada pemilih server eksplisit di UI. |
| 3. Filter/pagination katalog | **SEBAGIAN** | Halaman memuat katalog dan mencari per aplikasi; filter negara/rentang harga/pagination belum. |

### 15.7 Tes

| Gerbang | Hasil |
|---|---|
| `npm run check` | ✔ lulus |
| `npm test` | **94/94** (sebelumnya 88) |
| `npm run test:sql` | **43/43** (PostgreSQL 17) |
| `npm audit` | 0 kerentanan |
| `verify-production.mjs` (produksi) | **20/20** |

Tes baru: konteks verifikasi (cookie HttpOnly, email tersamarkan, kode tanpa
email, anti-replay), cooldown kirim ulang, konteks dari login belum terverifikasi,
katalog publik tanpa akun, pemetaan merek + sanitasi setiap SVG.

### 15.8 Satu bug yang ditemukan oleh tes sendiri

Halaman verifikasi baru memakai `setInterval` untuk countdown. `tests/ui.test.js`
**menggantung 596 detik** karena timer itu menahan event loop. Bukan masalah
tes — masalah memori dan baterai di browser nyata. Diperbaiki: timer berhenti
sendiri saat cooldown habis, dan halaman mengembalikan `cleanup` yang dipanggil
router saat unmount.


---

## 16. Ronde N — filter katalog + kotak notifikasi (26 Okt 2026)

Dua blok dikerjakan dan dibuktikan dengan tes. Satu blok **belum** naik ke
produksi karena kredensial deploy tidak ada di lingkungan ini — lihat §16.5.

### 16.1 Filter, urutan, dan pemuatan bertahap di `/services` **[SELESAI + TERUJI]**

Baris filter baru di atas katalog:

| Kontrol | Isi |
|---|---|
| Cari | aplikasi, negara, nama layanan, kode panggil |
| Negara | semua negara yang benar-benar ada di katalog |
| Harga maksimum | semua / <Rp5.000 / <Rp10.000 / <Rp25.000 / <Rp50.000 |
| Urutkan | termurah (default), termahal, nama A–Z, stok terbanyak |
| Hanya yang ada stok | aktif secara default |

Keputusan desain yang perlu dicatat: **sumber data berubah saat filter dipakai.**
Tanpa filter, halaman menampilkan `catalog.apps[].countries` milik tab aplikasi
yang sedang aktif — persis yang dijanjikan tab itu. Begitu ada filter, sumbernya
menjadi array datar `catalog.services`, sehingga batas harga atau pencarian bisa
melewati batas aplikasi. Tanpa itu, mencari "Telegram" saat tab WhatsApp aktif
akan diam-diam berbohong.

Pemuatan bertahap 24 kartu per halaman ("Muat N lagi"), header menyebut
`Menampilkan X dari Y · diurutkan …`, dan timestamp sinkronisasi katalog tetap
terlihat. Empty state punya tombol reset.

**Bug nyata yang ditangkap tes baru:** jalur tanpa-filter melewati pemeriksaan
stok, sehingga negara dengan stok 0 tetap muncul sebagai kartu dengan tombol
beli yang berfungsi. Sekarang `availableOnly` berlaku di kedua jalur, dan bila
semua negara sebuah aplikasi habis, yang muncul adalah pesan "Stok sedang
kosong" dengan tombol untuk menampilkan daftar tanpa membeli — bukan daftar
kosong tanpa penjelasan.

### 16.2 Kotak notifikasi **[SELESAI + TERUJI]**

Migrasi `008_notifications.sql` menambah `public.notifications` **dan trigger**
pada `public.orders` / `public.deposits`. Notifikasi tidak ditulis oleh kode
aplikasi, melainkan oleh database pada saat baris sumbernya benar-benar berubah:

| Peristiwa sumber | Notifikasi |
|---|---|
| order dibuat | `order.created` |
| status → waiting / received / completed / cancelled / expired / failed / needs_review | `order.waiting` … `order.needs_review` (severity berbeda) |
| `refunded_at` terisi | `wallet.refund` |
| deposit → approved / rejected | `deposit.approved` / `deposit.rejected` (alasan admin ikut) |

Konsekuensinya yang penting: job poller, webhook supplier, aksi admin, dan RPC
order memakai jalur yang sama. Tidak ada endpoint yang bisa "mengirim
notifikasi" palsu, dan `UPDATE` yang tidak mengubah status tidak menghasilkan
baris apa pun (dibuktikan di tes).

API (semua `requireUser`, tidak pernah menerima `user_id` dari body):

- `GET /api/notifications?page=&per_page=&unread=1` → daftar + `unreadCount`
- `POST /api/notifications/read {ids:[…]}` → id milik orang lain mengubah 0 baris
- `POST /api/notifications/read-all`

UI: lonceng di header dengan badge **hanya** saat ada yang belum dibaca, item
"Notifikasi" di sidebar dan menu akun, halaman `/notifications` dengan filter
belum-dibaca, tandai-satu, tandai-semua, dan pemuatan bertahap. Tidak ada timer
polling: satu permintaan per navigasi.

Satu celah yang tertangkap tes sendiri: `POST /api/notifications/read` dengan
`ids` bertipe salah (mis. string) dulu dianggap "tandai semua". Sekarang tipe
yang salah = 400, bukan aksi massal yang tidak diminta.

### 16.3 Bukti

| Gerbang | Hasil |
|---|---|
| `npm run check` | ✔ lulus |
| `npm test` | **98/98** (sebelumnya 95) |
| `npm run test:sql` | **44/44** (PostgreSQL 17, termasuk 1 tes trigger baru) |
| `npm audit` | 0 kerentanan |
| Migrasi 008 di lokal | ✔ diterapkan + `GRANT_SWEEP` bersih |
| Smoke runtime HTTP | ✔ login → order → `inbox count 2 (order.waiting, order.created), unread 2` → `read-all updated 2, unread 0`; `/notifications` 200; anon 401; inbox pengguna lain 0 |

Tes baru:

1. **SQL** — order baru = 1 baris `order.created`; attach supplier = +1
   `order.waiting`; pembatalan supplier = +`wallet.refund`; `UPDATE` tanpa
   perubahan status = 0 baris; `anon` tidak bisa SELECT maupun INSERT; deposit
   ditolak membawa alasan admin.
2. **API** — inbox baru kosong; order nyata mengisi inbox; pengguna lain tidak
   melihat dan tidak bisa menandai baris orang lain (IDOR); tandai-baca
   idempoten; `ids` salah tipe = 400; tanpa sesi = 401; deposit disetujui dan
   refund masing-masing punya baris; email tidak pernah ikut di payload.
3. **UI** — halaman merender baris nyata dari fixture, badge "1 belum dibaca",
   kelas `notif--unread`, tombol "Tandai semua" benar-benar memanggil API dan
   menurunkan badge store ke 0.
4. **UI (katalog)** — filter bar lengkap, pencarian lintas aplikasi, empty state,
   dan negara stok-0 tidak pernah muncul sebagai baris yang bisa dibeli.

### 16.4 Yang BELUM dikerjakan di ronde ini

| Fitur | Status | Alasan |
|---|---|---|
| 11. Tiket support | **BELUM** | Blok terbesar yang tersisa: tabel + API pelanggan/admin + catatan internal + lampiran + UI. |
| 13. `/bantuan` + riwayat insiden | **BELUM** | `/status` sudah jujur soal kondisi sekarang; riwayat insiden butuh tabel dan hanya boleh diisi peristiwa nyata. |
| 13D. Kupon & referral | **BELUM (sengaja)** | Menyentuh jalur uang; butuh desain aturan + audit sebelum satu baris kode. |
| 13F. PWA | **BELUM** | Service worker yang salah bisa menyajikan halaman OTP/wallet dari cache. |
| 1.3 Google OAuth | **BELUM** | `GOOGLE_*` belum ada; kode OIDC tanpa callback yang bisa diuji = klaim tanpa bukti. |
| 7. Pengumuman per layanan | **BELUM** | Belum ada tabel/UI. |
| 10. Halaman riwayat transaksi terpisah | **SEBAGIAN** | Ledger & audit sudah ada dan atomik; halaman khusus + ekspor belum. |
| 4. Pemilih server | **SEBAGIAN** | `provider_server` tersimpan, pemilih eksplisit di UI belum. |
| `supplier.app_allowlist` | **BELUM** | Aplikasi generik (`2dehands`, `2ГИС`, `360Kredi`) masih bocor ke toko. |

### 16.5 Deploy ronde ini **[SELESAI — TERVERIFIKASI DI PRODUKSI]**

Deploy dilakukan setelah semua gerbang lokal lulus. Tiga temuan nyata dari
proses ini, semuanya diperbaiki dan dibuktikan:

1. **Migrasi 008 diterapkan ke Supabase** (pooler port 5432):
   `→ 008_notifications.sql … OK`, lalu `GRANT_SWEEP.sql … OK` dan
   `db:verify` → `✔ database matches the application contract`.
2. **Deploy pertama gagal di runtime, bukan di build.** Semua endpoint
   menjawab 500 dengan `{"code":"DB_AUTH_FAILED","message":"Koneksi data tidak
   terautentikasi."}`. Penyebabnya bukan kode baru: **`DATABASE_URL` di
   environment Vercel sudah kedaluwarsa** (password lama). Diuji dengan
   connection string yang benar dari mesin lokal → semua 200, jadi yang salah
   adalah env produksi, bukan aplikasi. `DATABASE_URL` produksi diganti
   (`vercel env rm` + `vercel env add`) lalu deploy ulang.
3. **Deploy ulang lulus 20/20 pemeriksaan runtime**, bukan sekadar "build
   sukses".

Bukti produksi (26 Okt 2026, setelah deploy):

| Pemeriksaan | Hasil |
|---|---|
| `scripts/verify-production.mjs` | **20/20 lulus** |
| `GET /api/health` | 200 · `driver:"pg"` · `supplier.mode:"live"` · `mock:false` |
| `GET /services` | 200, `services.js` 23.476 byte memuat `filter-bar` (3×) dan placeholder pencarian |
| `GET /notifications` tanpa sesi | **302** ke login (halaman privat, benar) |
| `GET /api/notifications` tanpa sesi | **401** `UNAUTHORIZED` |
| Aset klien baru | `/js/pages/notifications.js` 200 (8.718 byte), `layout.js` memuat `notif-bell` |
| Trigger di database produksi | `trg_notifications_on_order` (orders), `trg_notifications_on_deposit` (deposits) |
| Hak akses tabel | `service_role` select = true · `anon`/`authenticated` = **false** |
| Uji bakar trigger di produksi | dalam satu transaksi: order dibuat → `order.created`; nomor terbit → `order.waiting`; **rollback** → 0 baris tersisa, 0 profil uji tersisa |

Uji bakar itu sengaja memakai transaksi yang di-*rollback*: trigger benar-benar
berjalan di database produksi, tetapi tidak meninggalkan akun, order, atau
notifikasi palsu di data pelanggan.

**Catatan keamanan:** connection string dan token Vercel yang dikirim lewat
percakapan sebaiknya dirotasi setelah pekerjaan selesai (Supabase → Database →
Reset password; Vercel → Account Settings → Tokens → Revoke). Setelah rotasi,
perbarui `DATABASE_URL` di Vercel dengan `vercel env rm/add` — persis langkah
yang memperbaiki deploy hari ini.

### 16.6 Sisa pekerjaan (belum, dan tidak diklaim selesai)

| Fitur | Status | Catatan |
|---|---|---|
| 11. Tiket support | BELUM | Blok berikutnya. |
| 13. `/bantuan` + riwayat insiden | BELUM | — |
| 7. Pengumuman per layanan | BELUM | — |
| 10. Halaman riwayat transaksi | SEBAGIAN | Ledger & audit sudah ada. |
| 4. Pemilih server | SEBAGIAN | Data tersimpan, UI belum. |
| `supplier.app_allowlist` | BELUM | Aplikasi generik masih muncul di toko. |
| 13D. Kupon & referral | BELUM (sengaja) | Jalur uang, butuh desain aturan. |
| 13F. PWA | BELUM (sengaja) | Risiko cache halaman OTP. |
| 1.3 Google OAuth | BELUM | Butuh `GOOGLE_CLIENT_ID`/`SECRET`. |
