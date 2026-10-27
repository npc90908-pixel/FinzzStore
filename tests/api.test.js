// ============================================================================
// API TESTS — end-to-end over real HTTP against the real application wiring
// (in-memory database + mock supplier). Nothing here mocks the router, the
// session layer or the RPC semantics.
// ============================================================================
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  startTestApp, registerUser, promoteToAdmin, seedBalance, walletBalance,
  firstService, resetRateLimits, supplierOrderId, PNG_1X1, WEBHOOK_SECRET
} from './support/app-harness.mjs';

let h;
let admin; // { client, profile }
let user; // { client, profile }

const email = (name) => `${name}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@finzz.test`;

before(async () => {
  h = await startTestApp();
  await h.services.catalog.sync({ trigger: 'test' });

  admin = {};
  admin.client = h.client();
  admin.profile = (await registerUser(h, admin.client, { email: email('admin'), username: 'adminuser' })).profile;
  promoteToAdmin(h, admin.profile.email);

  user = {};
  user.client = h.client();
  user.profile = (await registerUser(h, user.client, { email: email('user'), username: 'plainuser' })).profile;
});

after(async () => {
  await h.close();
});

// ------------------------------------------------------------- public ------
test('health endpoint reports database and supplier state', async () => {
  const response = await h.client().get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.database.driver, 'memory');
  assert.equal(response.json.supplier.mode, 'mock');
  assert.equal(response.json.payment.enabled, false);
  assert.ok(!response.text.includes('service_role'), 'health must not leak secrets');
});

test('Google OAuth uses a state cookie, creates a verified session, and returns only to a safe local path', async () => {
  const oauthHarness = await startTestApp({ env: {
    APP_URL: 'http://127.0.0.1:0',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://127.0.0.1:0/api/auth/google/callback'
  } });
  const client = oauthHarness.client();
  try {
    oauthHarness.services.googleOAuth.authenticate = async (code, codeVerifier) => {
      assert.equal(code, 'fake-google-code');
      assert.ok(codeVerifier, 'PKCE verifier stays in an HttpOnly server cookie until the callback');
      return { provider: 'google', providerSubject: 'google-subject', email: 'oauth.created@finzz.test', name: 'Akun Google' };
    };

    const firstStart = await client.get('/api/auth/google?next=%2Fwallet%3Fpage%3D2');
    assert.equal(firstStart.status, 302);
    const authorizeUrl = new URL(firstStart.headers.get('location'));
    assert.equal(authorizeUrl.origin, 'https://accounts.google.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-client-id');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizeUrl.searchParams.get('code_challenge'));
    assert.ok(client.cookies().fz_oauth_verifier);
    const invalidState = await client.get('/api/auth/google/callback?code=fake-google-code&state=not-the-state');
    assert.equal(invalidState.status, 302);
    assert.equal(invalidState.headers.get('location'), '/login?oauth=state');
    assert.equal(client.cookies().fz_oauth_state, undefined, 'one-time state cookies are cleared after failure');
    assert.equal(client.cookies().fz_oauth_verifier, undefined, 'PKCE verifier is cleared after failure');

    const secondStart = await client.get('/api/auth/google?next=%2Fwallet%3Fpage%3D2');
    const state = new URL(secondStart.headers.get('location')).searchParams.get('state');
    assert.ok(state);
    assert.ok(client.cookies().fz_oauth_next);
    const callback = await client.get(`/api/auth/google/callback?code=fake-google-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/wallet?page=2');
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(client.cookies().fz_oauth_state, undefined);
    assert.equal(client.cookies().fz_oauth_next, undefined);
    assert.equal(client.cookies().fz_oauth_verifier, undefined);

    const session = await client.get('/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.json.user.email, 'oauth.created@finzz.test');
    const profile = [...oauthHarness.db.store.profiles.values()].find((row) => row.email === 'oauth.created@finzz.test');
    assert.ok(profile.email_verified_at, 'Google-verified account enters the app as verified');
    assert.equal(profile.full_name, 'Akun Google');
  } finally {
    await oauthHarness.close();
  }
});

test('landing page is public and ships no secrets or invented statistics', async () => {
  const response = await h.client().get('/');
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);
  assert.ok(response.text.includes('id="app-root"'));
  assert.ok(response.text.includes('id="finzz-state"'));
  assert.ok(!response.text.includes('service_role'));
  assert.ok(!response.text.includes('TELEKOS_API_KEY'));
  // The public catalogue endpoint is what feeds prices; the shell itself must
  // not hardcode any stock or price claim.
  const catalog = await h.client().get('/api/public/catalog');
  assert.ok(catalog.json.services.length > 0, 'catalogue is synchronised in the test fixture');
  assert.equal(catalog.json.source, 'mock');
  // `available` must be evidence-based: rows exist, so it may be true. A
  // supplier that is merely *configured* is not evidence of anything.
  assert.equal(catalog.json.available, true);

  // Regression: listPublic() once omitted provider_app_id, so every service
  // arrived with appId=null and the whole catalogue collapsed into a single
  // "app" group on the landing page. Grouping needs that key.
  const services = catalog.json.services;
  assert.ok(services.every((s) => typeof s.appId === 'string' && s.appId.length > 0),
    'every public service must carry its supplier app id');
  const distinctApps = new Set(services.map((s) => s.appId));
  assert.equal(catalog.json.apps.length, distinctApps.size,
    'apps[] must group by app id, not lump everything together');
  assert.ok(distinctApps.size > 1, 'the fixture spans several apps');
  // The supplier's cost price must never leave the server.
  assert.ok(services.every((s) => s.supplierPrice === undefined && s.supplier_price === undefined),
    'supplier cost must not be exposed publicly');
});

test('public catalogue reports available:false when it holds no rows', async () => {
  const h = await startTestApp({ env: { SUPPLIER_MODE: 'live', TELEKOS_API_KEY: 'kunci-tidak-valid' } });
  try {
    // No successful sync ever ran, so the supplier is configured but empty.
    const response = await h.client().get('/api/public/catalog');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.services, []);
    assert.equal(response.json.available, false, 'an empty catalogue must never claim availability');
  } finally {
    await h.close();
  }
});

test('unknown API routes return JSON errors, unsupported methods return 405', async () => {
  const notFound = await h.client().get('/api/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.match(notFound.type, /application\/json/);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');

  const wrongMethod = await h.client().request('DELETE', '/api/health');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');
});

test('unknown pages render the SPA shell with a 404 status', async () => {
  const response = await h.client().get('/halaman-tidak-ada');
  assert.equal(response.status, 404);
  assert.ok(response.text.includes('id="app-root"'));
});

// ---------------------------------------------------------------- auth -----
test('register creates a session and protected routes become available', async () => {
  const client = h.client();
  const address = email('flow');
  const registered = await client.post('/api/auth/register', { email: address, password: 'Str0ngPass!', username: 'flowuser' });
  assert.equal(registered.status, 201);
  const cookies = client.cookies();
  assert.ok(cookies.fz_session, 'httpOnly session cookie is set');
  assert.ok(cookies.fz_csrf, 'readable CSRF cookie is set');

  const profile = [...h.db.store.profiles.values()].find((p) => p.email === address);
  assert.equal(profile.role, 'user', 'registration can never grant a role');
  assert.equal(profile.status, 'active');

  const session = await client.get('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.user.email, address);
});

test('duplicate registration and weak passwords are rejected', async () => {
  resetRateLimits(h);
  const client = h.client();
  const address = email('dupe');
  assert.equal((await client.post('/api/auth/register', { email: address, password: 'Str0ngPass!' })).status, 201);

  resetRateLimits(h);
  const duplicate = await h.client().post('/api/auth/register', { email: address, password: 'Str0ngPass!' });
  assert.ok([409, 422].includes(duplicate.status), `duplicate email rejected (${duplicate.status})`);

  resetRateLimits(h);
  const weak = await h.client().post('/api/auth/register', { email: email('weak'), password: 'short' });
  assert.equal(weak.status, 422);
  assert.equal(weak.json.error.code, 'VALIDATION_ERROR');
});

test('login rejects a wrong password and accepts the right one', async () => {
  resetRateLimits(h);
  const client = h.client();
  const address = email('login');
  await registerUser(h, client, { email: address });

  const wrong = await h.client().post('/api/auth/login', { email: address, password: 'WrongPass123' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');
  assert.ok(!wrong.text.includes('WrongPass123'), 'responses never echo credentials');

  const fresh = h.client();
  const ok = await fresh.post('/api/auth/login', { email: address, password: 'Str0ngPass!' });
  assert.equal(ok.status, 200);
  assert.ok(fresh.cookies().fz_session);
});

test('session refresh rotates the CSRF token and keeps the user signed in', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('refresh') });
  const before = decodeURIComponent(client.jar.get('fz_csrf'));

  const refreshed = await client.post('/api/auth/refresh', {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.user.id, profile.id);
  const after = decodeURIComponent(client.jar.get('fz_csrf'));
  assert.notEqual(after, before, 'the CSRF token is rotated');
  assert.equal(refreshed.json.csrfToken, after);

  // The rotated token works for the next mutation…
  const update = await client.patch('/api/profile', { full_name: 'Nama Baru' });
  assert.equal(update.status, 200);

  // …while the previous one is dead.
  const stale = await fetch(`${h.base}/api/profile`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      cookie: `fz_session=${client.jar.get('fz_session')}`,
      'x-csrf-token': before
    },
    body: JSON.stringify({ full_name: 'Palsu' })
  });
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, 'CSRF_FAILED');

  // The session cookie itself is unchanged: same device, same session.
  assert.ok(client.jar.get('fz_session'));
});

test('state-changing requests require the CSRF header', async () => {
  const without = await user.client.patch('/api/profile', { full_name: 'Tanpa CSRF' }, { csrf: false });
  assert.equal(without.status, 403);
  assert.equal(without.json.error.code, 'CSRF_FAILED');

  const withToken = await user.client.patch('/api/profile', { full_name: 'Dengan CSRF' });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.json.profile.fullName, 'Dengan CSRF');
});

test('role and status cannot be changed through the profile endpoint', async () => {
  const response = await user.client.patch('/api/profile', { role: 'admin', status: 'suspended', full_name: 'Sneaky' });
  assert.equal(response.status, 200);
  const profile = [...h.db.store.profiles.values()].find((p) => p.id === user.profile.id);
  assert.equal(profile.role, 'user', 'role is never writable from the client');
  assert.equal(profile.status, 'active', 'status is never writable from the client');
});

test('expired sessions are rejected on the next request', async () => {
  const client = h.client();
  const address = email('expiry');
  const { profile } = await registerUser(h, client, { email: address });
  assert.equal((await client.get('/api/auth/session')).status, 200);

  for (const session of h.db.store.sessions.values()) {
    if (session.user_id === profile.id) session.expires_at = new Date(Date.now() - 1000).toISOString();
  }

  const expired = await client.get('/api/auth/session');
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'SESSION_EXPIRED');
  assert.equal((await client.get('/api/wallet')).status, 401);
});

test('login rate limiting stops credential stuffing', async () => {
  resetRateLimits(h);
  const client = h.client();
  const address = email('ratelimit');
  await registerUser(h, client, { email: address, keepLimits: true });

  let limited = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await client.post('/api/auth/login', { email: address, password: 'WrongPass123' });
    if (response.status === 429) {
      limited = response;
      break;
    }
  }
  assert.ok(limited, 'the limiter eventually returns 429');
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  resetRateLimits(h);
});

// ------------------------------------------------------------- access ------
test('non-admins are rejected by every admin endpoint', async () => {
  const attempts = [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/deposits'],
    ['GET', '/api/admin/orders'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/settings'],
    ['POST', '/api/admin/catalog/sync']
  ];
  for (const [method, path] of attempts) {
    const response = await user.client.request(method, path, method === 'GET' ? undefined : {});
    assert.equal(response.status, 403, `${method} ${path} must be forbidden`);
    assert.equal(response.json.error.code, 'FORBIDDEN');
  }

  const promoted = await user.client.patch(`/api/admin/users/${user.profile.id}/role`, { role: 'admin' });
  assert.equal(promoted.status, 403, 'a user cannot promote themselves');
  const after = [...h.db.store.profiles.values()].find((p) => p.id === user.profile.id);
  assert.equal(after.role, 'user');
});

// -------------------------------------------------------------- orders -----
test('insufficient balance is refused before any supplier call', async () => {
  const poor = h.client();
  const { profile } = await registerUser(h, poor, { email: email('poor') });
  const service = await firstService(poor);

  const response = await poor.post('/api/orders', { service_id: service.id, idempotency_key: 'poor-key-0001' });
  assert.equal(response.status, 402);
  assert.equal(response.json.error.code, 'INSUFFICIENT_BALANCE');

  const orders = [...h.db.store.orders.values()].filter((o) => o.user_id === profile.id);
  assert.equal(orders.length, 0, 'a refused order must not be persisted');
});

test('a funded order debits exactly once and delivers an OTP to its owner', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('buyer') });
  const service = await firstService(client);

  await seedBalance(admin.client, profile.id, 50_000);
  const before = await walletBalance(client);

  const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'buy-key-0001' });
  assert.equal(created.status, 201);
  const order = created.json.order;
  assert.equal(order.status, 'waiting');
  assert.ok(order.number, 'supplier assigns a number immediately');
  assert.equal(created.json.balance, before - order.pricing.total);

  // Idempotent replay: same key → same order, no second debit.
  const replay = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'buy-key-0001' });
  assert.equal(replay.json.order.id, order.id);
  assert.equal(replay.json.balance, created.json.balance, 'replay must not debit again');
  assert.equal(await walletBalance(client), before - order.pricing.total);

  // Supplier pushes the OTP; the server sync applies it.
  const supplierId = await supplierOrderId(admin.client, order.id);
  h.services.supplier._forceOtp(supplierId);
  const synced = await client.post(`/api/orders/${order.id}/sync`);
  assert.equal(synced.status, 200);
  assert.equal(synced.json.order.status, 'completed');
  assert.match(synced.json.order.otp.code, /^\d{6}$/);

  // Another user can never read that OTP.
  const intruder = h.client();
  await registerUser(h, intruder, { email: email('intruder') });
  const forbidden = await intruder.get(`/api/orders/${order.id}`);
  assert.equal(forbidden.status, 404, 'orders are scoped to their owner');
  assert.ok(!forbidden.text.includes(synced.json.order.otp.code), 'OTP never leaks');

  const events = await client.get(`/api/orders/${order.id}/events`);
  assert.equal(events.status, 200);
  assert.ok(events.json.events.length >= 2, 'state changes are journaled');
});

test('each order stores the pricing rule snapshot that produced its amount', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('pricing') });
  const service = await firstService(client);
  await seedBalance(admin.client, profile.id, 50_000);

  const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'price-key-0001' });
  assert.equal(created.status, 201);
  const order = created.json.order;

  const row = await h.db.orders.get(order.id);
  const snapshot = row.pricing_snapshot;
  assert.ok(snapshot, 'pricing_snapshot must be written at checkout');
  assert.equal(snapshot.engine, 'resolvePrice/v1');
  assert.equal(typeof snapshot.markupBps, 'number');
  assert.ok(['service', 'default'].some((r) => snapshot.rule === r || String(snapshot.rule).startsWith('category:')));
  assert.ok(Array.isArray(snapshot.adjustments));

  // The stored amounts must satisfy the invariant the database enforces.
  const pricing = order.pricing;
  assert.equal(pricing.total, pricing.supplierPrice + pricing.markup + pricing.tax);
  assert.ok(pricing.total > 0);
});

test('a definitive OFFER_EXPIRED refunds once and asks the client to refetch the offer', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('expired') });
  const service = await firstService(client);
  await seedBalance(admin.client, profile.id, 50_000);
  const before = await walletBalance(client);

  // The supplier rejects the purchase with a documented definitive code.
  const original = h.services.supplier.createOrder;
  h.services.supplier.createOrder = async () => {
    const { SupplierError } = await import('../src/supplier-error.js');
    throw new SupplierError('OFFER_EXPIRED', 'offer kedaluwarsa', { httpStatus: 409, definitive: true });
  };

  try {
    const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'expired-key-01' });
    assert.equal(created.status, 201);
    assert.equal(created.json.order.status, 'failed');
    assert.equal(created.json.notice.code, 'OFFER_EXPIRED');
    assert.equal(created.json.notice.refetchOffer, true);
    assert.equal(created.json.notice.retryable, true);

    // Money is back exactly once, even if the request is repeated.
    const replay = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'expired-key-01' });
    assert.equal(replay.json.order.id, created.json.order.id);
    assert.equal(await walletBalance(client), before, 'a definitive failure must never keep the money');
  } finally {
    h.services.supplier.createOrder = original;
  }
});

test('cancelling before OTP refunds once and only once', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('canceller') });
  const service = await firstService(client);
  await seedBalance(admin.client, profile.id, 50_000);

  const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'cancel-key-0001' });
  const order = created.json.order;
  const afterDebit = await walletBalance(client);
  assert.equal(afterDebit, 50_000 - order.pricing.total);

  // The mock opens the cancel window immediately (cancelDelayMs = 0); syncing
  // refreshes `can_cancel` from the supplier before we ask to cancel.
  const synced = await client.post(`/api/orders/${order.id}/sync`);
  assert.equal(synced.json.order.canCancel, true);

  const cancelled = await client.post(`/api/orders/${order.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.order.status, 'cancelled');
  assert.equal(cancelled.json.refunded, true);
  assert.equal(await walletBalance(client), 50_000, 'refund restores the full price');

  const again = await client.post(`/api/orders/${order.id}/cancel`);
  assert.equal(again.status, 409);
  assert.equal(await walletBalance(client), 50_000, 'a second cancel cannot credit again');

  const ledger = [...h.db.store.transactions].filter((t) => t.reference_id === order.id);
  assert.equal(ledger.filter((t) => t.type === 'purchase').length, 1);
  assert.equal(ledger.filter((t) => t.type === 'refund').length, 1);
});

test('a supplier timeout neither refunds nor duplicates the purchase', async () => {
  const flaky = await startTestApp({ supplier: { ambiguousCreateOnce: 1 } });
  try {
    await flaky.services.catalog.sync({ trigger: 'test' });

    const client = flaky.client();
    const { profile } = await registerUser(flaky, client, { email: email('flaky') });
    const adminClient = flaky.client();
    const adminProfile = (await registerUser(flaky, adminClient, { email: email('flakyadmin') })).profile;
    promoteToAdmin(flaky, adminProfile.email);
    await seedBalance(adminClient, profile.id, 50_000);

    const service = await firstService(client);
    const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'flaky-key-0001' });
    assert.equal(created.status, 202, 'ambiguous outcome is reported as accepted, not success');
    assert.equal(created.json.pending, true);
    assert.equal(created.json.order.status, 'pending');
    assert.equal(created.json.notice.type, 'pending_confirmation');

    const debits = [...flaky.db.store.transactions].filter((t) => t.type === 'purchase' && t.user_id === profile.id);
    assert.equal(debits.length, 1, 'the wallet is debited once');

    const stale = await flaky.db.orders.get(created.json.order.id);
    const resumed = await flaky.services.orders.resumePending(stale, { worker: 'test' });
    assert.equal(resumed.reconciled, true);

    const order = await flaky.db.orders.get(created.json.order.id);
    assert.ok(order.supplier_order_id, 'the original supplier order is attached');
    assert.equal(order.status, 'waiting');
    assert.equal(order.refunded_at, null, 'timeouts never auto-refund');

    const after = [...flaky.db.store.transactions].filter((t) => t.type === 'purchase' && t.user_id === profile.id);
    assert.equal(after.length, 1, 'reconciliation must not create a second purchase');
    const supplierOrders = await flaky.services.supplier.listOrders();
    assert.equal(supplierOrders.orders.length, 1, 'the supplier holds a single order for this key');
  } finally {
    await flaky.close();
  }
});

test('the poller recovers orders left behind by a restart', async () => {
  const service = await firstService(user.client);
  await seedBalance(admin.client, user.profile.id, 30_000);

  const created = await user.client.post('/api/orders', {
    service_id: service.id,
    idempotency_key: `restart-${Date.now()}`
  });
  assert.equal(created.status, 201);
  const orderId = created.json.order.id;

  // Simulate a process restart: every lease is dropped and the next poller
  // tick (which is what a fresh boot schedules) must pick the order up.
  h.db.store.leases.clear();
  const stored = h.db.store.orders.get(orderId);
  stored.next_sync_at = new Date(Date.now() - 1000).toISOString();

  h.services.supplier._forceOtp(await supplierOrderId(admin.client, orderId));
  const tick = await h.jobs.poller.tick({ force: true });
  assert.ok(tick.claimed >= 1, 'the poller claims the stale order');

  const fresh = await user.client.get(`/api/orders/${orderId}`);
  assert.equal(fresh.json.order.status, 'completed', 'state survives in the database, not in memory');
  assert.match(fresh.json.order.otp.code, /^\d{6}$/);
});

// ------------------------------------------------------------ deposits -----
test('deposits are credited once after approval and cannot be re-approved', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('depositor') });

  const created = await client.post('/api/deposits', {
    amount: 25_000,
    proof: `data:image/png;base64,${PNG_1X1}`,
    note: 'Transfer BCA'
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.deposit.status, 'pending');
  assert.equal(created.json.deposit.hasProof, true);
  assert.equal(await walletBalance(client), 0, 'pending deposits are not credited');

  const adminList = await admin.client.get('/api/admin/deposits?status=pending');
  assert.ok(adminList.json.deposits.some((d) => d.id === created.json.deposit.id));

  const proof = await admin.client.get(`/api/admin/deposits/${created.json.deposit.id}/proof`);
  assert.equal(proof.status, 200);
  assert.equal(proof.headers.get('content-type'), 'image/png');

  const approved = await admin.client.post(`/api/admin/deposits/${created.json.deposit.id}/approve`, { note: 'Bukti valid' });
  assert.equal(approved.status, 200);
  assert.equal(await walletBalance(client), 25_000);

  const twice = await admin.client.post(`/api/admin/deposits/${created.json.deposit.id}/approve`, { note: 'Ulang' });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error.code, 'DEPOSIT_ALREADY_REVIEWED');
  assert.equal(await walletBalance(client), 25_000);
});

test('a rejected deposit never credits and requires a reason', async () => {
  const client = h.client();
  await registerUser(h, client, { email: email('rejected') });

  const created = await client.post('/api/deposits', {
    amount: 15_000,
    proof: `data:image/png;base64,${PNG_1X1}`
  });
  const depositId = created.json.deposit.id;

  const noReason = await admin.client.post(`/api/admin/deposits/${depositId}/reject`, {});
  assert.ok([400, 422].includes(noReason.status), 'a reason is mandatory');

  const rejected = await admin.client.post(`/api/admin/deposits/${depositId}/reject`, { reason: 'Bukti tidak terbaca' });
  assert.equal(rejected.status, 200);
  assert.equal(await walletBalance(client), 0, 'rejected deposits never credit');

  const approveAfter = await admin.client.post(`/api/admin/deposits/${depositId}/approve`, {});
  assert.ok([400, 409].includes(approveAfter.status));
  assert.equal(await walletBalance(client), 0);
});

// ------------------------------------------------------------- webhook -----
test('webhooks reject forged signatures and apply genuine ones', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('webhook') });
  const service = await firstService(client);
  await seedBalance(admin.client, profile.id, 40_000);

  const created = await client.post('/api/orders', { service_id: service.id, idempotency_key: `wh-${Date.now()}` });
  const order = created.json.order;
  const supplierId = await supplierOrderId(admin.client, order.id);

  const payload = JSON.stringify({
    type: 'order.otp',
    data: { order: { id: supplierId, status: 'received', number: order.number, otps: [{ id: 'OTP-1', code: '112233', message: 'Kode 112233', sender: 'Test', received_at: new Date().toISOString() }], can_cancel: false } }
  });

  const forged = await fetch(`${h.base}/api/webhooks/telekos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telekos-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=' + 'a'.repeat(64), 'x-telekos-delivery': 'd-forged' },
    body: payload
  });
  assert.equal(forged.status, 401);

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-telekos-signature': `t=${timestamp},v1=${signature}`,
    'x-telekos-delivery': 'd-valid-1'
  };
  const accepted = await fetch(`${h.base}/api/webhooks/telekos`, { method: 'POST', headers, body: payload });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).matched, true);

  const replay = await fetch(`${h.base}/api/webhooks/telekos`, { method: 'POST', headers, body: payload });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true, 'the same delivery id is processed once');

  const fresh = await client.get(`/api/orders/${order.id}`);
  assert.equal(fresh.json.order.otp.code, '112233');
});

// --------------------------------------------------------------- admin -----
test('admin dashboard reports real totals, audit trail and settings guards', async () => {
  const dashboard = await admin.client.get('/api/admin/dashboard');
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.json.users.total >= 2);
  assert.ok(dashboard.json.users.admins >= 1);
  assert.equal(typeof dashboard.json.finance.gross_revenue, 'number');
  assert.ok(dashboard.json.finance.gross_revenue >= dashboard.json.finance.supplier_cost);
  assert.equal(dashboard.json.finance.net_profit, dashboard.json.finance.gross_revenue - dashboard.json.finance.supplier_cost);
  assert.ok(Array.isArray(dashboard.json.recent_orders));
  assert.ok(dashboard.json.catalog.lastResult.status);

  const audit = await admin.client.get('/api/admin/audit');
  assert.equal(audit.status, 200);
  const actions = audit.json.entries.map((entry) => entry.action);
  assert.ok(actions.includes('wallet.adjustment'), 'manual balance changes are audited');
  assert.ok(actions.includes('deposit.approve'), 'deposit approval is audited');
  assert.ok(audit.json.entries.every((entry) => entry.admin?.email), 'every audit row names the acting admin');

  const badSetting = await admin.client.patch('/api/admin/settings/pricing_policy', { value: { default_markup_bps: -5 } });
  assert.ok([400, 422].includes(badSetting.status), 'settings are validated server-side');

  const unknownKey = await admin.client.patch('/api/admin/settings/not_a_setting', { value: {} });
  assert.ok([400, 422].includes(unknownKey.status));

  const saved = await admin.client.patch('/api/admin/settings/pricing_policy', {
    value: { default_markup_bps: 1750, tax_bps: 0, tax_label: 'PPN' }
  });
  assert.equal(saved.status, 200);
  const publicConfig = await h.client().get('/api/public/config');
  assert.ok(!JSON.stringify(publicConfig.json).includes('default_markup_bps'), 'internal pricing stays server-side');
});

test('manual balance adjustments require a reason and stay idempotent', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('adjust') });

  const noReason = await admin.client.post(`/api/admin/users/${profile.id}/wallet`, { direction: 'credit', amount: 5000 });
  assert.ok([400, 422].includes(noReason.status));

  const reference = '11111111-2222-4333-8444-555555555555';
  const first = await admin.client.post(`/api/admin/users/${profile.id}/wallet`, {
    direction: 'credit', amount: 5000, reason: 'Kompensasi gangguan', reference
  });
  assert.equal(first.status, 200);
  assert.equal(await walletBalance(client), 5000);

  const duplicate = await admin.client.post(`/api/admin/users/${profile.id}/wallet`, {
    direction: 'credit', amount: 5000, reason: 'Kompensasi gangguan', reference
  });
  assert.equal(duplicate.status, 409);
  assert.equal(await walletBalance(client), 5000, 'the same reference cannot credit twice');
});

// ------------------------------------------------- email verification (OTP) --
test('a verification code only confirms its own account, and guesses are limited', async () => {
  const h2 = await startTestApp({
    env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', AUTH_EXPOSE_DEV_TOKENS: 'true' }
  });
  try {
    const victimEmail = `otp-a.${Date.now()}@finzz.test`;
    const attackerEmail = `otp-b.${Date.now()}@finzz.test`;
    const victim = h2.client();
    const attacker = h2.client();

    const victimReg = await victim.post('/api/auth/register', {
      email: victimEmail, password: 'Str0ngPass!', username: `otpa${Date.now() % 100000}`
    });
    const attackerReg = await attacker.post('/api/auth/register', {
      email: attackerEmail, password: 'Str0ngPass!', username: `otpb${Date.now() % 100000}`
    });
    assert.equal(victimReg.status, 201);
    assert.match(victimReg.json.devToken, /^\d{6}$/, 'the dev build exposes the code so tests can use it');

    // The attacker's own browser holds the attacker's verification cookie, so
    // submitting the victim's address can at most verify the *attacker's* own
    // account — never the victim's. This is the property that matters.
    await attacker.post('/api/auth/verify-email', {
      email: victimEmail, code: attackerReg.json.devToken
    }).catch(() => {});
    const victimStillUnverified = await h2.client().post('/api/auth/login', {
      email: victimEmail, password: 'Str0ngPass!'
    });
    assert.equal(victimStillUnverified.json.error.code, 'EMAIL_NOT_VERIFIED',
      'the victim account must still require verification');

    // A caller with no cookie at all cannot pair the attacker's code with the
    // victim's address: the code is bound to its owner.
    const crossUse = await h2.client().post('/api/auth/verify-email', {
      email: victimEmail, code: attackerReg.json.devToken
    });
    assert.equal(crossUse.status, 400);
    assert.equal(crossUse.json.error.code, 'INVALID_TOKEN');

    // The attacker's own session (if any) must belong to the attacker, not to
    // the account whose address was typed. This is the real invariant.
    const attackerSession = await attacker.get('/api/auth/session');
    if (attackerSession.status === 200) {
      assert.equal(attackerSession.json.email ?? attackerSession.json.user?.email, attackerEmail,
        'a session may only ever belong to the cookie holder');
    }

    // Repeated wrong guesses eventually burn the code (max_attempts = 5).
    for (let i = 0; i < 6; i += 1) {
      await attacker.post('/api/auth/verify-email', { email: victimEmail, code: '000000' }).catch(() => {});
    }
    const afterBurn = await victim.post('/api/auth/verify-email', { email: victimEmail, code: victimReg.json.devToken });
    assert.ok([400, 429].includes(afterBurn.status), 'a burned code can no longer verify');
    assert.equal((await victim.get('/api/auth/session')).status, 401);
  } finally {
    await h2.close();
  }
});

test('a fresh verification code signs the owner in and cannot be reused', async () => {
  const h2 = await startTestApp({
    env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', AUTH_EXPOSE_DEV_TOKENS: 'true' }
  });
  try {
    const email = `otp-ok.${Date.now()}@finzz.test`;
    const client = h2.client();
    const registered = await client.post('/api/auth/register', {
      email, password: 'Str0ngPass!', username: `otpok${Date.now() % 100000}`
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.json.requiresVerification, true);

    const verified = await client.post('/api/auth/verify-email', { email, code: registered.json.devToken });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.verified, true);

    const session = await client.get('/api/auth/session');
    assert.equal(session.status, 200, 'verification signs the user in');
    assert.equal(session.json.user.email, email);

    // The same code is spent.
    const again = await h2.client().post('/api/auth/verify-email', { email, code: registered.json.devToken });
    assert.equal(again.status, 400);
  } finally {
    await h2.close();
  }
});

test('pages that carry a one-time secret are served with no-referrer', async () => {
  const reset = await h.client().get('/reset-password?token=rahasia-sekali-pakai');
  assert.equal(reset.headers.get('referrer-policy'), 'no-referrer');

  const verify = await h.client().get('/verify-email?email=a@b.test');
  assert.equal(verify.headers.get('referrer-policy'), 'no-referrer');

  // A normal page keeps the site-wide default so analytics-free navigation
  // still works the same way it always did.
  const landing = await h.client().get('/');
  assert.equal(landing.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

// ====================================== verification context (migration 007) ==
test('registration issues a verification context so no email is typed again', async () => {
  const h = await startTestApp({
    env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', AUTH_EXPOSE_DEV_TOKENS: 'true' }
  });
  try {
    const client = h.client();
    const email = `ctx.${Date.now()}@finzz.test`;
    const reg = await client.post('/api/auth/register', {
      email, password: 'Str0ngPass!', username: `ctx${Date.now() % 100000}`
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.requiresVerification, true);
    assert.equal(reg.json.verification.active, true);
    // The page shows a masked address; the full one is never needed by the UI.
    assert.match(reg.json.verification.emailMasked, /^c\*+t?@|^c\*+@/i);
    assert.ok(!reg.json.verification.emailMasked.includes(email.split('@')[0]),
      'the local part must be masked');

    // The cookie is HttpOnly — the browser can never read or forge it.
    const setCookie = reg.headers.getSetCookie();
    const verifyCookie = setCookie.find((c) => c.startsWith('fz_verify='));
    assert.ok(verifyCookie, 'a verification cookie must be set');
    assert.match(verifyCookie, /HttpOnly/i);
    assert.match(verifyCookie, /SameSite=Lax/i);

    const context = await client.get('/api/auth/verification-context');
    assert.equal(context.status, 200);
    assert.equal(context.json.present, true);
    assert.equal(context.json.active, true);
    assert.equal(context.json.alreadyVerified, false);

    // Verification with the code ALONE — no email field.
    const verified = await client.post('/api/auth/verify-email', { code: reg.json.devToken });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.verified, true);
    assert.equal((await client.get('/api/auth/session')).status, 200, 'verification signs the user in');

    // The context is burned: replaying the code fails.
    const replay = await client.post('/api/auth/verify-email', { code: reg.json.devToken });
    assert.ok([400, 401, 410].includes(replay.status), 'a used code cannot be replayed');
  } finally {
    await h.close();
  }
});

test('verification resend obeys a server-enforced cooldown', async () => {
  const h = await startTestApp({
    env: {
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
      AUTH_EXPOSE_DEV_TOKENS: 'true',
      AUTH_RESEND_COOLDOWN_SECONDS: '60'
    }
  });
  try {
    const client = h.client();
    await client.post('/api/auth/register', {
      email: `resend.${Date.now()}@finzz.test`, password: 'Str0ngPass!',
      username: `rs${Date.now() % 100000}`
    });
    const first = await client.post('/api/auth/resend-verification', {});
    // Registration already sent one, so the immediate resend is inside cooldown.
    assert.equal(first.status, 429);
    assert.equal(first.json.error.code, 'RESEND_COOLDOWN');
    assert.ok(first.json.error.retryAfter > 0, 'the client is told exactly how long to wait');
  } finally {
    await h.close();
  }
});

test('unverified login hands the browser a usable verification context', async () => {
  const h = await startTestApp({
    env: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', AUTH_EXPOSE_DEV_TOKENS: 'true' }
  });
  try {
    const email = `unverified.${Date.now()}@finzz.test`;
    const client = h.client();
    await client.post('/api/auth/register', {
      email, password: 'Str0ngPass!', username: `uv${Date.now() % 100000}`
    });
    // A brand-new client has no cookie: login must recreate the context.
    const fresh = h.client();
    const login = await fresh.post('/api/auth/login', { email, password: 'Str0ngPass!' });
    assert.equal(login.status, 403);
    assert.equal(login.json.error.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(login.json.error.verification.active, true);
    assert.ok(login.json.error.verification.emailMasked.includes('*'));
    assert.equal((await fresh.get('/api/auth/session')).status, 401, 'no session before verification');

    const context = await fresh.get('/api/auth/verification-context');
    assert.equal(context.json.present, true, 'the login response set a fresh context cookie');
  } finally {
    await h.close();
  }
});

test('the catalogue is browsable without an account', async () => {
  const h = await startTestApp();
  try {
    // Populate the catalogue first: this test is about access, not sync timing.
    await h.services.catalog.sync({ trigger: 'test' });
    const anon = h.client();
    // Public page: served to a visitor, not redirected to /login.
    const page = await anon.get('/services');
    assert.equal(page.status, 200, 'a visitor can open the catalogue page');

    const catalog = await anon.get('/api/public/catalog');
    assert.equal(catalog.status, 200);
    assert.ok(catalog.json.services.length > 0);
    // Nothing privileged leaks with the public catalogue.
    assert.ok(!JSON.stringify(catalog.json).includes('supplier_price'));
    assert.ok(!JSON.stringify(catalog.json).includes('supplierPrice'));

    // Buying still requires a session — enforced by the server, not the UI.
    const buy = await anon.post('/api/orders', { service_id: catalog.json.services[0].id, idempotency_key: 'anon-buy-attempt-key' });
    assert.equal(buy.status, 401);
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------- notifications ------
test('notifications come from real order events and are scoped to their owner', async () => {
  const owner = h.client();
  const { profile } = await registerUser(h, owner, { email: email('notif-owner') });
  const stranger = h.client();
  await registerUser(h, stranger, { email: email('notif-stranger') });

  // Nothing is invented: a fresh account has an empty inbox.
  const empty = await owner.get('/api/notifications');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.notifications, []);
  assert.equal(empty.json.unreadCount, 0);

  // A real order is the source of the notification.
  const service = await firstService(owner);
  await seedBalance(admin.client, profile.id, 50_000);
  const created = await owner.post('/api/orders', { service_id: service.id, idempotency_key: 'notif-key-0001' });
  assert.equal(created.status, 201);

  const inbox = await owner.get('/api/notifications');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.notifications.length >= 1, true, 'the order produced at least one notification');
  // The mock supplier attaches a number immediately, so both "created" and
  // "waiting" are recorded — newest first, exactly as the DB wrote them.
  const types = inbox.json.notifications.map((n) => n.type);
  assert.ok(types.includes('order.created'), `order.created present (got ${types.join(', ')})`);
  assert.ok(types.includes('order.waiting'), `order.waiting present (got ${types.join(', ')})`);
  const first = inbox.json.notifications.find((n) => n.type === 'order.created');
  assert.equal(first.orderId, created.json.order.id);
  assert.equal(first.readAt, null);
  assert.ok(first.title && first.body, 'a notification has a title and body');
  assert.ok(inbox.json.unreadCount >= 1);
  assert.ok(!JSON.stringify(inbox.json).includes('otp_code'), 'the inbox never carries OTP fields');

  // Another signed-in user cannot see it, even with the same id in hand.
  const otherInbox = await stranger.get('/api/notifications');
  assert.deepEqual(otherInbox.json.notifications, []);
  const hijack = await stranger.post('/api/notifications/read', { ids: [first.id] });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.json.updated, 0, "somebody else's id updates nothing");

  // Marking read is idempotent and reports the new unread count.
  const marked = await owner.post('/api/notifications/read', { ids: [first.id] });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.updated, 1);
  const again = await owner.post('/api/notifications/read', { ids: [first.id] });
  assert.equal(again.json.updated, 0);

  const readAll = await owner.post('/api/notifications/read-all', {});
  assert.equal(readAll.status, 200);
  assert.equal(readAll.json.unreadCount, 0);

  // Input validation and authentication.
  const badIds = await owner.post('/api/notifications/read', { ids: 'not-an-array' });
  assert.equal(badIds.status, 400);
  const anonymous = await h.client().get('/api/notifications');
  assert.equal(anonymous.status, 401);
});

test('a refund and a deposit review each produce their own notification', async () => {
  const client = h.client();
  const { profile } = await registerUser(h, client, { email: email('notif-flow') });

  // Deposit -> admin approve -> "deposit.approved".
  const deposit = await client.post('/api/deposits', { amount: 25_000, proof: PNG_1X1 });
  assert.equal(deposit.status, 201);
  const approved = await admin.client.post(`/api/admin/deposits/${deposit.json.deposit.id}/approve`, { amount: 25_000, note: 'OK' });
  assert.equal(approved.status, 200);

  const afterDeposit = await client.get('/api/notifications');
  const depositNote = afterDeposit.json.notifications.find((n) => n.type === 'deposit.approved');
  assert.ok(depositNote, 'an approved deposit notifies the owner');
  assert.equal(depositNote.severity, 'success');
  assert.equal(depositNote.depositId, deposit.json.deposit.id);

  // Order cancelled before OTP -> refund on the wallet, with its own row.
  const service = await firstService(client);
  const order = await client.post('/api/orders', { service_id: service.id, idempotency_key: 'notif-void-0001' });
  await client.post(`/api/orders/${order.json.order.id}/sync`);
  const cancelled = await client.post(`/api/orders/${order.json.order.id}/cancel`);
  assert.equal(cancelled.status, 200);

  const afterCancel = await client.get('/api/notifications');
  const types = afterCancel.json.notifications.map((n) => n.type);
  assert.ok(types.includes('wallet.refund'), `refund notification present (got ${types.join(', ')})`);
  // The notification for the owner only, never for the admin who did nothing.
  const profileJson = JSON.stringify(afterCancel.json);
  assert.ok(!profileJson.includes(profile.email), 'notifications do not embed the account email');
});
