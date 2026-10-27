#!/usr/bin/env node
// ============================================================================
// DATABASE VERIFICATION — checks that the deployed Supabase/PostgreSQL schema
// matches what the application expects: tables, RLS, policies, RPCs and grants.
//
//   DATABASE_URL=postgres://... npm run db:verify
//
// Uses the direct Postgres connection (session mode / pooler port 5432) because
// PostgREST cannot introspect pg_catalog.
// ============================================================================
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_TABLES = [
  'profiles', 'wallets', 'wallet_transactions', 'deposits', 'services',
  'orders', 'order_events', 'app_settings', 'admin_audit_logs'
];

const REQUIRED_RPCS = [
  'rpc_create_order', 'rpc_attach_supplier_order', 'rpc_apply_supplier_state', 'rpc_fail_order',
  'rpc_begin_cancel', 'rpc_release_cancel', 'rpc_refund_order', 'rpc_create_deposit',
  'rpc_approve_deposit', 'rpc_reject_deposit', 'rpc_admin_adjust_balance', 'rpc_set_user_role',
  'rpc_set_user_status', 'rpc_claim_orders_for_sync', 'rpc_release_order_lease',
  'rpc_flag_orphan_pending_orders', 'rpc_acquire_job_lease', 'rpc_release_job_lease',
  'rpc_sync_services', 'rpc_record_webhook_event', 'rpc_public_summary', 'rpc_admin_dashboard',
  'rpc_rate_limit_hit', 'ensure_user_profile'
];

const USER_WRITABLE_TABLES = ['profiles', 'wallets', 'wallet_transactions', 'deposits', 'orders', 'order_events'];

async function main() {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Example:');
    console.error('  DATABASE_URL=postgres://postgres:PASSWORD@db.<project>.supabase.co:5432/postgres npm run db:verify');
    console.error(`\nStatic schema files: ${path.join(ROOT, 'database')}/{schema,policies,functions}.sql`);
    process.exitCode = 2;
    return;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: url, ssl: process.env.PG_NO_SSL === '1' ? false : { rejectUnauthorized: false } });
  await client.connect();

  const problems = [];
  const notes = [];
  const lines = [];

  try {
    const { rows: tables } = await client.query(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`
    );
    const names = new Set(tables.map((row) => row.tablename));
    for (const table of REQUIRED_TABLES) {
      if (!names.has(table)) problems.push(`missing table: ${table}`);
    }
    lines.push(`tables: ${names.size} found (${REQUIRED_TABLES.length} required)`);

    const { rows: rls } = await client.query(
      `select c.relname as table, c.relrowsecurity as enabled
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`
    );
    for (const row of rls) {
      if (USER_WRITABLE_TABLES.includes(row.table) && !row.enabled) {
        problems.push(`row level security is disabled on ${row.table}`);
      }
    }
    lines.push(`rls: ${rls.filter((r) => r.enabled).length}/${rls.length} tables protected`);

    const { rows: policies } = await client.query(
      `select tablename, policyname from pg_policies where schemaname = 'public'`
    );
    const perTable = new Map();
    for (const row of policies) perTable.set(row.tablename, (perTable.get(row.tablename) || 0) + 1);
    for (const table of USER_WRITABLE_TABLES) {
      if (!perTable.get(table)) problems.push(`no RLS policy on ${table}`);
    }
    lines.push(`policies: ${policies.length} across ${perTable.size} tables`);

    const { rows: functions } = await client.query(
      `select p.proname as name,
              pg_get_function_identity_arguments(p.oid) as args,
              p.prosecdef as security_definer
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`
    );
    const fnNames = new Set(functions.map((row) => row.name));
    for (const fn of REQUIRED_RPCS) {
      if (!fnNames.has(fn)) problems.push(`missing function: ${fn}`);
    }
    const notHardened = functions.filter(
      (row) => row.name.startsWith('rpc_') && row.security_definer === false
    );
    if (notHardened.length) {
      problems.push(`RPCs without SECURITY DEFINER: ${notHardened.map((r) => r.name).join(', ')}`);
    }
    lines.push(`functions: ${fnNames.size} found (${REQUIRED_RPCS.length} required)`);

    const { rows: grants } = await client.query(
      `select p.proname as name, r.rolname as role
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join information_schema.routine_privileges rp on rp.routine_name = p.proname
         join pg_roles r on r.rolname = rp.grantee
        where n.nspname = 'public' and p.proname like 'rpc_%' and rp.privilege_type = 'EXECUTE'`
    );
    // rpc_public_summary is *meant* to be callable by anon: it powers the public
    // landing page and returns only aggregate counts. rpc_rate_limit_hit must NOT
    // be anon-executable. Everything else stays service_role only.
    const PUBLIC_BY_DESIGN = new Set(['rpc_public_summary']);
    const publicExecute = grants
      .filter((row) => ['public', 'anon', 'authenticated'].includes(row.role))
      .filter((row) => !PUBLIC_BY_DESIGN.has(row.name));
    if (publicExecute.length) {
      problems.push(`RPCs executable by untrusted roles: ${[...new Set(publicExecute.map((r) => r.name))].join(', ')}`);
    }
    lines.push(`grants: ${new Set(grants.map((r) => r.name)).size} RPCs executable by service_role only`);

    const { rows: settings } = await client.query(`select key from public.app_settings`);
    const settingKeys = new Set(settings.map((row) => row.key));
    for (const key of ['store_profile', 'deposit_policy', 'pricing_policy', 'operations', 'refund_policy', 'legal', 'supplier']) {
      if (!settingKeys.has(key)) problems.push(`missing app_settings row: ${key}`);
    }
    lines.push(`settings: ${settingKeys.size} keys`);

    const { rows: admins } = await client.query(`select count(*)::int as count from public.profiles where role = 'admin'`);
    lines.push(`admins: ${admins[0]?.count ?? 0}`);
    if ((admins[0]?.count ?? 0) === 0) {
      // Not a schema problem: a brand-new install legitimately has no admin
      // until the owner registers and is promoted. Warn, don't block a deploy.
      notes.push('belum ada akun admin — daftar dulu, lalu promote: npm run db:seed-dev -- --promote <email>');
    }

    const schemaSql = await readFile(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
    lines.push(`schema.sql: ${(schemaSql.match(/create table/gi) || []).length} create-table statements`);
  } finally {
    await client.end();
  }

  console.log('FINZZ Store — database verification');
  for (const line of lines) console.log(`  · ${line}`);
  for (const note of notes) console.log(`  ! ${note}`);
  if (problems.length) {
    console.error(`\n✖ ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✔ database matches the application contract');
}

main().catch((err) => {
  console.error(`db:verify failed: ${err.message}`);
  process.exitCode = 1;
});
