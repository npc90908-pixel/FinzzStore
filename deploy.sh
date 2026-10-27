#!/usr/bin/env bash
# ============================================================================
# DEPLOY FINZZ STORE — cek → migrasi → verifikasi skema → deploy → verifikasi runtime
#
#   VERCEL_TOKEN=xxx DATABASE_URL='postgres://...' ./deploy.sh
#   VERCEL_TOKEN=xxx DATABASE_URL='postgres://...' ./deploy.sh --preflight   # berhenti sebelum deploy
#   SKIP_MIGRATE=1 ...                            ./deploy.sh              # darurat saja
#
# Kenapa migrasi ada DI DALAM rantai ini:
#   Deploy yang hanya mengunggah kode adalah deploy yang setengah jadi. Aplikasi
#   ini menolak boot tanpa skema yang benar (password_hash, auth_tokens,
#   cron_locks, pricing_snapshot), dan kegagalannya muncul sebagai 500 di
#   produksi — bukan di sini. Jadi migrasi dijalankan SEBELUM kode naik, dan
#   skemanya diverifikasi sebelum deploy dimulai.
#
#   Aplikasi tetap kompatibel dengan skema lama selama proses migrasi berjalan,
#   karena semua migrasi bersifat aditif dan idempoten.
# ============================================================================
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN wajib diisi (Vercel → Account Settings → Tokens)}"

SCOPE="${VERCEL_SCOPE:-xcxzoomcs-projects}"
PROJECT="${VERCEL_PROJECT:-finzzstore}"
TARGET="${VERCEL_TARGET:-production}"
DOMAIN="${FINZZ_DOMAIN:-https://finzzstore.nightvale.xyz}"
MODE="${1:-}"

cd "$(dirname "$0")"

export PATH="/home/user/.local/node24/bin:${PATH}"

VERCEL_BIN="$(command -v vercel || true)"
run_vercel() {
  if [ -n "$VERCEL_BIN" ]; then "$VERCEL_BIN" "$@" --token "$VERCEL_TOKEN"
  else npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN"; fi
}

banner() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ============================================================== 1. PREFLIGHT ==
banner "1/6 — preflight env Vercel"
run_vercel link --yes --project "$PROJECT" --scope "$SCOPE" >/dev/null

REQUIRED=(DATABASE_URL APP_ENCRYPTION_KEY APP_URL CRON_SECRET TELEKOS_API_KEY TELEKOS_WEBHOOK_SECRET)
RECOMMENDED=(SMTP_HOST SMTP_PORT SMTP_FROM)
OBSOLETE=(SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET SUPABASE_DB_URL)

ENV_DUMP="$(run_vercel env ls "$TARGET" 2>/dev/null || true)"
if [ -z "$ENV_DUMP" ]; then
  echo "✖ tidak bisa membaca daftar env — token salah/kedaluwarsa, atau akses project ditolak." >&2
  exit 1
fi

missing=0
for name in "${REQUIRED[@]}"; do
  if printf '%s' "$ENV_DUMP" | grep -qE "(^|[[:space:]])${name}([[:space:]]|$)"; then echo "  ✔ ${name}"
  else echo "  ✖ ${name} BELUM DISET (wajib)"; missing=$((missing + 1)); fi
done
for name in "${RECOMMENDED[@]}"; do
  if printf '%s' "$ENV_DUMP" | grep -qE "(^|[[:space:]])${name}([[:space:]]|$)"; then echo "  ✔ ${name}"
  else echo "  ! ${name} belum diset — OTP email tidak akan terkirim"; fi
done
for name in "${OBSOLETE[@]}"; do
  if printf '%s' "$ENV_DUMP" | grep -qE "(^|[[:space:]])${name}([[:space:]]|$)"; then
    echo "  ! ${name} masih ada — sudah tidak dibaca kode, sebaiknya dihapus"
  fi
done
if [ "$missing" -gt 0 ]; then
  echo "" >&2
  echo "✖ ${missing} variabel wajib belum ada. Deploy dibatalkan." >&2
  exit 2
fi

# ============================================================ 2. KODE SEHAT ==
banner "2/6 — pemeriksaan statis + tes"
npm run --silent check
npm test 2>&1 | tail -5

# ============================================================== 3. MIGRASI ====
banner "3/6 — migrasi database"
if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
  echo "  ! SKIP_MIGRATE=1 — migrasi DILEWATI atas permintaan. Skema bisa tertinggal dari kode."
elif [ -z "${DATABASE_URL:-}" ]; then
  cat >&2 <<'EOF'
✖ DATABASE_URL tidak ada di shell ini, jadi migrasi tidak bisa dijalankan.

  Deploy tanpa migrasi = kode baru di atas skema lama. Aplikasi akan menolak
  melayani (500) karena kolom password_hash / auth_tokens / cron_locks belum ada.

  Jalankan ulang dengan connection string database produksi:
    DATABASE_URL='postgresql://...' VERCEL_TOKEN=xxx ./deploy.sh

  (Pakai sesi pooler port 5432 untuk migrasi; port 6543 mode transaksi tidak
   cocok untuk DDL beruntun.)

  Kalau memang harus deploy tanpa migrasi: SKIP_MIGRATE=1 ./deploy.sh
EOF
  exit 4
else
  echo "  target: $(printf '%s' "$DATABASE_URL" | sed -E 's#//[^@]*@#//***@#')"
  npm run --silent db:migrate
fi

# ==================================================== 4. VERIFIKASI SKEMA =====
banner "4/6 — verifikasi skema database"
if [ "${SKIP_MIGRATE:-0}" = "1" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "  ! dilewati (tanpa DATABASE_URL)"
else
  npm run --silent db:verify || {
    echo "✖ verifikasi skema gagal — deploy dibatalkan." >&2
    echo "  Perbaiki dulu; mengunggah kode di atas skema yang salah hanya memindahkan masalah ke pengguna." >&2
    exit 5
  }
fi

if [ "$MODE" = "--preflight" ]; then
  banner "selesai — preflight lulus (tidak deploy)"
  exit 0
fi

# ================================================================ 5. DEPLOY ==
banner "5/6 — deploy ke ${TARGET}"
run_vercel deploy --prod --yes --scope "$SCOPE" 2>&1 | tee /tmp/vercel-deploy.log | tail -4

# ===================================================== 6. VERIFIKASI RUNTIME ==
banner "6/6 — verifikasi runtime ${DOMAIN}"
sleep 8

# Kalau CRON_SECRET diberikan, buktikan integrasi supplier pada proses yang BARU
# hidup: sinkronisasi katalog menembak TeleKos sungguhan, lalu health harus
# melaporkan contractVerified. Tanpa ini, deployment baru selalu "belum
# terverifikasi" semata-mata karena belum ada panggilan keluar.
if [ -n "${FINZZ_CRON_SECRET:-}" ]; then
  echo "→ memicu POST /api/cron/catalog untuk membuktikan integrasi supplier"
  code=$(curl -s -o /tmp/cron-catalog.json -w '%{http_code}' -m 120 \
    -X POST "${DOMAIN}/api/cron/catalog" -H "Authorization: Bearer ${FINZZ_CRON_SECRET}")
  echo "  HTTP ${code} — $(head -c 240 /tmp/cron-catalog.json)"
  if [ "$code" != "200" ]; then
    echo "✖ cron katalog gagal di produksi — jalur supplier/DB bermasalah." >&2
    exit 7
  fi
fi
FINZZ_DOMAIN="$DOMAIN" node scripts/verify-production.mjs "$DOMAIN" || {
  echo "✖ verifikasi runtime gagal — baca /tmp/vercel-deploy.log." >&2
  echo "  Catatan: kalau baru saja deploy, cold start bisa butuh beberapa detik lagi." >&2
  exit 6
}
