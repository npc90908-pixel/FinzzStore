#!/usr/bin/env node
// ============================================================================
// FINZZ Store — DATABASE DOCTOR
//
// Answers one question: "why is the production database failing?" — without
// guessing and without printing a single secret.
//
// It checks, in order:
//   1. environment completeness (presence only, never values)
//   2. REST connectivity with the service role key (401 = wrong key/project)
//   3. the tables the public endpoints read
//   4. every RPC the application calls, with the exact PostgREST/PostgreSQL
//      code for each failure
//   5. PostgREST schema-cache staleness (the classic PGRST202 after a migration)
//   6. optional: ask PostgREST to reload its schema cache (--reload)
//
// Usage
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/db-doctor.mjs
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/db-doctor.mjs --reload
//
// Exit codes: 0 all good, 1 problems found, 2 configuration missing.
// ============================================================================
import { createClient } from '@supabase/supabase-js';
import { scrubSecrets } from '../src/errors.js';

const RESET = '\u001b[0m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const args = new Set(process.argv.slice(2));
const color = process.stdout.isTTY && !args.has('--no-color');
const paint = (code, text) => (color ? `${code}${text}${RESET}` : text);

const results = { ok: 0, warn: 0, fail: 0 };
const ok = (label, detail = '') => {
  results.ok += 1;
  console.log(`${paint(GREEN, '✔')} ${label}${detail ? ` ${paint(DIM, detail)}` : ''}`);
};
const warn = (label, detail = '', hint = '') => {
  results.warn += 1;
  console.log(`${paint(YELLOW, '!')} ${label}${detail ? ` ${paint(DIM, detail)}` : ''}`);
  if (hint) console.log(`  ${paint(DIM, `→ ${hint}`)}`);
};
const fail = (label, detail = '', hint = '') => {
  results.fail += 1;
  console.log(`${paint(RED, '✖')} ${label}${detail ? ` ${paint(DIM, detail)}` : ''}`);
  if (hint) console.log(`  ${paint(DIM, `→ ${hint}`)}`);
};

/**
 * Turn a raw driver error into an actionable instruction.
 * This is the whole point of the script: PGRST202 is not "the API is broken",
 * it is "the schema cache is stale — run `notify pgrst, 'reload schema'`".
 */
function explain(error) {
  const code = String(error?.code || '');
  const message = scrubSecrets(error?.message || '');
  switch (code) {
    case 'PGRST202':
    case 'PGRST203':
      return {
        kind: 'missing-function',
        hint: 'PostgREST does not know this function. Run database/migrations/001_fix_public_rpc_and_rate_limit.sql, then `notify pgrst, \'reload schema\';` (or rerun this script with --reload).'
      };
    case '42501':
      return {
        kind: 'permission',
        hint: 'EXECUTE was revoked. Re-apply the GRANTS section of database/functions.sql. Remember mutating RPCs are service_role only by design.'
      };
    case '42P01':
      return { kind: 'missing-table', hint: 'A table is missing — run database/schema.sql (and policies.sql) against this project.' };
    case '42703':
      return { kind: 'missing-column', hint: 'The deployed schema is older than the code — apply the migrations first.' };
    case 'PGRST301':
    case 'PGRST302':
      return { kind: 'auth', hint: 'The key was rejected. Check SUPABASE_SERVICE_ROLE_KEY belongs to THIS project and was not rotated.' };
    default:
      break;
  }
  if (/row-level security|permission denied/i.test(message)) {
    return { kind: 'rls', hint: 'RLS is blocking the service role. The service role must use the service_role key (BYPASSRLS), not the anon key.' };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(message)) {
    return { kind: 'network', hint: 'Cannot reach the project URL. Verify SUPABASE_URL and that the project is not paused.' };
  }
  return { kind: 'unknown', hint: 'See the message above; it is usually enough to identify the missing migration or grant.' };
}

async function main() {
  console.log(`\nFINZZ Store — database doctor\n${paint(DIM, new Date().toISOString())}\n`);

  // ---------------------------------------------------------------- 1. env --
  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!url || !serviceKey) {
    fail('Environment', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    console.log('\nSet both variables and run again. No secrets are printed by this script.\n');
    process.exit(2);
  }

  ok('SUPABASE_URL present', `host=${scrubSecrets(url).replace(/^https?:\/\//, '')}`);
  ok('SUPABASE_SERVICE_ROLE_KEY present', `length=${serviceKey.length}`);
  if (anonKey) ok('SUPABASE_ANON_KEY present', `length=${anonKey.length}`);
  else warn('SUPABASE_ANON_KEY missing', '', 'Supabase Auth sign-in requires the anon key.');

  if (anonKey && anonKey === serviceKey) {
    fail('SERVICE_ROLE_KEY equals ANON_KEY', '', 'The server would run under RLS. Use the service_role secret for the server.');
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });

  // --------------------------------------------------------- 2. connectivity --
  const ping = await admin.from('app_settings').select('key', { head: true, count: 'exact' }).limit(1);
  if (ping.error) {
    const info = explain(ping.error);
    fail('REST connectivity', `${ping.error.code || ''} ${scrubSecrets(ping.error.message)}`, info.hint);
    console.log(`\n${paint(RED, 'Stopped:')} nothing else can be verified without a working connection.\n`);
    process.exit(1);
  }
  ok('REST connectivity', 'service role accepted');

  // -------------------------------------------------------------- 3. tables --
  const TABLES = ['app_settings', 'services', 'profiles', 'wallets', 'wallet_transactions', 'deposits', 'orders', 'order_events', 'admin_audit_logs'];
  for (const table of TABLES) {
    const { error, count } = await admin.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) fail(`table ${table}`, `${error.code || ''} ${scrubSecrets(error.message)}`, explain(error).hint);
    else ok(`table ${table}`, `rows=${count ?? '?'}`);
  }

  // ---------------------------------------------------------------- 4. RPCs --
  // (name, arguments) — arguments mirror exactly what src/database.js sends.
  const RPCS = [
    ['rpc_public_summary', undefined],
    ['rpc_rate_limit_hit', { p_key: `doctor:${Date.now()}`, p_limit: 1000, p_window_seconds: 60 }],
    ['rpc_acquire_job_lease', { p_name: `doctor-${Date.now()}`, p_owner: 'db-doctor', p_lease_seconds: 30 }]
  ];

  console.log(`\n${paint(DIM, '— RPCs used by the public read path and the rate limiter —')}`);
  for (const [name, params] of RPCS) {
    const { data, error } = await admin.rpc(name, params);
    if (error) {
      const info = explain(error);
      fail(`rpc ${name}`, `${error.code || ''} ${scrubSecrets(error.message)}`, info.hint);
      continue;
    }
    ok(`rpc ${name}`, data === null ? 'null' : 'ok');
  }

  // ------------------------------------------------------ 5. schema cache ----
  console.log(`\n${paint(DIM, '— PostgREST schema cache —')}`);
  const cacheProbe = await admin.rpc('rpc_public_summary');
  if (cacheProbe.error?.code === 'PGRST202') {
    warn('schema cache is stale', '', 'Run with --reload (needs a direct DATABASE_URL) or execute `notify pgrst, \'reload schema\';` in the SQL editor.');
  } else {
    ok('public RPC is visible to PostgREST');
  }

  // ------------------------------------------------------------ 6. reload ----
  if (args.has('--reload')) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      warn('--reload skipped', 'DATABASE_URL not set', 'Connect with psql and run: notify pgrst, \'reload schema\';');
    } else {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: databaseUrl });
      try {
        await client.connect();
        await client.query("notify pgrst, 'reload schema'");
        ok('schema cache reload requested');
      } catch (err) {
        fail('schema cache reload failed', scrubSecrets(err.message));
      } finally {
        await client.end().catch(() => {});
      }
    }
  }

  // --------------------------------------------------------------- summary --
  console.log(
    `\n${results.fail ? paint(RED, `${results.fail} problem(s)`) : paint(GREEN, 'no blocking problems')}` +
      `, ${results.warn} warning(s), ${results.ok} check(s) passed.\n`
  );
  process.exit(results.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${paint(RED, 'db-doctor crashed:')} ${scrubSecrets(err?.message || String(err))}\n`);
  process.exit(1);
});
