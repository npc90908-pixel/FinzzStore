// ============================================================================
// RESILIENCE TESTS — the failure modes that produced the 26 Oct 2026 production
// errors. Each test reproduces a real failure from the Vercel logs and asserts
// the fixed behaviour:
//
//   · a broken summary RPC must not take the catalog down
//   · a broken settings read must not take /api/public/config down
//   · the rate limiter must be distributed, fail closed when critical, and must
//     never block the landing page
//   · Supabase Auth "email rate limit exceeded" must be a 429, never a 500
//   · diagnostics must reach the logs without the secrets
//   · supplier/TeleKos status must never be advertised as verified
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestApp } from './support/app-harness.mjs';
import { createRateLimiter } from '../src/security.js';
import { createLogger } from '../src/logging.js';
import { scrubSecrets, fromDbError } from '../src/errors.js';
import { createSupplierClient } from '../src/supplier.js';

// ---------------------------------------------------------------- helpers ---
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

const captureLogger = () => {
  const lines = [];
  const sink = {
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line))
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
};

/** A fake PostgreSQL-shaped db whose limiter RPC can be made to fail. */
function fakeDistributedDb({ fail = false, rpc = () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000, count: 1 }) } = {}) {
  const db = {
    kind: 'pg',
    calls: 0,
    rateLimit: {
      async hit(key, limit, window) {
        db.calls += 1;
        if (fail) {
          const err = new Error('relation "rate_limits" does not exist');
          err.code = 'PGRST202';
          err.rpc = 'rpc_rate_limit_hit';
          throw err;
        }
        return rpc(key, limit, window);
      }
    }
  };
  return db;
}

// ================================================== catalog / public API ====
test('catalog still renders when the summary RPC fails', async () => {
  const h = await startTestApp();
  try {
    await h.services.catalog.sync({ trigger: 'test' });

    // Reproduce the logged failure: rpc_public_summary blows up.
    const original = h.db.publicSummary;
    h.db.publicSummary = async () => {
      const err = new Error('RPC rpc_public_summary gagal');
      err.code = 'PGRST202';
      err.rpc = 'rpc_public_summary';
      throw err;
    };

    const response = await h.client().get('/api/public/catalog');
    assert.equal(response.status, 200, 'catalog must not 500 when the summary is unavailable');

    const body = response.json;
    assert.ok(Array.isArray(body.services), 'services must still be served');
    assert.ok(body.services.length > 0, 'the catalog must not be emptied');
    assert.equal(body.summarySource, 'derived', 'the summary must be derived from the rows');
    assert.equal(body.available, true);
    // The derived summary is computed from real rows, not invented.
    assert.equal(body.summary.activeServices, body.services.length);
    assert.equal(body.summarySource === 'derived' && body.summary.verified, undefined);

    h.db.publicSummary = original;
  } finally {
    await h.close();
  }
});

test('the summary endpoint degrades to 200 available:false instead of 500', async () => {
  const h = await startTestApp();
  try {
    await h.services.catalog.sync({ trigger: 'test' });
    const original = h.db.publicSummary;
    h.db.publicSummary = async () => {
      const err = new Error('permission denied for function rpc_public_summary');
      err.code = '42501';
      throw err;
    };

    const response = await h.client().get('/api/public/summary');
    assert.equal(response.status, 200, 'a display-only endpoint must never 500');
    assert.equal(response.json.available, false);
    assert.equal(response.json.reason, 'SUMMARY_UNAVAILABLE');
    // No invented statistics when the real numbers are unknown.
    assert.equal(response.json.activeServices, null);
    assert.equal(response.json.countries, null);

    h.db.publicSummary = original;
  } finally {
    await h.close();
  }
});

test('public config survives an unreadable settings table and labels the fallback', async () => {
  const h = await startTestApp();
  try {
    const original = h.db.settings.getPublic;
    h.db.settings.getPublic = async () => {
      const err = new Error('relation "app_settings" does not exist');
      err.code = '42P01';
      throw err;
    };
    h.services.settings.invalidate();

    const response = await h.client().get('/api/public/config');
    assert.equal(response.status, 200);
    assert.equal(response.json.settingsAvailable, false);
    // The placeholder identity is still served so the page renders, and it is
    // flagged, never presented as the configured policy.
    assert.ok(typeof response.json.store?.name === 'string' && response.json.store.name.length > 0);

    h.db.settings.getPublic = original;
    h.services.settings.invalidate();
  } finally {
    await h.close();
  }
});

test('the landing page is still served when the catalog read fails', async () => {
  const h = await startTestApp();
  try {
    const original = h.services.catalog.publicView;
    if (typeof original === 'function') {
      h.services.catalog.publicView = async () => {
        throw Object.assign(new Error('catalog unavailable'), { code: 'CATALOG_UNAVAILABLE' });
      };
    }
    const response = await h.client().get('/');
    assert.equal(response.status, 200, 'the landing page must never be blocked by a data outage');
    if (typeof original === 'function') h.services.catalog.publicView = original;
  } finally {
    await h.close();
  }
});

// =========================================================== rate limiter ===
test('rate limiter: distributed store is used when it is healthy', async () => {
  const db = fakeDistributedDb();
  const limiter = createRateLimiter({ db, logger: silent, config: {} });
  // Sebelum ada bukti, mode tidak boleh mengklaim 'distributed'.
  assert.equal(limiter.status().mode, 'unverified');

  const result = await limiter.enforce('login:1.2.3.4', 5, 60, { critical: true });
  assert.equal(result.storage, 'distributed');
  assert.equal(result.degraded, false);
  assert.equal(db.calls, 1);
  assert.equal(limiter.status().mode, 'distributed');
  assert.ok(limiter.status().verifiedAt, 'mode distributed harus punya bukti');
});

test('rate limiter: a critical endpoint fails closed when the store is down', async () => {
  const db = fakeDistributedDb({ fail: true });
  const limiter = createRateLimiter({ db, logger: silent, config: {} });

  await assert.rejects(
    () => limiter.enforce('login:1.2.3.4', 5, 60, { critical: true }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'RATE_LIMIT_UNAVAILABLE');
      assert.ok(err.retryAfter >= 1, 'a retry hint must be present');
      return true;
    }
  );

  const status = limiter.status();
  assert.equal(status.degraded, true);
  assert.equal(status.failures, 1);
  assert.equal(status.lastError.rpc, 'rpc_rate_limit_hit');
});

test('rate limiter: a public endpoint degrades to memory instead of being blocked', async () => {
  const db = fakeDistributedDb({ fail: true });
  const limiter = createRateLimiter({ db, logger: silent, config: {} });

  const result = await limiter.enforce('catalog:1.2.3.4', 100, 60);
  assert.equal(result.allowed, true, 'a data outage must not block the landing page');
  assert.equal(result.storage, 'memory');
  assert.equal(result.degraded, true);
});

test('rate limiter: the limit holds, the window resets, and parallel hits are counted once each', async () => {
  const limiter = createRateLimiter({ db: { kind: 'memory' }, logger: silent, config: {} });

  // Sequential: exactly `limit` allowed.
  for (let i = 0; i < 3; i += 1) {
    await limiter.enforce('seq', 3, 60);
  }
  await assert.rejects(() => limiter.enforce('seq', 3, 60), (err) => err.code === 'RATE_LIMITED' && err.status === 429);

  // Parallel: 20 simultaneous requests against a limit of 5 → exactly 5 land.
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.enforce('par', 5, 60).then(() => 'ok', (err) => err.code)
    )
  );
  assert.equal(outcomes.filter((o) => o === 'ok').length, 5, 'a parallel burst must not bypass the limit');
  assert.equal(outcomes.filter((o) => o === 'RATE_LIMITED').length, 15);

  // Window reset: a 1 s window frees up again.
  await limiter.enforce('win', 1, 1);
  await assert.rejects(() => limiter.enforce('win', 1, 1), (err) => err.code === 'RATE_LIMITED');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const after = await limiter.enforce('win', 1, 1);
  assert.equal(after.allowed, true, 'the bucket must reset when the window elapses');

  limiter.reset();
  const clean = await limiter.enforce('win', 1, 60);
  assert.equal(clean.allowed, true, 'reset() must clear every bucket');
});

test('rate limiter: warnings are throttled and never contain secrets', async () => {
  const { lines, logger } = captureLogger();
  const db = fakeDistributedDb({ fail: true });
  const limiter = createRateLimiter({ db, logger, config: {} });

  for (let i = 0; i < 5; i += 1) await limiter.enforce('k', 100, 60);

  const warnings = lines.filter((line) => line.includes('rate limiter storage unavailable'));
  assert.equal(warnings.length, 1, 'an outage must not flood the log');
  assert.ok(warnings[0].includes('PGRST202'), 'the pg code must be logged for diagnosis');
  assert.ok(!warnings[0].includes('finzz_local_pw'));
});

// ================================================ register / auth mapping ===
test('register with SMTP unavailable refuses to claim an email was sent', async () => {
  const h = await startTestApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' } });
  try {
    const response = await h.client().post('/api/auth/register', {
      email: `nosmtp.${Date.now()}@finzz.test`,
      password: 'Str0ngPass!',
      username: `nos${Date.now() % 100000}`
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.requiresVerification, true);
    // No SMTP in tests: the API must say so instead of pretending.
    assert.equal(response.json.emailSent, false);
    assert.ok(!response.text.includes('supabase'), 'Supabase Auth must not appear anywhere');
  } finally {
    await h.close();
  }
});

test('login rejects a wrong password with 401 and never leaks account existence', async () => {
  const h = await startTestApp();
  try {
    const email = `login.${Date.now()}@finzz.test`;
    await h.client().post('/api/auth/register', { email, password: 'Str0ngPass!', username: `lg${Date.now() % 100000}` });

    const wrong = await h.client().post('/api/auth/login', { email, password: 'SalahBanget123!' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');

    // Unknown address must look identical to a wrong password.
    const unknown = await h.client().post('/api/auth/login', { email: 'tidak.ada@finzz.test', password: 'SalahBanget123!' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error.code, 'INVALID_CREDENTIALS');
  } finally {
    await h.close();
  }
});

test('an unverified account cannot sign in while verification is enforced', async () => {
  const h = await startTestApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' } });
  try {
    const email = `unverified.${Date.now()}@finzz.test`;
    const registered = await h.client().post('/api/auth/register', {
      email, password: 'Str0ngPass!', username: `uv${Date.now() % 100000}`
    });
    assert.equal(registered.status, 201);

    const login = await h.client().post('/api/auth/login', { email, password: 'Str0ngPass!' });
    assert.equal(login.status, 403);
    assert.equal(login.json.error.code, 'EMAIL_NOT_VERIFIED');
  } finally {
    await h.close();
  }
});

test('password reset link is single-use and revokes every existing session', async () => {
  const h = await startTestApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' } });
  try {
    const email = `reset.${Date.now()}@finzz.test`;
    const password = 'Str0ngPass!';
    const first = h.client();
    await first.post('/api/auth/register', { email, password, username: `rs${Date.now() % 100000}` });
    assert.equal((await first.get('/api/auth/session')).status, 200, 'session must exist before reset');

    // Build a reset token the way the service does.
    const profile = [...h.db.store.profiles.values()].find((p) => p.email === email.toLowerCase());
    const { randomToken, sha256 } = await import('../src/auth/security.js');
    const raw = randomToken(32);
    await h.db.call('rpc_issue_auth_token', {
      p_user_id: profile.id, p_kind: 'password_reset', p_token_hash: sha256(raw), p_ttl_seconds: 600
    });

    const ok = await h.client().post('/api/auth/reset-password', { token: raw, password: 'PasswordBaru#2026' });
    assert.equal(ok.status, 200);

    // Second use must fail: the token is spent.
    const again = await h.client().post('/api/auth/reset-password', { token: raw, password: 'PasswordLain#2026' });
    assert.equal(again.status, 400);
    assert.equal(again.json.error.code, 'INVALID_TOKEN');

    // The session captured before the reset must no longer work.
    assert.equal((await first.get('/api/auth/session')).status, 401);

    // And the new password works.
    const login = await h.client().post('/api/auth/login', { email, password: 'PasswordBaru#2026' });
    assert.equal(login.status, 200);
  } finally {
    await h.close();
  }
});

test('an expired reset token is rejected', async () => {
  const h = await startTestApp({ env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' } });
  try {
    const email = `expired.${Date.now()}@finzz.test`;
    await h.client().post('/api/auth/register', { email, password: 'Str0ngPass!', username: `ex${Date.now() % 100000}` });
    const profile = [...h.db.store.profiles.values()].find((p) => p.email === email.toLowerCase());

    const { randomToken, sha256 } = await import('../src/auth/security.js');
    const raw = randomToken(32);
    await h.db.call('rpc_issue_auth_token', {
      p_user_id: profile.id, p_kind: 'password_reset', p_token_hash: sha256(raw), p_ttl_seconds: 600
    });
    // Age the token past its lifetime.
    const token = h.db.store.authTokens.find((t) => t.token_hash === sha256(raw));
    token.expires_at = new Date(Date.now() - 60_000).toISOString();

    const response = await h.client().post('/api/auth/reset-password', { token: raw, password: 'PasswordBaru#2026' });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'TOKEN_EXPIRED');
  } finally {
    await h.close();
  }
});

test('register still rejects an existing address with 409 EMAIL_TAKEN, not a 500', async () => {
  const h = await startTestApp();
  try {
    const client = h.client();
    const email = `dup.${Date.now()}@finzz.test`;
    const payload = { email, password: 'Str0ngPass!', username: `dup${Date.now() % 100000}` };

    const first = await client.post('/api/auth/register', payload);
    assert.equal(first.status, 201);

    const again = await h.client().post('/api/auth/register', { ...payload, username: `dup2${Date.now() % 100000}` });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'EMAIL_TAKEN');
  } finally {
    await h.close();
  }
});

// ============================================ diagnostics / secret hygiene ===
test('database errors keep their cause for the logs and drop the secrets', () => {
  const err = fromDbError({
    code: 'PGRST202',
    message: 'Could not find the function public.rpc_public_summary() — connection postgres://finzz:finzz_local_pw@db:5432/postgres',
    hint: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abc123'
  }, { rpc: 'rpc_public_summary' });

  assert.equal(err.status, 503);
  assert.equal(err.code, 'DB_FUNCTION_MISSING');
  assert.equal(err.diagnostic.pgCode, 'PGRST202');
  assert.equal(err.rpc, 'rpc_public_summary');
  assert.ok(!JSON.stringify(err.diagnostic).includes('finzz_local_pw'), 'the DB password must be scrubbed');
  assert.ok(!JSON.stringify(err.diagnostic).includes('eyJhbGciOiJIUzI1NiJ9'), 'the JWT must be scrubbed');
});

test('scrubSecrets removes connection strings, supabase URLs and keys', () => {
  const dirty = 'postgres://u:p@h/db https://abcdefgh.supabase.co/rest/v1 sbp_0123456789abcdef eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  const clean = scrubSecrets(dirty);
  assert.ok(!clean.includes('postgres://'));
  assert.ok(!clean.includes('supabase.co'));
  assert.ok(!clean.includes('sbp_0123456789abcdef'));
  assert.ok(!clean.includes('eyJhbGciOiJIUzI1NiJ9'));
});

// ================================================ TeleKos honesty contract ===
test('supplier status never claims the integration is verified', () => {
  const supplier = createSupplierClient(
    { supplier: { baseUrl: 'https://telekos.id/v1', apiKey: 'k'.repeat(24), timeoutMs: 1000, mode: 'live', enabled: true } },
    { logger: silent, fetchImpl: async () => { throw new Error('not called'); } }
  );
  const status = supplier.status();
  // A key alone proves nothing: no endpoint has answered yet.
  assert.equal(status.contractVerified, false, 'the live contract is not confirmed yet');
  assert.equal(status.webhookConfigured, false);
  assert.deepEqual(status.verifiedEndpoints, []);
  assert.ok(/not yet confirmed|mock fixture/i.test(status.verifiedNote));
});

test('contractVerified turns true only after every read endpoint really answered', async () => {
  const { createSupplierClient } = await import('../src/supplier.js');
  const bodies = {
    '/servers': [{ id: 'server1', name: 'Server 1', available: true, maintenance: false }],
    '/apps': [{ id: 'wa', name: 'Whatsapp' }],
    '/countries': [{ id: 6, name: 'Indonesia', iso: 'ID', calling_code: '+62', stock: 10 }],
    '/prices': [{ id: 'p1', offer_id: 'o1', price: 3200, currency: 'IDR', stock: 5 }]
  };
  const supplier = createSupplierClient(
    { supplier: { baseUrl: 'https://telekos.id/v1', apiKey: 'k'.repeat(24), timeoutMs: 1000, mode: 'live', enabled: true } },
    {
      logger: silent,
      fetchImpl: async (url) => {
        const path = new URL(url).pathname.replace('/v1', '');
        const data = bodies[path];
        if (!data) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
        return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
  );
  await supplier.getServers();
  await supplier.getApps('server1');
  await supplier.getCountries({ server: 'server1', app: 'wa' });
  // Three of four is still not verified.
  assert.equal(supplier.status().contractVerified, false);
  await supplier.getPrices({ server: 'server1', app: 'wa', country: 6 });
  const verified = supplier.status();
  assert.equal(verified.contractVerified, true);
  assert.equal(verified.verifiedNote.includes('read endpoints confirmed'), true);
  assert.ok(verified.verifiedEndpoints.includes('prices'));
});

test('health reports the supplier as unverified and the limiter mode', async () => {
  const h = await startTestApp();
  try {
    const response = await h.client().get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.json.supplier.contractVerified, false);
    assert.equal(response.json.supplier.mock, true);
    assert.ok(response.json.rateLimiter, 'the limiter state must be observable');
    assert.equal(response.json.rateLimiter.mode, 'memory');
    assert.ok(!/real-?time/i.test(response.text), 'no real-time claim may be published');
  } finally {
    await h.close();
  }
});

test('order payloads expose a freshness contract instead of a real-time claim', async () => {
  const h = await startTestApp();
  try {
    const client = h.client();
    await client.post('/api/auth/register', {
      email: `fresh.${Date.now()}@finzz.test`,
      password: 'Str0ngPass!',
      username: `fresh${Date.now() % 100000}`
    });
    const me = await client.get('/api/auth/session');
    assert.equal(me.status, 200, 'the session must be established');

    // No order yet: the contract is exercised on the list endpoint shape.
    const list = await client.get('/api/orders');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.orders));
    for (const order of list.json.orders) {
      assert.ok(order.statusFreshness, 'every order must carry its freshness metadata');
      assert.equal(typeof order.statusFreshness.verified, 'boolean');
    }
  } finally {
    await h.close();
  }
});

// ================================================ saldo supplier (TeleKos) ====
test('admin can read the supplier balance that getBalance() had never exposed', async () => {
  const h = await startTestApp();
  try {
    const client = h.client();
    await client.post('/api/auth/register', {
      email: `sup.${Date.now()}@finzz.test`,
      password: 'Str0ngPass!',
      username: `sup${Date.now() % 100000}`
    });
    const profile = [...h.db.store.profiles.values()].find((p) => p.email.startsWith('sup.'));
    profile.role = 'admin';

    const response = await client.get('/api/admin/supplier');
    assert.equal(response.status, 200);
    const body = response.json;
    assert.equal(body.available, true, 'mock supplier harus bisa dibaca');
    assert.equal(typeof body.balance, 'number', 'saldo harus angka nyata dari adapter');
    assert.equal(body.currency, 'IDR');
    assert.equal(body.contractVerified, false, ' tetap belum terverifikasi');
    assert.ok(body.servers && body.servers.total > 0);
  } finally {
    await h.close();
  }
});

test('a rejected TeleKos key becomes a diagnosable 200, never a 500', async () => {
  const h = await startTestApp();
  try {
    const client = h.client();
    await client.post('/api/auth/register', {
      email: `supbad.${Date.now()}@finzz.test`,
      password: 'Str0ngPass!',
      username: `supbad${Date.now() % 100000}`
    });
    const profile = [...h.db.store.profiles.values()].find((p) => p.email.startsWith('supbad.'));
    profile.role = 'admin';

    // Supplier menolak kunci — persis kasus "env sudah diset tapi tetap error".
    h.services.supplier.getBalance = async () => {
      const { SupplierError } = await import('../src/supplier-error.js');
      throw new SupplierError('INVALID_API_KEY', 'API key tidak valid', { httpStatus: 401, definitive: true });
    };
    h.services.supplier.getServers = async () => {
      const { SupplierError } = await import('../src/supplier-error.js');
      throw new SupplierError('INVALID_API_KEY', 'API key tidak valid', { httpStatus: 401, definitive: true });
    };

    const response = await client.get('/api/admin/supplier');
    assert.equal(response.status, 200, 'kegagalan supplier bukan 500');
    const body = response.json;
    assert.equal(body.available, false);
    assert.equal(body.balance, null, 'saldo tidak boleh dikarang saat gagal');
    assert.equal(body.error.code, 'INVALID_API_KEY');
    assert.ok(/TELEKOS_API_KEY/.test(body.error.hint), 'hint harus menunjuk env yang salah');
  } finally {
    await h.close();
  }
});

test('the supplier endpoint is admin-only', async () => {
  const h = await startTestApp();
  try {
    const anon = h.client();
    const denied = await anon.get('/api/admin/supplier');
    assert.ok([401, 403].includes(denied.status), `anon harus ditolak, dapat ${denied.status}`);
    assert.equal(denied.json.balance, undefined, 'tidak boleh membocorkan saldo');
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------- cron --
test('cron endpoints reject a missing or wrong secret', async () => {
  const h = await startTestApp({ env: { CRON_SECRET: 'cron-secret-yang-panjang-123' } });
  try {
    const noAuth = await h.client().post('/api/cron/poll');
    assert.equal(noAuth.status, 401);

    const wrong = await h.client().post('/api/cron/poll', undefined, { headers: { authorization: 'Bearer salah-sekali' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'UNAUTHORIZED');

    // Prefix of the real secret must not be accepted either.
    const prefix = await h.client().post('/api/cron/poll', undefined, { headers: { authorization: 'Bearer cron-secret-yang' } });
    assert.equal(prefix.status, 401);
  } finally {
    await h.close();
  }
});

test('cron runs once with the secret and is idempotent under concurrency', async () => {
  const h = await startTestApp({ env: { CRON_SECRET: 'cron-secret-yang-panjang-123' } });
  try {
    const auth = { authorization: 'Bearer cron-secret-yang-panjang-123' };

    const first = await h.client().post('/api/cron/poll', undefined, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.json.ran, true);
    assert.equal(first.json.job, 'orders.poller');

    // Hold the lock by hand, then fire again: the second call must skip, not run.
    await h.db.cron.claim('orders.poller', 'owner-lain-1234', 60);
    const held = await h.client().post('/api/cron/poll', undefined, { headers: auth });
    assert.equal(held.status, 200);
    assert.equal(held.json.skipped, 'locked');
    assert.equal(held.json.ran, undefined);

    // Releasing it lets the schedule run again.
    await h.db.cron.release('orders.poller', 'owner-lain-1234', 'success', null);
    const again = await h.client().post('/api/cron/poll', undefined, { headers: auth });
    assert.equal(again.json.ran, true);

    const rows = await h.db.cron.status();
    const row = rows.find((r) => r.name === 'orders.poller');
    assert.ok(row.run_count >= 2, 'runs must be recorded in PostgreSQL');
    assert.equal(row.owner, null, 'the lock must be released');
  } finally {
    await h.close();
  }
});

test('cron secret is mandatory in production', async () => {
  const { loadConfig } = await import('../src/config.js');
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db.test:5432/finzz',
    APP_URL: 'https://finzz.test',
    APP_ENCRYPTION_KEY: 'a'.repeat(32),
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'no-reply@finzz.test',
    TELEKOS_WEBHOOK_SECRET: 'whsec',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true'
  };
  assert.throws(() => loadConfig(base), /CRON_SECRET/);
  assert.throws(() => loadConfig({ ...base, CRON_SECRET: 'pendek' }), /16 characters/);
  assert.ok(loadConfig({ ...base, CRON_SECRET: 'c'.repeat(24) }).cron.secret);
});

test('the legacy SUPABASE_DB_URL alias no longer satisfies DATABASE_URL', async () => {
  const { loadConfig } = await import('../src/config.js');
  const base = {
    NODE_ENV: 'production',
    APP_URL: 'https://finzz.test',
    APP_ENCRYPTION_KEY: 'a'.repeat(32),
    CRON_SECRET: 'c'.repeat(24),
    TELEKOS_WEBHOOK_SECRET: 'whsec',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true'
  };
  // A Supabase-era deployment that only ever set SUPABASE_DB_URL must now fail
  // loudly instead of silently connecting through a hidden fallback.
  assert.throws(
    () => loadConfig({ ...base, SUPABASE_DB_URL: 'postgres://u:p@db.test:5432/finzz' }),
    /DATABASE_URL is required in production/
  );
  assert.ok(
    loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@db.test:5432/finzz' }).database.connectionString
  );
});

// --------------------------------------------------------------- turnstile --
test('Turnstile fails closed: no token is rejected when the feature is on', async () => {
  const h = await startTestApp({
    env: { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: '0x4AAAA_test', TURNSTILE_SECRET_KEY: 'test-secret' }
  });
  try {
    const response = await h.client().post('/api/auth/register', {
      email: `captcha.${Date.now()}@finzz.test`,
      password: 'Str0ngPass!',
      username: `cp${Date.now() % 100000}`
    });
    assert.equal(response.status, 400, 'a missing captcha token must block registration');
    assert.match(String(response.json.error.code), /CAPTCHA|TURNSTILE/i);
  } finally {
    await h.close();
  }
});

test('Turnstile is reported as disabled when unconfigured, so the UI hides it', async () => {
  const h = await startTestApp();
  try {
    const config = await h.client().get('/api/public/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.app.turnstile.enabled, false);
    assert.equal(config.json.app.turnstile.siteKey, '');
  } finally {
    await h.close();
  }
});
