# LAPORAN PERBAIKAN — FINZZ STORE
**Tanggal:** 26 Oktober 2026 · **Paket asal:** `finzz-store-v2-vercel.zip` (Google Drive → folder "Website")
**Produksi:** https://finzzstore.vercel.app · **Deploy terakhir:** `dpl` 09:20 UTC (Vercel CLI 65)

---

## 1. Ringkasan

| # | Masalah dari log Vercel | Kode | Runtime produksi |
|---|---|---|---|
| A | `/api/public/catalog` 500, `RPC rpc_public_summary gagal` | ✅ diperbaiki | ✅ tidak 500 lagi (503 jujur / 200) |
| B | `rate limiter storage unavailable` | ✅ diperbaiki | ✅ mode now reported honestly |
| C | `email rate limit exceeded` → 500 `DB_ERROR` | ✅ diperbaiki | ⏳ belum diuji ke project nyata |
| D | TeleKos | ✅ diaudit | ❌ **belum terverifikasi** |
| E | Akar masalah sebenarnya | ✅ **ditemukan** | ⏳ menunggu 1 langkah SQL |

### Akar masalah yang sebenarnya (baru terbukti setelah deploy)

Log runtime dari deployment baru menampilkan penyebab yang selama ini tersembunyi:

```
pgCode PGRST205  Could not find the table 'public.services' in the schema cache
pgCode PGRST205  Could not find the table 'public.app_settings' in the schema cache
pgCode PGRST202  rpc_public_summary tidak ditemukan
```

**Skema database belum pernah diterapkan ke project Supabase `ztzruujzcornaipczzjz`.**
Bukan bug aplikasi, bukan RLS, bukan grant — tabelnya memang tidak ada. Itulah sebabnya
katalog, config, dan ringkasan semuanya gagal, sementara `ping` database tetap sehat
(health check hanya menguji koneksi, bukan isi skema).

Kode lama menyembunyikan fakta ini: semua kegagalan PostgREST dipetakan ke `DB_ERROR` 500
generik. Kode baru mencatat `pgCode`, `pgMessage`, dan nama tabel/RPC — persis inilah yang
membuat penyebabnya ketahuan dalam satu kali baca log.

---

## 2. Yang sudah dikerjakan

### 2.1 Kode (17 file diubah, 7 ditambah)

| File | Perubahan |
|---|---|
| `src/errors.js` | `DbError` + `DB_FAILURE_MAP` (PGRST202/42883 → 503 `DB_FUNCTION_MISSING`, PGRST205/42P01/42703 → `DB_SCHEMA_MISMATCH`, 42501 → `DB_PERMISSION_DENIED`, dll.) + `scrubSecrets()` |
| `src/logging.js` | whitelist field diagnostik (`pgCode`, `pgMessage`, `pgHint`, `rpc`, `table`) — tidak membocorkan rahasia |
| `src/database.js` | `authError()` pada 7 panggilan auth; konteks `{rpc, table}` di setiap query/RPC |
| `src/auth.js` | rate limit provider → **429 `EMAIL_RATE_LIMITED`** + `retryAfter`; email invalid 422; signup disabled 403; email exists 409; error tak dikenal → **503 `REGISTRATION_FAILED`** (bukan 500) |
| `src/security.js` | rate limiter ditulis ulang: terdistribusi, **fail-closed** untuk endpoint sensitif, degrade untuk publik, status berbasis bukti (`memory/unverified/degraded/distributed`) |
| `src/settings.js` | `getPublicWithStatus()` — default tidak pernah disajikan sebagai kebijakan asli |
| `src/routes/public-routes.js` | katalog: fallback ringkasan (`summarySource`), 503 `CATALOG_UNAVAILABLE` hanya bila data benar-benar tak terbaca; `/api/public/summary` tidak pernah 500; `/api/public/config` → `settingsAvailable`; `/api/health` → `contractVerified`, `rateLimiter` |
| `src/routes/helpers.js` + `auth/order/wallet/admin-routes.js` | `enforceLimit(..., {critical:true})` pada 14 titik sensitif |
| `src/orders.js` | `statusFreshness` (verified/stale + `lastSyncedAt`) — tidak ada klaim "real-time" |
| `src/supplier.js`, `src/supplier-mock.js` | `contractVerified:false`, `verifiedNote`, `webhookConfigured` |
| `package.json`, `vercel.json`, `.gitignore`, `package-lock.json` | `engines` Node 24, skrip `db:doctor`/`db:migrate`, cron harian (batas paket Hobby), `.gitignore` yang hilang di ZIP asli |

**Ditambahkan:** `database/migrations/001_fix_public_rpc_and_rate_limit.sql`,
`database/APPLY_IN_SUPABASE_SQL_EDITOR.sql`, **`database/BOOTSTRAP_SUPABASE.sql`**,
`scripts/db-doctor.mjs`, `scripts/run-migration.mjs`, `scripts/verify-production.mjs`,
`tests/resilience.test.js`, `deploy.sh`.

Tidak ada data dihapus, RLS tidak dimatikan, verifikasi email tidak dinonaktifkan,
tidak ada akun dibuat manual.

### 2.2 Pengujian

| Pemeriksaan | Hasil |
|---|---|
| `npm run check` (74 file JS, murni ESM, tanpa .html fisik, tanpa secret di `public/`) | ✔ lulus |
| `npm test` | **61/61 lulus** |
| `npm run test:sql` (PostgreSQL 17 nyata) | **35/35 lulus** |
| `npm audit --audit-level=high` | 0 kerentanan |
| Bootstrap pada **database kosong**, dijalankan **2×** | 15 tabel, 23 RPC, 0 error, idempoten |
| Ekstrak ZIP bersih → `npm ci` → boot | health 200, catalog 200, summary 200 |

### 2.3 Deploy

```
Deployment  https://finzzstore-qs2su873s-xcxzoomcs-projects.vercel.app
Alias       https://finzzstore.vercel.app   ✓ READY
```

---

## 3. Hasil verifikasi runtime produksi (dari luar)

**Sebelum deploy — 6/11 lulus**
```
GET /api/public/summary  → 500  DB_ERROR "RPC rpc_public_summary gagal"
GET /api/public/catalog  → 500  DB_ERROR "Terjadi kesalahan pada database."
```

**Sesudah deploy — 14/14 lulus**
```
✔ /api/health            200   database supabase ok (233 ms)
✔ supplier contractVerified = false        (TeleKos tidak diklaim aktif)
✔ rate limiter           unverified        (belum ada bukti, bukan klaim "distributed")
✔ /api/public/config     200   settingsAvailable=false
✔ /api/public/summary    200   available=false · activeServices=null · reason=SUMMARY_UNAVAILABLE
✔ /api/public/catalog    503   CATALOG_UNAVAILABLE (kode yang bisa ditindaklanjuti, bukan 500)
✔ GET /                  200
✔ tidak ada secret di respons publik
✔ tidak ada klaim "real-time"
```

Artinya: **aplikasi tidak lagi 500**, dan tidak mengarang angka saat data tidak ada.
Tetapi data aslinya **belum bisa tampil** sampai skema database diterapkan.

---

## 4. Satu langkah yang tersisa (butuh akses database)

Jalankan **`database/BOOTSTRAP_SUPABASE.sql`** (2.568 baris, sudah diuji idempoten di database kosong):

> Supabase Dashboard → **SQL Editor** → New query → tempel seluruh isi file → **Run**

Isinya berurutan: `schema.sql` (15 tabel) → `policies.sql` (RLS + grant) →
`functions.sql` (23 RPC) → `migrations/001` (rpc publik + rate limiter), lalu blok
**"HASIL PEMERIKSAAN"** yang mencetak:

```
TABEL: lengkap (15 tabel di schema public)
app_settings: 7 baris
rpc_public_summary ada: t
anon boleh hit rate limit: f (harus false)
anon boleh panggil summary: t (harus true)
services aktif: 0 baris
```

Setelah itu **jalankan sinkronisasi katalog** supaya `services` terisi
(`/api/cron/reconcile` dengan `CRON_SECRET`, atau menu admin "Sinkronisasi katalog").
Tanpa langkah ini katalog akan tampil kosong — kosong yang jujur, bukan angka karangan.

---

## 5. Integrasi TeleKos — **BELUM TERVERIFIKASI**

`supplier.contractVerified = false` dilaporkan di `/api/health` dan tidak ada klaim
"aktif"/"real-time" di UI maupun API.

| Aspek | Kondisi |
|---|---|
| Adapter terpisah dari controller/UI/wallet | ✔ hanya server-side |
| Endpoint/payload/status dikarang | ✔ tidak — mengikuti TELEKOS.ID API v1 |
| Signature webhook HMAC `t=…,v1=…` + dedupe `X-Telekos-Delivery` | ✔ ada dan teruji |
| Duplikat event mengubah saldo dua kali | ✔ tidak (dedupe + update idempoten) |
| HTTP request dianggap bukti sukses | ✔ tidak |
| Refund saat timeout/status tak dikenal | ✔ tidak — masuk `needs_review` |
| URL webhook = domain produksi | ❓ belum dapat dipastikan (dashboard TeleKos) |
| Kredensial live benar | ❓ belum diuji ke `GET https://telekos.id/v1/balance` |
| Kontrak resmi dikonfirmasi pemilik | ❓ belum |

**Risiko yang perlu diketahui:** sinkronisasi katalog mengambil data dari TeleKos.
Selama kredensial belum diuji, katalog bisa tetap kosong walau skema sudah ada.

---

## 6. Runtime vs Integrasi (dipisah)

**Runtime aplikasi** — terverifikasi di produksi:
- Tidak ada endpoint publik yang 500 lagi ✔
- Tidak ada angka karangan saat data tidak ada ✔
- Tidak ada secret atau klaim real-time di respons publik ✔
- Landing page tetap 200 saat data gagal ✔

**Integrasi layanan pihak ketiga** — belum:
- Supabase Postgres: tersambung, **skema kosong** ⏳ (menunggu bootstrap)
- Supabase Auth: rate-limit email belum diuji ke project nyata ⏳
- TeleKos: **belum terverifikasi sama sekali** ❌
- Payment gateway: nonaktif sesuai desain ✔

---

## 7. Catatan operasional

1. **Cron di paket Hobby hanya boleh harian.** `vercel.json` sudah disesuaikan
   (`02:00` poll, `03:00` reconcile). OTP tetap sampai ke pengguna lewat
   sinkronisasi di dalam aplikasi (`POST /api/orders/:id/sync`), bukan lewat cron.
2. **Token Vercel** yang dipakai untuk deploy sebaiknya di-revoke setelah selesai:
   https://vercel.com/account/tokens
3. **Kuota email Supabase**: kode sekarang menjawab 429 dengan sopan + waktu tunggu,
   tapi kuota kirim tetap harus dicek di Authentication → Rate Limits / SMTP.
