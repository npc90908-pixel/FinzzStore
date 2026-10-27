#!/usr/bin/env node
// ============================================================================
// PRODUCTION VERIFIER
//
//   node scripts/verify-production.mjs                       # finzzstore.vercel.app
//   node scripts/verify-production.mjs https://domain.lain  # domain lain
//
// Menguji hasil deploy dari LUAR, sebagai pengguna biasa:
//   · tidak ada endpoint publik yang menjawab 500
//   · katalog tetap menampilkan layanan (atau 503 yang jujur, bukan 500)
//   · ringkasan jujur: available true + angka nyata, atau false + null
//   · config melaporkan settingsAvailable
//   · health melaporkan contractVerified sesuai bukti (bukan hardcode)
//   · tidak ada klaim "real-time" dan tidak ada secret di HTML/JSON
//
// Exit 0 = semua lulus, 1 = ada yang gagal, 2 = tidak bisa dihubungi.
// ============================================================================
const BASE = (process.argv[2] || 'https://finzzstore.vercel.app').replace(/\/$/, '');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function get(path, { timeout = 30000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { 'user-agent': 'finzz-verify/1.0' },
      signal: AbortSignal.timeout(timeout)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: response.status, text, json, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, text: '', json: null, ms: Date.now() - started, error: err.message };
  }
}

console.log(`FINZZ Store — verifikasi produksi\n${BASE}\n${new Date().toISOString()}\n`);

// ------------------------------------------------------------------ health --
const health = await get('/api/health');
if (health.status === 0) {
  console.error(`✖ Tidak dapat menghubungi ${BASE}: ${health.error}`);
  process.exit(2);
}
check('GET /api/health → 200', health.status === 200, `${health.status} (${health.ms} ms)`);
const h = health.json || {};
check('database tersambung', h.database?.ok === true, `${h.database?.driver} ${h.database?.latencyMs}ms`);
// Produksi harus benar-benar memakai TeleKos, bukan fixture.
check('supplier dalam mode live', h.supplier?.mode === 'live', `mode=${h.supplier?.mode}`);
check('supplier bukan data mock', h.supplier?.mock === false, `mock=${h.supplier?.mock}`);
check('supplier tidak melaporkan error', !h.supplier?.lastError, `lastError=${h.supplier?.lastError ?? 'null'}`);
// contractVerified adalah status PER-PROSES: ia baru benar setelah proses yang
// melayani permintaan ini benar-benar memanggil TeleKos. Deployment yang baru
// dibuat belum pernah melakukannya, jadi ini tidak boleh menggagalkan rilis —
// tapi juga tidak boleh disembunyikan.
if (h.supplier?.contractVerified === true) {
  check('kontrak supplier terbukti di proses ini', true,
    `endpoint: ${(h.supplier?.verifiedEndpoints || []).join(', ') || '-'}`);
} else {
  console.log('  ! kontrak supplier belum dibuktikan proses ini '
    + '(belum ada panggilan ke TeleKos sejak proses hidup)');
  if (process.env.FINZZ_CRON_SECRET) {
    check('kontrak supplier terbukti setelah sinkronisasi katalog', false,
      'cron sudah dipanggil tetapi supplier tetap belum terverifikasi');
  }
}
check('status rate limiter terbaca', Boolean(h.rateLimiter), h.rateLimiter?.mode || 'tidak ada');
if (h.rateLimiter?.mode === 'degraded') {
  check('rate limiter terdistribusi', false, 'DEGRADED — store rate limit tidak dapat diakses, jalankan migrasi 001');
} else if (h.rateLimiter?.mode === 'unverified') {
  check('rate limiter belum terbukti', true, 'mode unverified — belum ada panggilan RPC yang berhasil, bukan klaim "aktif"');
}

// -------------------------------------------------------------- public API --
const config = await get('/api/public/config');
check('GET /api/public/config → 200', config.status === 200, `${config.status}`);
check('config melaporkan settingsAvailable', typeof config.json?.settingsAvailable === 'boolean',
  `settingsAvailable=${config.json?.settingsAvailable}`);

const summary = await get('/api/public/summary');
check('GET /api/public/summary → 200 (tidak pernah 500)', summary.status === 200, `${summary.status}`);
if (summary.status === 200) {
  const s = summary.json || {};
  if (s.available === true) {
    check('ringkasan tersedia dengan angka nyata',
      Number.isInteger(s.activeServices) && s.activeServices >= 0,
      `activeServices=${s.activeServices} countries=${s.countries} apps=${s.apps}`);
    check('ringkasan tidak kosong padahal katalog berisi', s.activeServices > 0, `activeServices=${s.activeServices}`);
  } else {
    check('ringkasan jujur saat tidak tersedia (null, bukan angka karangan)',
      s.activeServices === null && s.reason === 'SUMMARY_UNAVAILABLE',
      `available=${s.available} reason=${s.reason}`);
    console.log('  → Skema database belum diterapkan: jalankan database/BOOTSTRAP_SUPABASE.sql di Supabase SQL Editor');
  }
}

const catalog = await get('/api/public/catalog');
check('GET /api/public/catalog → bukan 500', catalog.status === 200 || catalog.status === 503,
  `${catalog.status}`);
if (catalog.status === 200) {
  const c = catalog.json || {};
  const count = Array.isArray(c.services) ? c.services.length : -1;
  check('katalog mengirim array layanan', count >= 0, `${count} layanan, summarySource=${c.summarySource}`);
  if (count === 0) {
    console.log('  → Katalog terbaca tetapi KOSONG: jalankan sinkronisasi katalog (/api/cron/reconcile) atau tunggu sync berikutnya.');
  }
  if (count === 0) check('katalog belum berisi layanan', false, '0 layanan — sinkronisasi belum pernah berhasil');
  check('katalog menyebut sumber ringkasan', c.summarySource === 'rpc' || c.summarySource === 'derived',
    c.summarySource);
  check('katalog bukan data mock', c.source !== 'mock', `source=${c.source}`);
  check('flag available konsisten dengan isi katalog', c.available === (count > 0),
    `available=${c.available} services=${count}`);
} else if (catalog.status === 503) {
  check('503 katalog punya kode yang bisa ditindaklanjuti', catalog.json?.error?.code === 'CATALOG_UNAVAILABLE',
    catalog.json?.error?.code);
}

// ---------------------------------------------------------------- landing --
const landing = await get('/');
check('GET / → 200', landing.status === 200, `${landing.status} (${landing.text.length} byte)`);

// ------------------------------------------------------- kebocoran / klaim --
const blobs = [landing.text, config.text, summary.text, catalog.text, health.text].join('\n');
const leaks = [
  [/service_role/i, 'service_role'],
  [/sbp_[A-Za-z0-9]{8,}/, 'service role key'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./, 'JWT'],
  [/postgres(?:ql)?:\/\/[^\s"']+/, 'connection string']
].filter(([re]) => re.test(blobs)).map(([, label]) => label);
check('tidak ada secret di respons publik', leaks.length === 0, leaks.join(', ') || 'bersih');

check('tidak ada klaim "real-time" tanpa dasar', !/real[\s-]?time/i.test(blobs), 'bersih');

// ------------------------------------------------------------------ ringkas --
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pemeriksaan lulus`);
if (failed.length) {
  console.log('\nGagal:');
  for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('\nSemua pemeriksaan produksi lulus.');
