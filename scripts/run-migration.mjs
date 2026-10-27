#!/usr/bin/env node
// ============================================================================
// MIGRATION RUNNER — satu perintah untuk seluruh siklus skema database.
//
//   DATABASE_URL=... node scripts/run-migration.mjs              # terapkan yang tertunda
//   DATABASE_URL=... node scripts/run-migration.mjs --dry-run     # lihat saja
//   DATABASE_URL=... node scripts/run-migration.mjs --status      # apa yang sudah/belum
//   DATABASE_URL=... node scripts/run-migration.mjs --bootstrap   # skema dasar dulu, lalu migrasi
//   DATABASE_URL=... node scripts/run-migration.mjs --baseline    # tandai sudah ada (tanpa mengeksekusi)
//
// Kenapa satu perintah, bukan dua:
//   Skema FINZZ punya DUA lapis — skema dasar (tabel, RLS, RPC) dan seluruh
//   file migrasi bernomor di atasnya. Menjalankan migrasi di database kosong selalu gagal.
//   Runner ini yang memutuskan: kalau skema dasar belum ada, ia berhenti dan
//   menyuruh pakai --bootstrap, alih-alih meledak dengan error PL/pgSQL yang
//   tidak bisa dibaca manusia.
//
// Jaminan:
//   · idempoten — setiap file SQL-nya sendiri idempoten, dan nama file dicatat
//     di public.schema_migrations sehingga eksekusi ulang tidak mengulang kerja;
//   · tidak menghapus data, tidak mematikan RLS;
//   · setiap migrasi berjalan di transaksinya sendiri: satu gagal, sisanya utuh;
//   · menghormati DATABASE_SSL (require / no-verify / disable) sama seperti
//     aplikasi, jadi pooler Supabase yang sertifikatnya self-signed tetap bisa.
// ============================================================================
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');
const BOOTSTRAP_FILE = path.join(ROOT, 'database', 'BOOTSTRAP_SUPABASE.sql');
const SHIM_FILE = path.join(ROOT, 'database', 'LOCAL_SHIM.sql');
const SWEEP_FILE = path.join(ROOT, 'database', 'GRANT_SWEEP.sql');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const statusOnly = args.has('--status');
const withBootstrap = args.has('--bootstrap');
const baseline = args.has('--baseline');

const url = (process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error(
    'DATABASE_URL belum diset.\n' +
    '  Contoh: DATABASE_URL="postgres://user:pass@host:5432/postgres" npm run db:migrate'
  );
  process.exit(2);
}

// Same three modes as src/database-pg.js — no surprises between app and scripts.
const sslMode = (process.env.DATABASE_SSL || 'require').trim();
const ssl = sslMode === 'disable'
  ? false
  : { rejectUnauthorized: sslMode !== 'no-verify' };
if (sslMode === 'no-verify') {
  console.log('· TLS: enkripsi aktif, verifikasi sertifikat dimatikan (DATABASE_SSL=no-verify)');
}

const client = new pg.Client({ connectionString: url, ssl, connectionTimeoutMillis: 15000 });

/**
 * Apakah database ini punya prasyarat Supabase (role anon + schema auth)?
 * Kalau tidak, ini PostgreSQL biasa dan shim lokal diperlukan.
 */
async function supabasePrereqs() {
  const { rows } = await client.query(`
    select
      exists (select 1 from pg_roles where rolname = 'anon')          as has_anon_role,
      exists (select 1 from pg_namespace where nspname = 'auth')      as has_auth_schema
  `);
  return { ready: rows[0].has_anon_role && rows[0].has_auth_schema, ...rows[0] };
}

/** Apakah skema dasar FINZZ sudah ada di database ini? */
async function baseSchemaState() {
  const { rows } = await client.query(`
    select
      to_regclass('public.services')  is not null as has_services,
      to_regclass('public.profiles')  is not null as has_profiles,
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'rpc_create_order') as has_rpc
  `);
  const r = rows[0];
  return { ready: r.has_services && r.has_profiles && r.has_rpc, ...r };
}

async function ensureLedger() {
  await client.query(`
    create table if not exists public.schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now(),
      checksum    text
    );
    alter table public.schema_migrations add column if not exists checksum text;
  `);
}

async function listFiles() {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

async function appliedSet() {
  const { rows } = await client.query('select name, to_char(applied_at, \'YYYY-MM-DD HH24:MI\') as at from public.schema_migrations order by name');
  return new Map(rows.map((r) => [r.name, r.at]));
}

/** Menjalankan satu file SQL (boleh berisi banyak statement) dalam transaksi. */
async function runFile(absPath, label) {
  const sql = await readFile(absPath, 'utf8');
  process.stdout.write(`→ ${label} … `);
  if (dryRun) { console.log('(dry-run, dilewati)'); return false; }
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('commit');
    console.log('OK');
    return true;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.log('GAGAL');
    console.error(`\n  ${err.message}`);
    if (err.detail) console.error(`  detail: ${err.detail}`);
    if (err.hint) console.error(`  hint:   ${err.hint}`);
    if (err.position) console.error(`  posisi: ${err.position}`);
    throw err;
  }
}

try {
  await client.connect();
  const sslInfo = await client.query('select current_database() as db, current_user as usr');
  console.log(`Database : ${sslInfo.rows[0].db} sebagai ${sslInfo.rows[0].usr}`);

  let base = await baseSchemaState();
  const prereqs = await supabasePrereqs();
  console.log(`Skema dasar: ${base.ready ? 'ada' : 'BELUM ADA'}`);
  if (!prereqs.ready) {
    console.log('Prasyarat Supabase: TIDAK ADA (database ini PostgreSQL biasa)');
  }

  // ------------------------------------------------------------- --status ---
  if (statusOnly) {
    if (!base.ready) {
      console.log('\nSkema dasar belum ada. Jalankan: npm run db:bootstrap');
      process.exit(0);
    }
    await ensureLedger();
    const applied = await appliedSet();
    const files = await listFiles();
    console.log('\nMigrasi:');
    for (const file of files) {
      console.log(`  ${applied.has(file) ? '✔' : '·'} ${file}${applied.has(file) ? `  (${applied.get(file)})` : '  — belum'}`);
    }
    const pending = files.filter((f) => !applied.has(f)).length;
    console.log(`\n${files.length - pending}/${files.length} tercatat diterapkan.${pending ? ` ${pending} tertunda.` : ''}`);
    process.exit(0);
  }

  // ---------------------------------------------------------- --bootstrap ---
  if (!base.ready) {
    if (!withBootstrap) {
      console.error(
        '\nSkema dasar (tabel + RLS + RPC) belum ada, jadi migrasi tidak akan jalan.\n' +
        'Jalankan salah satu:\n' +
        '  npm run db:bootstrap     # terapkan database/BOOTSTRAP_SUPABASE.sql lalu migrasi\n' +
        '  npm run db:baseline      # kalau Anda yakin skemanya sudah dibuat manual'
      );
      process.exit(3);
    }
    // PostgreSQL polos tidak punya role anon / schema auth / auth.users.
    // Tanpa shim, bootstrap gagal dengan "schema auth does not exist" yang
    // tidak menjelaskan apa pun. Terapkan shim lebih dulu, dan katakan terang.
    const fresh = await supabasePrereqs();
    if (!fresh.ready) {
      console.log('\nMenerapkan LOCAL_SHIM.sql (role anon/authenticated/service_role, schema auth, auth.users)…');
      await runFile(SHIM_FILE, 'LOCAL_SHIM.sql');
      console.log('  · shim ini hanya untuk PostgreSQL non-Supabase; auth.uid() selalu null.');
    }

    console.log('\nMenerapkan skema dasar (BOOTSTRAP_SUPABASE.sql)…');
    const ok = await runFile(BOOTSTRAP_FILE, 'BOOTSTRAP_SUPABASE.sql');
    // Verifikasi ulang: bootstrap boleh "sukses" tapi tidak membuat apa pun
    // kalau dijalankan pada database yang salah.
    base = await baseSchemaState();
    if (!ok || !base.ready) {
      console.error('Skema dasar tetap belum lengkap setelah bootstrap. Berhenti.');
      process.exit(4);
    }
  }

  await ensureLedger();
  const files = await listFiles();

  // ----------------------------------------------------------- --baseline ---
  if (baseline) {
    console.log('\nBaseline: menandai migrasi sebagai sudah diterapkan TANPA mengeksekusi.');
    for (const file of files) {
      await client.query(
        'insert into public.schema_migrations (name, checksum) values ($1, $2) on conflict (name) do nothing',
        [file, 'baseline']
      );
    }
    console.log(`${files.length} migrasi ditandai. Jalankan db:verify untuk membuktikan skemanya benar.`);
    process.exit(0);
  }

  // ------------------------------------------------------------ --migrate ---
  const applied = await appliedSet();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`\nSemua ${files.length} migrasi sudah diterapkan. Tidak ada yang perlu dijalankan.`);
    if (!dryRun) {
      process.stdout.write('→ GRANT_SWEEP.sql (kunci hak eksekusi RPC) … ');
      await runFile(SWEEP_FILE, 'GRANT_SWEEP.sql');
    }
    process.exit(0);
  }

  console.log(`\n${pending.length} migrasi tertunda:`);
  let ran = 0;
  for (const file of pending) {
    const ok = await runFile(path.join(MIGRATIONS_DIR, file), file);
    if (ok) {
      await client.query(
        'insert into public.schema_migrations (name, checksum) values ($1, $2) on conflict (name) do update set applied_at = now()',
        [file, 'file']
      );
      ran += 1;
    }
  }
  console.log(`\n${dryRun ? 'Dry-run: tidak ada yang ditulis.' : `${ran} migrasi diterapkan.`}`);

  // Always sweep, even when no migration was pending: a function created by
  // hand in the SQL editor would otherwise stay anon-executable.
  if (!dryRun) {
    process.stdout.write('→ GRANT_SWEEP.sql (kunci hak eksekusi RPC) … ');
    await runFile(SWEEP_FILE, 'GRANT_SWEEP.sql');
  }
} catch (err) {
  console.error(`\nRunner gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
