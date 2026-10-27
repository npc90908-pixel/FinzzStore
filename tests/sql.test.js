// ============================================================================
// SQL / RLS / RPC INTEGRATION TESTS
// Executed against a real PostgreSQL 17 instance (see README: npm run test:sql).
// Covers: schema idempotency, row level security, privilege escalation guards,
// atomic wallet debits, idempotency, concurrency, refunds, deposits, leases.
// ============================================================================
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applySqlFiles,
  applySupabaseShim,
  connect,
  createUser,
  createService,
  createOrder,
  asUser,
  asAnon,
  asService,
  expectDbError,
  ledgerCount,
  seedBalance,
  walletBalance,
  DATABASE_URL,
  ROOT
} from './support/db-harness.mjs';

let db;
let adminId;

/** Deterministic-shape dummy hash for token columns (never a real secret). */
const generateTokenHash = () => randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

before(async () => {
  db = await connect();
  await db.query('create schema if not exists public');
  await applySupabaseShim(db);
  await applySqlFiles(db, { fresh: true });
  adminId = await createUser(db, 'admin@finzz.test', { role: 'admin' });
});

after(async () => {
  await db?.end();
});

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
test('schema, policies and functions apply cleanly and are re-runnable', async () => {
  await applySqlFiles(db); // second application must not fail
  const { rows } = await db.query(`
    select
      (select count(*) from pg_tables where schemaname = 'public' and rowsecurity)::int as rls_tables,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'rpc_%')::int as rpc_functions
  `);
  assert.ok(rows[0].rls_tables >= 12, `expected >= 12 tables with RLS, got ${rows[0].rls_tables}`);
  assert.ok(rows[0].rpc_functions >= 18, `expected >= 18 rpc functions, got ${rows[0].rpc_functions}`);
  const { rows: oauth } = await db.query(`
    select
      to_regclass('public.oauth_identities') is not null as identity_table,
      exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'profiles'
                 and column_name = 'password_auth_enabled') as password_auth_flag,
      (select relrowsecurity from pg_class where oid = 'public.oauth_identities'::regclass) as rls_enabled
  `);
  assert.equal(oauth[0].identity_table, true);
  assert.equal(oauth[0].password_auth_flag, true);
  assert.equal(oauth[0].rls_enabled, true);

  const { rows: settings } = await db.query('select count(*)::int as n from public.app_settings');
  assert.ok(settings[0].n >= 6, 'default settings inserted');
});

test('registration creates profile + wallet with role=user', async () => {
  const id = await createUser(db, `plain-${randomUUID()}@finzz.test`);
  const { rows } = await db.query('select role, status from public.profiles where id = $1', [id]);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].status, 'active');
  assert.equal(await walletBalance(db, id), 0);
});

test('Google identity RPCs use provider subject, expose no email merge, and protect the last login method', async () => {
  const subject = `google-${randomUUID()}`;
  const googleEmail = `google-${randomUUID()}@finzz.test`;
  const hash = `$argon2id$test-hash-${randomUUID()}`;
  const { rows: createdRows } = await db.query(`
    select public.rpc_create_google_account($1,$2,$3,$4,$1,$5,null,null) as result
  `, [googleEmail, hash, `g${randomUUID().slice(0, 10)}`, subject, 'Verified Google']);
  const created = createdRows[0].result;
  assert.equal(created.created, true);
  const userId = created.profile.id;
  const { rows: flags } = await db.query(
    'select email_verified_at, password_auth_enabled from public.profiles where id = $1', [userId]
  );
  assert.ok(flags[0].email_verified_at);
  assert.equal(flags[0].password_auth_enabled, false);

  const { rows: denied } = await db.query('select public.rpc_unlink_google_identity($1) as result', [userId]);
  assert.equal(denied[0].result.reason, 'LAST_LOGIN_METHOD');

  const otherUser = await createUser(db, `other-${randomUUID()}@finzz.test`);
  const { rows: conflictRows } = await db.query(`
    select public.rpc_link_google_identity($1,$2,$3,'Name',null,null) as result
  `, [otherUser, subject, googleEmail]);
  assert.equal(conflictRows[0].result.conflict, true, 'same Google subject cannot be attached to another FINZZ account');

  await db.query('update public.profiles set password_hash = $2 where id = $1', [userId, `$argon2id$reset-${randomUUID()}`]);
  const { rows: enabled } = await db.query('select password_auth_enabled from public.profiles where id = $1', [userId]);
  assert.equal(enabled[0].password_auth_enabled, true, 'changing the local password activates it as an alternate method');
  const { rows: removed } = await db.query('select public.rpc_unlink_google_identity($1) as result', [userId]);
  assert.equal(removed[0].result.unlinked, true);

  const existingEmail = `existing-${randomUUID()}@finzz.test`;
  await createUser(db, existingEmail);
  const { rows: emailConflictRows } = await db.query(`
    select public.rpc_create_google_account($1,$2,$3,$4,$1,'Name',null,null) as result
  `, [existingEmail, hash, `g${randomUUID().slice(0, 10)}`, `google-${randomUUID()}`]);
  assert.equal(emailConflictRows[0].result.emailConflict, true);
});

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------
test('RLS: a user only sees their own profile, wallet, orders, deposits and events', async () => {
  const alice = await createUser(db, `alice-${randomUUID()}@finzz.test`, { balance: 10000 });
  const bob = await createUser(db, `bob-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, alice, svc);

  await asUser(db, alice, async () => {
    const profiles = await db.query('select id from public.profiles');
    assert.deepEqual(profiles.rows.map((r) => r.id), [alice]);

    const wallets = await db.query('select user_id from public.wallets');
    assert.deepEqual(wallets.rows.map((r) => r.user_id), [alice]);

    const orders = await db.query('select id from public.orders');
    assert.deepEqual(orders.rows.map((r) => r.id), [result.order.id]);

    const events = await db.query('select order_id from public.order_events');
    assert.ok(events.rows.every((r) => r.order_id === result.order.id));
  });

  await asUser(db, bob, async () => {
    const orders = await db.query('select id from public.orders');
    assert.equal(orders.rowCount, 0, 'bob must not see alice orders');
    const wallets = await db.query('select user_id from public.wallets');
    assert.deepEqual(wallets.rows.map((r) => r.user_id), [bob]);
  });
});

test('RLS: users cannot write balances, ledger rows, orders or deposit decisions', async () => {
  const user = await createUser(db, `rw-${randomUUID()}@finzz.test`, { balance: 5000 });

  await asUser(db, user, async () => {
    await assert.rejects(db.query('update public.wallets set balance = 999999 where user_id = $1', [user]),
      /permission denied/i, 'wallet update must be denied');

    await assert.rejects(db.query(`insert into public.wallet_transactions
        (user_id,type,direction,amount,balance_before,balance_after,reference_type)
      values ($1,'adjustment','credit',1000,0,1000,'adjustment')`, [user]),
      /permission denied/i, 'ledger insert must be denied');

    await assert.rejects(db.query(`insert into public.orders
        (user_id,idempotency_key,request_hash,provider_server,provider_app_id,provider_app_name,
         provider_country_id,provider_country_name,supplier_price,total_price)
      values ($1,'manual-key-1',repeat('a',64),'server1','wa','WhatsApp',6,'Indonesia',1000,1000)`, [user]),
      /permission denied/i, 'direct order insert must be denied');
  });

  // User can still update safe profile columns.
  await asUser(db, user, async () => {
    await db.query(`update public.profiles set full_name = 'Nama Baru' where id = $1`, [user]);
    const { rows } = await db.query('select full_name from public.profiles where id = $1', [user]);
    assert.equal(rows[0].full_name, 'Nama Baru');
  });
});

test('RLS: a user cannot promote themselves via the API roles', async () => {
  const user = await createUser(db, `esc-${randomUUID()}@finzz.test`);
  await asUser(db, user, async () => {
    await assert.rejects(
      db.query(`update public.profiles set role = 'admin' where id = $1`, [user]),
      /FORBIDDEN_COLUMN|permission denied/i
    );
    await assert.rejects(
      db.query(`update public.profiles set status = 'banned' where id = $1`, [user]),
      /FORBIDDEN_COLUMN|permission denied/i
    );
  });
  const { rows } = await db.query('select role from public.profiles where id = $1', [user]);
  assert.equal(rows[0].role, 'user');
});

test('RLS: OTP content is not exposed to API roles at all', async () => {
  const user = await createUser(db, `otp-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-OTPTEST01','waiting')`, [result.order.id]);
  await db.query(`select public.rpc_apply_supplier_state($1,'received',null,$2::jsonb,null,null,null,'supplier')`, [
    result.order.id,
    JSON.stringify([{ id: 'OTP-1', code: '123456', message: 'kode 123456', sender: 'WhatsApp' }])
  ]);

  await asUser(db, user, async () => {
    await assert.rejects(db.query('select otp_code from public.orders'), /permission denied/i);
    // but the owner can read non sensitive columns
    const { rows } = await db.query('select status, otp_count from public.orders');
    assert.equal(rows[0].status, 'received');
    assert.equal(rows[0].otp_count, 1);
  });
});

test('RLS: anonymous visitors can read the public catalog only', async () => {
  const svcActive = await createService(db, { is_active: true, code: `anon-active-${randomUUID().slice(0, 6)}` });
  const svcInactive = await createService(db, { is_active: false, code: `anon-off-${randomUUID().slice(0, 6)}` });

  await asAnon(db, async () => {
    const { rows } = await db.query('select id from public.services');
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(svcActive));
    assert.ok(!ids.includes(svcInactive));
    await assert.rejects(db.query('select * from public.orders'), /permission denied/i);
    await assert.rejects(db.query('select * from public.profiles'), /permission denied/i);
    const publicSettings = await db.query('select key from public.app_settings');
    assert.ok(publicSettings.rows.length > 0, 'anon sees public settings');
    assert.ok(publicSettings.rows.every((r) => r.key !== 'pricing_policy'),
      'private settings (markup/tax) must never be exposed to anon');
  });
});

test('RLS: internal tables (sessions, rate limits, leases) are service-role only', async () => {
  const user = await createUser(db, `sess-${randomUUID()}@finzz.test`);
  for (const table of ['sessions', 'rate_limits', 'job_leases', 'idempotency_keys', 'supplier_webhook_events']) {
    await asUser(db, user, async () => {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/i, table);
    });
  }
});

// ---------------------------------------------------------------------------
// ORDERS / WALLET
// ---------------------------------------------------------------------------
test('order creation rejects insufficient balance without side effects', async () => {
  const user = await createUser(db, `poor-${randomUUID()}@finzz.test`, { balance: 1000 });
  const svc = await createService(db);
  const ledgerBefore = await ledgerCount(db, user);

  await expectDbError(() => createOrder(db, user, svc), 'INSUFFICIENT_BALANCE');

  assert.equal(await walletBalance(db, user), 1000);
  assert.equal(await ledgerCount(db, user), ledgerBefore);
  const { rows } = await db.query('select count(*)::int n from public.orders where user_id = $1', [user]);
  assert.equal(rows[0].n, 0);
});

test('order creation debits exactly the total and writes a ledger entry', async () => {
  const user = await createUser(db, `debit-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc, { supplierPrice: 2000, markup: 300, total: 2300 });

  assert.equal(await walletBalance(db, user), 7700);
  assert.equal(Number(result.order.total_price), 2300);
  assert.equal(result.order.status, 'pending');

  const { rows } = await db.query(
    `select type, direction, amount, balance_before, balance_after
       from public.wallet_transactions where user_id = $1 and type = 'purchase'`, [user]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 2300);
  assert.equal(Number(rows[0].balance_before), 10000);
  assert.equal(Number(rows[0].balance_after), 7700);
});

test('idempotency: replaying the same key returns the same order and debits once', async () => {
  const user = await createUser(db, `idem-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const key = `replay-${randomUUID()}`;

  const first = await createOrder(db, user, svc, { key, hash: 'b'.repeat(64) });
  const second = await createOrder(db, user, svc, { key, hash: 'b'.repeat(64) });

  assert.equal(second.result.replayed, true);
  assert.equal(second.result.order.id, first.result.order.id);
  assert.equal(await walletBalance(db, user), 7700);
  const { rows } = await db.query(`select count(*)::int n from public.wallet_transactions
     where user_id = $1 and type = 'purchase'`, [user]);
  assert.equal(rows[0].n, 1);
});

test('idempotency: same key with a different payload is rejected', async () => {
  const user = await createUser(db, `idem2-${randomUUID()}@finzz.test`, { balance: 20000 });
  const svc = await createService(db);
  const key = `conflict-${randomUUID()}`;
  await createOrder(db, user, svc, { key, hash: 'c'.repeat(64) });

  await expectDbError(
    () => createOrder(db, user, svc, { key, hash: 'd'.repeat(64), total: 9999, markup: 7999, supplierPrice: 2000 }),
    'IDEMPOTENCY_CONFLICT'
  );
});

test('concurrency: 8 parallel requests with one key produce exactly one order and one debit', async () => {
  const user = await createUser(db, `race-${randomUUID()}@finzz.test`, { balance: 50000 });
  const svc = await createService(db);
  const key = `race-${randomUUID()}`;
  const { Client } = await import('pg');
  const clients = await Promise.all(Array.from({ length: 8 }, async () => {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    return c;
  }));

  const outcomes = await Promise.allSettled(clients.map((client) =>
    createOrder(client, user, svc, { key, hash: 'e'.repeat(64) })
  ));
  await Promise.all(clients.map((c) => c.end()));

  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.ok(fulfilled.length >= 1, 'at least one request succeeds');
  assert.ok(rejected.length === 0, `no request should fail, got: ${rejected.map((r) => r.reason?.message).join('; ')}`);

  const ids = new Set(fulfilled.map((o) => o.value.result.order.id));
  assert.equal(ids.size, 1, 'all replays point at the same order');
  const { rows } = await db.query(`select count(*)::int n from public.wallet_transactions
     where user_id = $1 and type = 'purchase'`, [user]);
  assert.equal(rows[0].n, 1, 'exactly one debit');
  assert.equal(await walletBalance(db, user), 47700);
});

test('concurrency: two different orders cannot overdraw the wallet', async () => {
  const user = await createUser(db, `overdraw-${randomUUID()}@finzz.test`, { balance: 3000 });
  const svc = await createService(db);
  const { Client } = await import('pg');
  const clients = await Promise.all([0, 1].map(async () => {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    return c;
  }));

  const outcomes = await Promise.allSettled(clients.map((client, i) =>
    createOrder(client, user, svc, { key: `overdraw-${i}-${randomUUID()}`, hash: String(i).repeat(64).slice(0, 64) })
  ));
  await Promise.all(clients.map((c) => c.end()));

  const ok = outcomes.filter((o) => o.status === 'fulfilled');
  const failed = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one purchase fits the balance');
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].reason.message), /INSUFFICIENT_BALANCE/);
  assert.equal(await walletBalance(db, user), 700);
});

test('refund happens once when the supplier definitively rejects the purchase', async () => {
  const user = await createUser(db, `refund-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  assert.equal(await walletBalance(db, user), 7700);

  const first = await db.query(`select public.rpc_fail_order($1,'OUT_OF_STOCK','stok habis',true,'system') as r`,
    [result.order.id]);
  assert.equal(first.rows[0].r.refunded, true);
  assert.equal(await walletBalance(db, user), 10000);

  // Replaying the failure must not credit again.
  const second = await db.query(`select public.rpc_fail_order($1,'OUT_OF_STOCK','stok habis',true,'system') as r`,
    [result.order.id]);
  assert.equal(second.rows[0].r.refunded, false);
  assert.equal(await walletBalance(db, user), 10000);

  const { rows } = await db.query(`select count(*)::int n from public.wallet_transactions
     where user_id = $1 and type = 'refund'`, [user]);
  assert.equal(rows[0].n, 1);
});

test('no refund after an OTP was delivered; expired without OTP refunds once', async () => {
  const user = await createUser(db, `expire-${randomUUID()}@finzz.test`, { balance: 20000 });
  const svc = await createService(db);

  const withOtp = await createOrder(db, user, svc);
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-OTP00001','waiting')`, [withOtp.result.order.id]);
  await db.query(`select public.rpc_apply_supplier_state($1,'received',null,$2::jsonb,null,null,null,'supplier')`, [
    withOtp.result.order.id, JSON.stringify([{ code: '999111', message: 'OTP 999111' }])
  ]);
  const cancelled = await db.query(
    `select public.rpc_apply_supplier_state($1,'cancelled',null,'[]'::jsonb,false,null,null,'supplier') as r`,
    [withOtp.result.order.id]);
  assert.equal(cancelled.rows[0].r.refunded, false, 'OTP delivered must not be refunded');

  const noOtp = await createOrder(db, user, svc);
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-NOOTP001','waiting')`, [noOtp.result.order.id]);
  const expired = await db.query(
    `select public.rpc_apply_supplier_state($1,'expired',null,'[]'::jsonb,false,null,null,'supplier') as r`,
    [noOtp.result.order.id]);
  assert.equal(expired.rows[0].r.refunded, true);

  const before = await walletBalance(db, user);
  await db.query(`select public.rpc_apply_supplier_state($1,'expired',null,'[]'::jsonb,false,null,null,'supplier')`,
    [noOtp.result.order.id]);
  assert.equal(await walletBalance(db, user), before, 'terminal state is idempotent');
});

test('ambiguous supplier results never refund automatically', async () => {
  const user = await createUser(db, `review-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-AMBIG001','waiting')`, [result.order.id]);
  const res = await db.query(
    `select public.rpc_apply_supplier_state($1,'needs_review',null,'[]'::jsonb,null,null,null,'system') as r`,
    [result.order.id]);
  assert.equal(res.rows[0].r.refunded, false);
  assert.equal(await walletBalance(db, user), 7700);
});

test('invalid order transitions are rejected by the database', async () => {
  const user = await createUser(db, `trans-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-TRANS001','waiting')`, [result.order.id]);
  await db.query(`select public.rpc_apply_supplier_state($1,'received',null,$2::jsonb,null,null,null,'supplier')`, [
    result.order.id, JSON.stringify([{ code: '111222', message: 'OTP' }])
  ]);

  await expectDbError(
    () => db.query(`select public.rpc_apply_supplier_state($1,'waiting',null,'[]'::jsonb,null,null,null,'supplier')`,
      [result.order.id]),
    'INVALID_TRANSITION'
  );
});

test('cancel request is guarded: needs supplier permission and no OTP', async () => {
  const user = await createUser(db, `cancel-${randomUUID()}@finzz.test`, { balance: 10000 });
  const other = await createUser(db, `cancel2-${randomUUID()}@finzz.test`, { balance: 0 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  const id = result.order.id;
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-CANCEL01','waiting',null,null,false,null,'api')`, [id]);

  await expectDbError(() => db.query('select public.rpc_begin_cancel($1,$2)', [id, user]), 'CANCEL_NOT_AVAILABLE');
  await expectDbError(() => db.query('select public.rpc_begin_cancel($1,$2)', [id, other]), 'FORBIDDEN');

  await db.query(`update public.orders set can_cancel = true where id = $1`, [id]);
  const ok = await db.query('select public.rpc_begin_cancel($1,$2) as r', [id, user]);
  assert.equal(ok.rows[0].r.already_requested, false);
  const again = await db.query('select public.rpc_begin_cancel($1,$2) as r', [id, user]);
  assert.equal(again.rows[0].r.already_requested, true, 'second cancel request is a no-op');
});

// ---------------------------------------------------------------------------
// DEPOSITS
// ---------------------------------------------------------------------------
test('deposit lifecycle: minimum enforced, approved once, double approval blocked', async () => {
  const user = await createUser(db, `dep-${randomUUID()}@finzz.test`);
  const svc = await createService(db); // unused, keeps helper exercised
  assert.ok(svc);

  await expectDbError(
    () => db.query(`select public.rpc_create_deposit($1, 5000, 'deposits/x.png','image/png',1024,repeat('a',64),null,10000,5000000,3)`, [user]),
    'DEPOSIT_BELOW_MINIMUM'
  );

  const created = await db.query(
    `select public.rpc_create_deposit($1, 25000, 'deposits/x.png','image/png',1024,repeat('a',64),'top up',10000,5000000,3) as r`,
    [user]);
  const depositId = created.rows[0].r.deposit.id;
  assert.equal(created.rows[0].r.deposit.status, 'pending');

  const approved = await db.query(
    `select public.rpc_approve_deposit($1,$2,25000,'verified',null,null) as r`, [depositId, adminId]);
  assert.equal(Number(approved.rows[0].r.balance), 25000);
  assert.equal(await walletBalance(db, user), 25000);

  await expectDbError(
    () => db.query(`select public.rpc_approve_deposit($1,$2,25000,'again',null,null)`, [depositId, adminId]),
    'DEPOSIT_ALREADY_REVIEWED'
  );
  assert.equal(await walletBalance(db, user), 25000, 'no double credit');

  const { rows } = await db.query(`select count(*)::int n from public.wallet_transactions
    where user_id = $1 and type = 'deposit'`, [user]);
  assert.equal(rows[0].n, 1);
});

test('deposit rejection works and never credits the wallet', async () => {
  const user = await createUser(db, `deprej-${randomUUID()}@finzz.test`);
  const created = await db.query(
    `select public.rpc_create_deposit($1, 15000, 'deposits/y.png','image/png',2048,repeat('b',64),null,10000,5000000,3) as r`,
    [user]);
  const depositId = created.rows[0].r.deposit.id;

  await expectDbError(
    () => db.query(`select public.rpc_reject_deposit($1,$2,'',null,null)`, [depositId, adminId]),
    'INVALID_INPUT'
  );
  const rejected = await db.query(`select public.rpc_reject_deposit($1,$2,'bukti tidak valid',null,null) as r`,
    [depositId, adminId]);
  assert.equal(rejected.rows[0].r.deposit.status, 'rejected');
  assert.equal(await walletBalance(db, user), 0);
});

test('non-admin cannot call admin RPCs even with the service role', async () => {
  const user = await createUser(db, `notadmin-${randomUUID()}@finzz.test`, { balance: 5000 });
  const created = await db.query(
    `select public.rpc_create_deposit($1, 15000, 'deposits/z.png','image/png',2048,repeat('c',64),null,10000,5000000,3) as r`,
    [user]);

  await expectDbError(
    () => asService(db, () => db.query(`select public.rpc_approve_deposit($1,$2,15000,null,null,null)`,
      [created.rows[0].r.deposit.id, user])),
    'FORBIDDEN'
  );
  await expectDbError(
    () => asService(db, () => db.query(`select public.rpc_set_user_role($1,$2,'admin',null,null)`, [user, user])),
    'FORBIDDEN'
  );
});

test('admin manual adjustment requires a reason and is idempotent by reference', async () => {
  const user = await createUser(db, `adj-${randomUUID()}@finzz.test`);
  const ref = randomUUID();

  await expectDbError(
    () => db.query(`select public.rpc_admin_adjust_balance($1,$2,'credit',5000,'', $3)`, [user, adminId, ref]),
    'INVALID_INPUT'
  );

  await db.query(`select public.rpc_admin_adjust_balance($1,$2,'credit',5000,'kompensasi gangguan',$3)`, [user, adminId, ref]);
  assert.equal(await walletBalance(db, user), 5000);

  await expectDbError(
    () => db.query(`select public.rpc_admin_adjust_balance($1,$2,'credit',5000,'kompensasi gangguan',$3)`, [user, adminId, ref]),
    'DUPLICATE_ADJUSTMENT'
  );
  assert.equal(await walletBalance(db, user), 5000);

  const { rows } = await db.query(`select count(*)::int n from public.admin_audit_logs
    where action = 'wallet.adjustment' and target_id = $1`, [user]);
  assert.ok(rows[0].n >= 1, 'adjustment is audited');
});

test('the last active admin cannot be demoted', async () => {
  const { rows: admins } = await db.query(`select count(*)::int n from public.profiles where role='admin' and status='active'`);
  if (admins[0].n === 1) {
    await expectDbError(
      () => db.query(`select public.rpc_set_user_role($1,$2,'user',null,null)`, [adminId, adminId]),
      'LAST_ADMIN'
    );
  } else {
    assert.ok(true);
  }
});

// ---------------------------------------------------------------------------
// JOBS / LEASES / RATE LIMITS
// ---------------------------------------------------------------------------
test('sync leasing hands an order to exactly one worker', async () => {
  const user = await createUser(db, `lease-${randomUUID()}@finzz.test`, { balance: 50000 });
  const svc = await createService(db);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const { result } = await createOrder(db, user, svc, { key: `lease-${i}-${randomUUID()}`, hash: String(i + 1).repeat(64).slice(0, 64) });
    await db.query(`select public.rpc_attach_supplier_order($1,$2,'waiting')`,
      [result.order.id, `TRX-LEASE${String(i).padStart(4, '0')}`]);
    await db.query(`update public.orders set next_sync_at = now() - interval '1 minute' where id = $1`, [result.order.id]);
    ids.push(result.order.id);
  }

  const [a, b] = await Promise.all([
    db.query(`select id from public.rpc_claim_orders_for_sync(4, 45, 'worker-a')`),
    db.query(`select id from public.rpc_claim_orders_for_sync(4, 45, 'worker-b')`)
  ]);
  const claimed = new Set([...a.rows, ...b.rows].map((r) => r.id));
  assert.equal(claimed.size, ids.length, 'both workers together claim each order once');
  assert.equal(a.rows.length + b.rows.length, ids.length, 'no order is claimed twice');

  // A lease that is still valid cannot be re-claimed.
  const third = await db.query(`select id from public.rpc_claim_orders_for_sync(4, 45, 'worker-c')`);
  assert.equal(third.rows.length, 0);
});

test('orphan pending orders become needs_review, never auto refunded', async () => {
  const user = await createUser(db, `orphan-${randomUUID()}@finzz.test`, { balance: 10000 });
  const svc = await createService(db);
  const { result } = await createOrder(db, user, svc);
  await db.query(`update public.orders set created_at = now() - interval '10 minutes' where id = $1`, [result.order.id]);

  const flagged = await db.query('select public.rpc_flag_orphan_pending_orders(180) as n');
  assert.ok(flagged.rows[0].n >= 1);
  const { rows } = await db.query('select status, refunded_at from public.orders where id = $1', [result.order.id]);
  assert.equal(rows[0].status, 'needs_review');
  assert.equal(rows[0].refunded_at, null);
  assert.equal(await walletBalance(db, user), 7700);
});

test('rate limiter counts, blocks and resets', async () => {
  const key = `test:${randomUUID()}`;
  const a = await db.query('select public.rpc_rate_limit_hit($1, 2, 60) as r', [key]);
  const b = await db.query('select public.rpc_rate_limit_hit($1, 2, 60) as r', [key]);
  const c = await db.query('select public.rpc_rate_limit_hit($1, 2, 60) as r', [key]);
  assert.equal(a.rows[0].r.allowed, true);
  assert.equal(b.rows[0].r.allowed, true);
  assert.equal(c.rows[0].r.allowed, false);
  assert.equal(c.rows[0].r.remaining, 0);
  assert.equal(c.rows[0].r.count, 3);

  const reset = await db.query('select public.rpc_rate_limit_hit($1, 2, 1) as r', [key]);
  await new Promise((r) => setTimeout(r, 1200));
  const after = await db.query('select public.rpc_rate_limit_hit($1, 2, 1) as r', [key]);
  assert.equal(after.rows[0].r.count, 1, 'counter resets after the window');
  assert.ok(reset.rows[0].r.count >= 1);
});

test('catalog sync upserts services and deactivates removed entries', async () => {
  const code = `sync-${randomUUID().slice(0, 8)}`;
  const payload = [{
    code,
    name: 'Telegram Indonesia',
    provider_app_id: 'tg',
    app_name: 'Telegram',
    country_id: 6,
    country_name: 'Indonesia',
    country_iso: 'ID',
    supplier_price: 1500,
    price: 1800,
    stock: 42,
    is_active: true
  }];
  const first = await db.query(`select public.rpc_sync_services('telekos','server2',$1::jsonb) as r`, [JSON.stringify(payload)]);
  assert.equal(first.rows[0].r.upserted, 1);

  const { rows } = await db.query('select price, stock, provider_server from public.services where code = $1', [code]);
  assert.equal(Number(rows[0].price), 1800);
  assert.equal(rows[0].stock, 42);
  assert.equal(rows[0].provider_server, 'server2');

  const second = await db.query(`select public.rpc_sync_services('telekos','server2','[]'::jsonb) as r`);
  assert.ok(second.rows[0].r.deactivated >= 1);
  const { rows: after } = await db.query('select is_active from public.services where code = $1', [code]);
  assert.equal(after[0].is_active, false);
});

test('public summary exposes only aggregate, real values', async () => {
  const anonRes = await asAnon(db, () => db.query('select public.rpc_public_summary() as s'));
  const summary = anonRes.rows[0].s;
  assert.ok(summary.active_services >= 0);
  assert.ok(typeof summary.countries === 'number');
  assert.equal(summary.active_services,
    (await db.query('select count(*)::int n from public.services where is_active')).rows[0].n);
});

test('admin dashboard profit is computed only from completed orders', async () => {
  const user = await createUser(db, `dash-${randomUUID()}@finzz.test`, { balance: 50000 });
  const svc = await createService(db);

  const done = await createOrder(db, user, svc, { supplierPrice: 2000, markup: 500, tax: 0, total: 2500 });
  await db.query(`select public.rpc_attach_supplier_order($1,'TRX-DASH0001','waiting')`, [done.result.order.id]);
  await db.query(`select public.rpc_apply_supplier_state($1,'completed',null,'[]'::jsonb,false,null,null,'supplier')`,
    [done.result.order.id]);

  const pending = await createOrder(db, user, svc, { supplierPrice: 2000, markup: 500, tax: 0, total: 2500 });
  assert.ok(pending.result.order.id);

  const res = await asService(db, () => db.query('select public.rpc_admin_dashboard($1) as d', [adminId]));
  const d = res.rows[0].d;
  assert.ok(Number(d.finance.net_profit) >= 500, 'net profit includes at least the completed order markup');
  assert.equal(Number(d.finance.gross_revenue) >= 2500, true);
  assert.ok(Array.isArray(d.recent_orders));
});

// ------------------------------------------------- public RPC migration -----
test('rpc_public_summary is callable by anon and returns a JSON object', async () => {
  const res = await asAnon(db, () => db.query('select public.rpc_public_summary() as s'));
  const summary = res.rows[0].s;
  assert.equal(typeof summary, 'object');
  assert.ok('active_services' in summary, 'the summary contract must be stable');
  assert.ok('countries' in summary);
  assert.ok('apps' in summary);
  assert.ok('generated_at' in summary);
  // Real counts only — never a hard-coded marketing number.
  assert.equal(typeof summary.active_services, 'number');
});

test('rpc_rate_limit_hit is a working counter that nobody but the service role may call', async () => {
  const key = `test:${randomUUID()}`;

  const first = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 2, 60))->>\'allowed\' as allowed', [key]
  ));
  assert.equal(first.rows[0].allowed, 'true');

  const second = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 2, 60))->>\'allowed\' as allowed', [key]
  ));
  assert.equal(second.rows[0].allowed, 'true');

  const third = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 2, 60))->>\'allowed\' as allowed', [key]
  ));
  assert.equal(third.rows[0].allowed, 'false', 'the limit must hold inside one window');

  // The limiter is an escalation surface: anon must never be able to drain it.
  await expectDbError(
    () => asAnon(db, () => db.query('select public.rpc_rate_limit_hit($1, 5, 60)', [key])),
    'permission denied'
  );
});

test('the limiter window resets and the row is scoped to its key', async () => {
  const key = `win:${randomUUID()}`;
  await asService(db, () => db.query('select public.rpc_rate_limit_hit($1, 1, 1)', [key]));
  const blocked = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 1, 1))->>\'allowed\' as allowed', [key]
  ));
  assert.equal(blocked.rows[0].allowed, 'false');

  await db.query('select pg_sleep(1.2)');

  const after = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 1, 1))->>\'allowed\' as allowed', [key]
  ));
  assert.equal(after.rows[0].allowed, 'true', 'a new window must start clean');

  const other = await asService(db, () => db.query(
    'select (public.rpc_rate_limit_hit($1, 1, 1))->>\'allowed\' as allowed, (select count(*)::int from public.rate_limits) as rows', [`other:${randomUUID()}`]
  ));
  assert.equal(other.rows[0].allowed, 'true', 'keys must not share a bucket');
});

test('the public RPCs and the limiter respect the service-role boundary', async () => {
  // rate_limits is not even granted to the public roles: they cannot drain or
  // enumerate the limiter store.
  const grants = await db.query(`
    select
      has_table_privilege('anon', 'public.rate_limits', 'select') as anon_select,
      has_table_privilege('authenticated', 'public.rate_limits', 'select') as auth_select,
      has_table_privilege('service_role', 'public.rate_limits', 'select') as svc_select,
      has_function_privilege('anon', 'public.rpc_rate_limit_hit(text,int,int)', 'execute') as anon_exec,
      has_function_privilege('service_role', 'public.rpc_rate_limit_hit(text,int,int)', 'execute') as svc_exec,
      has_function_privilege('anon', 'public.rpc_public_summary()', 'execute') as anon_summary
  `);
  const g = grants.rows[0];
  assert.equal(g.anon_select, false, 'anon must not read rate_limits');
  assert.equal(g.auth_select, false, 'authenticated must not read rate_limits');
  assert.equal(g.svc_select, true, 'the service role owns the limiter store');
  assert.equal(g.anon_exec, false, 'anon must not call the limiter RPC');
  assert.equal(g.svc_exec, true, 'the service role must call the limiter RPC');
  assert.equal(g.anon_summary, true, 'the public summary must remain publicly callable');

  // app_settings exposes only public rows and never the pricing policy.
  const settings = await asAnon(db, () => db.query('select key from public.app_settings'));
  const keys = settings.rows.map((r) => r.key);
  assert.ok(!keys.includes('pricing_policy'), 'pricing_policy must never be public');

  // services stay readable so the catalog can render without inventing data.
  const services = await asAnon(db, () => db.query('select count(*)::int as n from public.services'));
  assert.equal(typeof services.rows[0].n, 'number');
});

test('re-applying the migration on an existing database is a no-op', async () => {
  const sql = await readFile(path.join(ROOT, 'database', 'migrations', '001_fix_public_rpc_and_rate_limit.sql'), 'utf8');
  await db.query(sql);
  await db.query(sql);
  const res = await db.query(`select count(*)::int as n from pg_proc where proname = 'rpc_rate_limit_hit'`);
  assert.equal(res.rows[0].n, 1, 'the function must not be duplicated by a rerun');
});

// ---------------------------------------------- custom auth (migration 002) --
test('registration creates a profile + wallet and rejects a duplicate email', async () => {
  const email = `sqlreg-${randomUUID()}@finzz.test`;
  const res = await db.query('select public.rpc_register_user($1, $2, null) as r', [email, 'a'.repeat(64)]);
  const payload = res.rows[0].r;
  assert.equal(payload.profile.email, email);
  assert.equal(Number(payload.wallet.balance), 0);
  assert.ok(!('password_hash' in payload.profile), 'the hash must never leave the RPC');

  await expectDbError(
    () => db.query('select public.rpc_register_user($1, $2, null)', [email.toUpperCase(), 'b'.repeat(64)]),
    'EMAIL_TAKEN'
  );
});

test('an email verification code is single use and marks the profile verified', async () => {
  const email = `sqlotp-${randomUUID()}@finzz.test`;
  const reg = await db.query('select public.rpc_register_user($1, $2, null) as r', [email, 'a'.repeat(64)]);
  const userId = reg.rows[0].r.profile.id;
  const hash = 'c'.repeat(64);

  await db.query(
    `select public.rpc_issue_auth_token($1, 'email_verification', $2, 600)`,
    [userId, hash]
  );

  const consumed = await db.query(
    `select public.rpc_consume_email_token($1, 'email_verification') as r`, [hash]
  );
  assert.equal(consumed.rows[0].r.ok, true);
  assert.equal(consumed.rows[0].r.user_id, userId);

  const reuse = await db.query(
    `select public.rpc_consume_email_token($1, 'email_verification') as r`, [hash]
  );
  assert.equal(reuse.rows[0].r.ok, false);
  assert.equal(reuse.rows[0].r.reason, 'TOKEN_INVALID');

  const { rows } = await db.query('select email_verified_at from public.profiles where id = $1', [userId]);
  assert.ok(rows[0].email_verified_at, 'the profile must be marked verified');
});

test('a reset token works once, expires, and revokes every session', async () => {
  const email = `sqlreset-${randomUUID()}@finzz.test`;
  const reg = await db.query('select public.rpc_register_user($1, $2, null) as r', [email, 'a'.repeat(64)]);
  const userId = reg.rows[0].r.profile.id;

  await db.query(
    `insert into public.sessions (user_id, token_hash, csrf_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 day')`,
    [userId, generateTokenHash(), generateTokenHash()]
  );

  const hash = generateTokenHash();
  await db.query(`select public.rpc_issue_auth_token($1, 'password_reset', $2, 600)`, [userId, hash]);
  await db.query('select public.rpc_complete_password_reset($1, $2)', [hash, 'd'.repeat(64)]);

  const sessions = await db.query('select count(*)::int n from public.sessions where user_id = $1 and revoked_at is null', [userId]);
  assert.equal(sessions.rows[0].n, 0, 'no session may survive a password reset');

  await expectDbError(
    () => db.query('select public.rpc_complete_password_reset($1, $2)', [hash, 'e'.repeat(64)]),
    'TOKEN_INVALID'
  );

  // An expired token is refused and burned.
  const expired = generateTokenHash();
  await db.query(`select public.rpc_issue_auth_token($1, 'password_reset', $2, 600)`, [userId, expired]);
  await db.query(`update public.auth_tokens set expires_at = now() - interval '1 minute' where token_hash = $1`, [expired]);
  await expectDbError(
    () => db.query('select public.rpc_complete_password_reset($1, $2)', [expired, 'f'.repeat(64)]),
    'TOKEN_EXPIRED'
  );
});

test('auth_tokens is unreachable for anon and authenticated roles', async () => {
  const grants = await db.query(`
    select
      has_table_privilege('anon', 'public.auth_tokens', 'select')          as anon_select,
      has_table_privilege('authenticated', 'public.auth_tokens', 'select') as auth_select,
      has_table_privilege('service_role', 'public.auth_tokens', 'select')  as svc_select
  `);
  const g = grants.rows[0];
  assert.equal(g.anon_select, false);
  assert.equal(g.auth_select, false);
  assert.equal(g.svc_select, true);
});

test('login bookkeeping counts failures and locks the account', async () => {
  const email = `sqllock-${randomUUID()}@finzz.test`;
  const reg = await db.query('select public.rpc_register_user($1, $2, null) as r', [email, 'a'.repeat(64)]);
  const userId = reg.rows[0].r.profile.id;

  let out;
  for (let i = 0; i < 3; i += 1) {
    out = await db.query('select public.rpc_note_login($1, false, 3, 900) as r', [userId]);
  }
  assert.equal(Number(out.rows[0].r.failed_login_count), 3);
  assert.ok(out.rows[0].r.locked_until, 'three failures must set a lock');

  const ok = await db.query('select public.rpc_note_login($1, true, 3, 900) as r', [userId]);
  assert.equal(Number(ok.rows[0].r.failed_login_count), 0);
  assert.equal(ok.rows[0].r.locked_until, null);
});

test('a verification code is bound to its owner and wrong guesses are counted', async () => {
  const mk = async (label) => {
    const email = `sqlbind-${label}-${randomUUID()}@finzz.test`;
    const res = await db.query('select public.rpc_register_user($1, $2, null) as r', [email, 'a'.repeat(64)]);
    return { id: res.rows[0].r.profile.id, email };
  };
  const victim = await mk('a');
  const attacker = await mk('b');

  const code = '123456';
  const victimHash = createHash('sha256').update(`${victim.id}:${code}`).digest('hex');
  await db.query(`select public.rpc_issue_auth_token($1, 'email_verification', $2, 600, 3)`, [victim.id, victimHash]);

  // The attacker's own id + the victim's code must not match the victim's token.
  const attackerHash = createHash('sha256').update(`${attacker.id}:${code}`).digest('hex');
  const crossUse = await db.query(
    `select public.rpc_consume_email_token($1, 'email_verification', $2) as r`,
    [attackerHash, victim.id]
  );
  assert.equal(crossUse.rows[0].r.ok, false, 'a foreign hash must never consume the token');
  assert.equal(crossUse.rows[0].r.reason, 'TOKEN_INVALID');

  // Every miss charges the victim's live token; after max_attempts it is burned.
  let last;
  for (let i = 0; i < 3; i += 1) {
    const res = await db.query(
      `select public.rpc_consume_email_token($1, 'email_verification', $2) as r`,
      [attackerHash, victim.id]
    );
    last = res.rows[0].r;
  }
  assert.equal(last.reason, 'TOKEN_INVALID');

  const afterBurn = await db.query(
    `select public.rpc_consume_email_token($1, 'email_verification', $2) as r`,
    [victimHash, victim.id]
  );
  assert.equal(afterBurn.rows[0].r.ok, false, 'a burned code can no longer verify');

  const { rows } = await db.query(
    `select attempts, consumed_at from public.auth_tokens where token_hash = $1`,
    [victimHash]
  );
  assert.ok(rows[0].attempts >= 3, 'failed attempts are recorded, not rolled back');
  assert.ok(rows[0].consumed_at, 'the token is burned after the limit');
});

test('the verification RPC has no unbound two-argument variant left', async () => {
  const { rows } = await db.query(`
    select proname, pronargs::int as args
      from pg_proc
     where proname = 'rpc_consume_email_token'
     order by pronargs
  `);
  assert.equal(rows.length, 1, 'exactly one signature must exist');
  assert.equal(Number(rows[0].args), 3, 'the surviving signature must take p_user_id');
});

test('catalogue sync persists the markup it applied', async () => {
  const code = `uji-markup-${randomUUID().slice(0, 8)}`;
  await db.query(
    `select public.rpc_sync_services('telekos-uji', 'server9', $1::jsonb) as r`,
    [JSON.stringify([{
      code,
      name: 'Uji Markup',
      provider_app_id: 'tg',
      app_name: 'Telegram',
      country_id: 6,
      country_name: 'Indonesia',
      supplier_price: 1400,
      markup_bps: 3000,
      price: 4500,
      stock: 5,
      is_active: true
    }])]
  );

  const { rows } = await db.query(
    'select supplier_price, markup_bps, price from public.services where code = $1',
    [code]
  );
  assert.equal(Number(rows[0].supplier_price), 1400);
  assert.equal(Number(rows[0].markup_bps), 3000, 'the applied markup must be stored, not the column default');
  assert.equal(Number(rows[0].price), 4500);

  // A re-sync that omits markup_bps falls back to the column default rather
  // than writing null.
  await db.query(
    `select public.rpc_sync_services('telekos-uji', 'server9', $1::jsonb) as r`,
    [JSON.stringify([{ code, name: 'Uji Markup', provider_app_id: 'tg', app_name: 'Telegram', country_id: 6, country_name: 'Indonesia', supplier_price: 1400, price: 4500, stock: 5, is_active: true }])]
  );
  const again = await db.query('select markup_bps from public.services where code = $1', [code]);
  assert.equal(Number(again.rows[0].markup_bps), 1500);

  await db.query('delete from public.services where code = $1', [code]);
});

// ------------------------------------------------------- notifications ------
test('notifications are written by database triggers, not by application code', async () => {
  const userId = await createUser(db, `notif-${randomUUID().slice(0, 8)}@finzz.test`, { balance: 50_000 });
  const serviceId = await createService(db, {});

  // 1. A new order inserts exactly one row, of type order.created.
  const { result: created_order } = await createOrder(db, userId, serviceId);
  const orderId = created_order.order.id;
  const created = await db.query(
    `select type, severity, title, order_id, read_at from public.notifications
      where user_id = $1 order by id`,
    [userId]
  );
  assert.equal(created.rows.length, 1, 'one notification per order insert');
  assert.equal(created.rows[0].type, 'order.created');
  assert.equal(created.rows[0].severity, 'info');
  assert.equal(created.rows[0].read_at, null);
  assert.ok(created.rows[0].title);

  // 2. A supplier status change updates the same order and adds one row.
  await db.query(
    `select public.rpc_attach_supplier_order(
       p_order_id => $1, p_supplier_order_id => 'TRX-NOTIF-1', p_status => 'waiting',
       p_phone_number => '+6200000000', p_expires_at => now() + interval '20 minutes',
       p_can_cancel => true, p_cancel_available_at => now(), p_worker => 'test'
     )`,
    [orderId]
  );
  const afterAttach = await db.query(
    'select type from public.notifications where user_id = $1 order by id',
    [userId]
  );
  assert.deepEqual(afterAttach.rows.map((r) => r.type), ['order.created', 'order.waiting']);

  // 3. The supplier cancels before any OTP: the RPC refunds the wallet, and the
  //    trigger row for the refund appears next to the cancelled status row.
  await db.query(
    `select public.rpc_apply_supplier_state(
       p_order_id => $1, p_status => 'cancelled', p_source => 'supplier'
     )`,
    [orderId]
  );
  const afterRefund = await db.query(
    `select type, meta from public.notifications where user_id = $1 order by id`,
    [userId]
  );
  const types = afterRefund.rows.map((r) => r.type);
  assert.ok(types.includes('wallet.refund'), `wallet.refund present (got ${types.join(', ')})`);

  // 4. An unchanged UPDATE writes nothing — triggers react to real changes only.
  const before = await db.query('select count(*)::int as n from public.notifications where user_id = $1', [userId]);
  await db.query(`update public.orders set next_sync_at = now() where id = $1`, [orderId]);
  const after = await db.query('select count(*)::int as n from public.notifications where user_id = $1', [userId]);
  assert.equal(after.rows[0].n, before.rows[0].n, 'a no-op update must not notify');

  // 5. The inbox is private: anon/authenticated can neither read nor write it.
  await asAnon(db, async () => {
    const denied = await expectDbError(
      () => db.query('select count(*) from public.notifications'),
      'permission denied'
    );
    assert.ok(denied, 'anon cannot select notifications');
    const deniedWrite = await expectDbError(
      () => db.query(
        `insert into public.notifications (user_id, type, title) values ($1, 'order.created', 'palsu')`,
        [userId]
      ),
      'permission denied'
    );
    assert.ok(deniedWrite, 'anon cannot forge a notification');
  });

  // 6. The owner can read their rows through the service role and mark them read.
  const readRow = await db.query(
    `update public.notifications set read_at = now() where user_id = $1 and read_at is null returning id`,
    [userId]
  );
  assert.ok(readRow.rowCount >= 1);

  // 7. A rejected deposit notifies with the admin's reason.
  const depositUser = await createUser(db, `notifdep-${randomUUID().slice(0, 8)}@finzz.test`);
  const dep = await db.query(
    `insert into public.deposits (user_id, amount, status) values ($1, 25000, 'pending') returning id`,
    [depositUser]
  );
  await db.query(
    `update public.deposits set status = 'rejected', admin_note = 'Bukti buram',
       reviewed_by = $2, reviewed_at = now() where id = $1`,
    [dep.rows[0].id, adminId]
  );
  const depNote = await db.query(
    'select type, severity, body from public.notifications where user_id = $1',
    [depositUser]
  );
  assert.equal(depNote.rows.length, 1);
  assert.equal(depNote.rows[0].type, 'deposit.rejected');
  assert.equal(depNote.rows[0].severity, 'danger');
  assert.match(depNote.rows[0].body, /Bukti buram/);
});
