# Push ke GitHub

Repositori lokal sudah siap: `git init`, satu commit bersih, `.gitignore` yang
menahan `node_modules`, `.env.*`, `.vercel`, `storage/`, `logs/`.

**Belum ada yang terkirim ke GitHub**, karena sandbox ini tidak punya kredensial
GitHub: konektor GitHub tidak tersedia untuk percakapan ini, dan tidak ada
`GITHUB_TOKEN` di environment. Yang saya butuhkan hanya satu dari dua ini.

## Cara A — Anda yang push (paling aman, tidak perlu berbagi token)

```bash
# di mesin Anda, dari salinan folder ini
cd finzz-store
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

## Cara B — saya yang push

Buat **fine-grained personal access token** (GitHub → Settings → Developer
settings → Personal access tokens → Fine-grained):

- Repository access: **Only select repositories** → repo tujuan
- Permissions: **Contents: Read and write**
- Expiry: 7 hari (atau paling pendek yang nyaman)

Lalu kirim ke chat: token + `owner/repo`. Saya set remote, push, dan **laporan
selesai** — setelah itu cabut tokennya.

Jangan pakai classic token dengan scope `repo` penuh, dan jangan kirim password
akun GitHub.

## Setelah repo ada

### 1. Secrets untuk workflow deploy

GitHub → Settings → Secrets and variables → Actions:

| Secret | Isi |
|---|---|
| `VERCEL_TOKEN` | token Vercel (scope project `finzzstore`) |
| `VERCEL_ORG_ID` | `team_BOLzu0FwElfirJfuk38cIl7S` |
| `VERCEL_PROJECT_ID` | `prj_4DpvuoYYo6ceyeeZGpkyJPVmNvDE` |
| `DATABASE_URL_MIGRATE` | connection string **sesi** (port 5432), bukan 6543 |
| `DATABASE_SSL` | `no-verify` (lihat alasan di `ENV-PRODUKSI.md` §2) |
| `CRON_SECRET` | nilai yang sama dengan di Vercel |
| `PRODUCTION_URL` | `https://finzzstore.nightvale.xyz` |

### 2. Dua workflow yang sudah ada

- **`.github/workflows/ci.yml`** — setiap push/PR: `npm run check`,
  `npm test`, lalu PostgreSQL 17 sebagai service container untuk
  `npm run db:bootstrap` + `npm run test:sql` + `npm run db:verify`.
  Artinya migrasi yang salah tertangkap di PR, bukan di produksi.
- **`.github/workflows/deploy.yml`** — push ke `main` (atau manual):
  cek → tes → **migrasi** → verifikasi skema → deploy Vercel → verifikasi
  runtime + pemicu `POST /api/cron/catalog`. Sama urutannya dengan
  `./deploy.sh`.

### 3. Yang tidak boleh masuk repo

`.env`, `.env.local`, `.vercel/`, `storage/` (bukti transfer pelanggan), dan
`logs/`. Semuanya sudah diblokir `.gitignore`; kalau ada yang terlanjur
ter-commit, hapus dari histori — bukan hanya commit penghapusan.
