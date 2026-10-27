// ============================================================================
// PostgreSQL harness used by the SQL test suite.
// Boots a throw-away schema, applies schema.sql -> policies.sql -> functions.sql
// and exposes helpers that emulate the Supabase runtime (auth.uid(), roles).
// Requires a local PostgreSQL reachable through TEST_DATABASE_URL.
// ============================================================================
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://finzz:finzz_local_pw@127.0.0.1:5432/finzz_test';

const SQL_FILES = ['schema.sql', 'policies.sql', 'functions.sql'];

/** database/migrations/*.sql, applied in filename order after the base files. */
async function migrationFiles() {
  const dir = path.join(ROOT, 'database', 'migrations');
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

export async function connect() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

export async function applySupabaseShim(client) {
  const sql = await readFile(path.join(ROOT, 'tests/support/supabase-shim.sql'), 'utf8');
  await client.query(sql);
}

export async function applySqlFiles(client, { fresh = false } = {}) {
  if (fresh) {
    await client.query('drop schema if exists public cascade;');
    await client.query('create schema public;');
    await client.query('drop schema if exists auth cascade;');
    await applySupabaseShim(client);
    await client.query('grant usage on schema public to anon, authenticated, service_role;');
  }
  for (const file of SQL_FILES) {
    const sql = await readFile(path.join(ROOT, 'database', file), 'utf8');
    await client.query(sql);
  }
  for (const file of await migrationFiles()) {
    const sql = await readFile(path.join(ROOT, 'database', 'migrations', file), 'utf8');
    await client.query(sql);
  }
  // grants inside policies.sql target tables that exist now
  await client.query('grant usage on schema public to anon, authenticated, service_role;');
}

export async function resetData(client) {
  await client.query(`
    truncate table
      public.order_events, public.orders, public.wallet_transactions, public.deposits,
      public.wallets, public.profiles, public.idempotency_keys, public.sessions,
      public.rate_limits, public.job_leases, public.supplier_webhook_events,
      public.admin_audit_logs, public.services, public.catalog_sync_runs
    restart identity cascade;
    delete from auth.users;
  `);
}

export async function createUser(client, email, { role = 'user', balance = 0 } = {}) {
  const id = randomUUID();
  await client.query('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())', [id, email]);
  await client.query('select public.ensure_user_profile($1, $2, null)', [id, email]);
  if (role === 'admin') {
    await client.query(`update public.profiles set role = 'admin' where id = $1`, [id]);
  }
  if (balance > 0) {
    await seedBalance(client, id, balance);
  }
  return id;
}

/** Seed a wallet with a ledger-consistent credit (test fixture, runs as owner). */
export async function seedBalance(client, userId, amount) {
  await client.query('insert into public.wallets (user_id) values ($1) on conflict (user_id) do nothing', [userId]);
  const { rows } = await client.query(
    'update public.wallets set balance = balance + $2 where user_id = $1 returning balance - $2 as before',
    [userId, amount]
  );
  const before = Number(rows[0].before);
  await client.query(
    `insert into public.wallet_transactions
       (user_id, type, direction, amount, balance_before, balance_after, reference_type, reference_id, description)
     values ($1, 'adjustment', 'credit', $2, $3, $4, 'adjustment', $5, 'test fixture credit')`,
    [userId, amount, before, before + amount, randomUUID()]
  );
}

export async function asRole(client, role, userId, fn) {
  // Session-scoped role switch instead of a transaction: a denied statement
  // aborts a transaction, which would mask the remaining assertions.
  await client.query(`set role ${role}`);
  if (userId) {
    await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  } else {
    await client.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
  try {
    return await fn();
  } finally {
    await client.query('reset role').catch(() => {});
    await client.query(`select set_config('request.jwt.claim.sub', '', false)`).catch(() => {});
  }
}

export const asUser = (client, userId, fn) => asRole(client, 'authenticated', userId, fn);
export const asAnon = (client, fn) => asRole(client, 'anon', null, fn);
export const asService = (client, fn) => asRole(client, 'service_role', null, fn);

/** Assert that a promise rejects with a specific P0001 message code. */
export async function expectDbError(fn, expectedCode) {
  try {
    await fn();
  } catch (err) {
    const message = String(err.message || '');
    if (!message.includes(expectedCode)) {
      const e = new Error(`expected DB error ${expectedCode}, got: ${message}`);
      e.original = err;
      throw e;
    }
    return err;
  }
  throw new Error(`expected DB error ${expectedCode}, but the call succeeded`);
}

export async function walletBalance(client, userId) {
  const { rows } = await client.query('select balance from public.wallets where user_id = $1', [userId]);
  return Number(rows[0]?.balance ?? 0);
}

export async function ledgerCount(client, userId) {
  const { rows } = await client.query('select count(*)::int as n from public.wallet_transactions where user_id = $1', [userId]);
  return rows[0].n;
}

/** Insert a service row directly (catalog sync is tested separately). */
export async function createService(client, overrides = {}) {
  const code = overrides.code || `wa-id-${randomUUID().slice(0, 8)}`;
  const { rows } = await client.query(
    `insert into public.services
       (code, name, provider_server, provider_app_id, app_name, country_id, country_name,
        country_iso, supplier_price, price, stock, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      code,
      overrides.name || 'WhatsApp Indonesia',
      overrides.provider_server || 'server1',
      overrides.provider_app_id || 'wa',
      overrides.app_name || 'WhatsApp',
      overrides.country_id ?? 6,
      overrides.country_name || 'Indonesia',
      overrides.country_iso || 'ID',
      overrides.supplier_price ?? 2000,
      overrides.price ?? 2300,
      overrides.stock ?? 100,
      overrides.is_active ?? true
    ]
  );
  return rows[0].id;
}

export async function createOrder(client, userId, serviceId, opts = {}) {
  const {
    key = `test-key-${randomUUID()}`,
    supplierPrice = 2000,
    markup = 300,
    tax = 0,
    total = supplierPrice + markup + tax,
    offerId = 'offer-test-1'
  } = opts;
  const { rows } = await client.query(
    `select public.rpc_create_order(
       p_user_id => $1, p_service_id => $2, p_idempotency_key => $3, p_request_hash => $4,
       p_supplier_price => $5, p_markup_amount => $6, p_tax_amount => $7, p_total_price => $8,
       p_provider => 'telekos', p_provider_server => 'server1', p_provider_app_id => 'wa',
       p_provider_app_name => 'WhatsApp', p_country_id => 6, p_country_name => 'Indonesia',
       p_country_iso => 'ID', p_provider_offer_id => $9, p_max_active_orders => 5
     ) as result`,
    [userId, serviceId, key, opts.hash || 'a'.repeat(64), supplierPrice, markup, tax, total, offerId]
  );
  return { result: rows[0].result, key };
}
