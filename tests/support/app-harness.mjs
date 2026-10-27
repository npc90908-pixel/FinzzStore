// ============================================================================
// TEST HARNESS — boots the real application (same wiring as server.js) on an
// ephemeral port with the in-memory database and the mock supplier.
// ============================================================================
import { createServer } from 'node:http';
import { createApplication } from '../../src/bootstrap.js';
import { silentLogger } from '../../src/logging.js';

export const WEBHOOK_SECRET = 'whsec_finzz_test_secret';

const BASE_ENV = {
  NODE_ENV: 'test',
  SUPPLIER_MODE: 'mock',
  DEMO_MODE: 'false',
  JOBS_ENABLED: 'false',
  PORT: '0',
  HOST: '127.0.0.1',
  APP_URL: 'http://127.0.0.1:0',
  SESSION_TTL_SECONDS: '900',
  RATE_LIMIT_ENABLED: 'true',
  LOG_LEVEL: 'silent',
  TELEKOS_WEBHOOK_SECRET: WEBHOOK_SECRET
};

export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function startTestApp({ env = {}, supplier = {}, paymentOptions = {} } = {}) {
  const app = await createApplication({
    env: { ...BASE_ENV, ...env },
    logger: silentLogger,
    paymentOptions,
    // Long OTP delay by default: tests force the OTP explicitly so they never
    // depend on wall-clock timing.
    supplierOptions: { otpDelayMs: 60000, cancelDelayMs: 0, ...supplier }
  });

  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.jobs.poller.stop();
    await app.jobs.reconciliation.stop();
    await app.db.close();
  };

  return { ...app, app, base, server, close, client: () => createClient(base) };
}

export function createClient(base) {
  const jar = new Map();

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  async function request(method, path, body, { csrf = true, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (body !== undefined) finalHeaders['content-type'] = 'application/json';
    if (jar.size) finalHeaders.cookie = cookieHeader();
    const token = jar.get('fz_csrf');
    if (csrf && token && method !== 'GET' && method !== 'HEAD') {
      finalHeaders['x-csrf-token'] = decodeURIComponent(token);
    }

    const response = await fetch(`${base}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual'
    });

    for (const cookie of response.headers.getSetCookie?.() || []) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html response */
    }
    return { status: response.status, json, text, headers: response.headers, type: response.headers.get('content-type') };
  }

  return {
    jar,
    cookies: () => Object.fromEntries(jar),
    request,
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body ?? {}, options),
    patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
    del: (path, options) => request('DELETE', path, undefined, options)
  };
}

/** Clear every rate-limit bucket (tests share one IP). */
export function resetRateLimits(app) {
  app.db.store?.rateLimits?.clear?.();
  app.services.rateLimiter.reset();
}

/** Register a user through the public API and return the profile row. */
export async function registerUser(app, client, { email, password = 'Str0ngPass!', username = null, keepLimits = false } = {}) {
  if (!keepLimits) resetRateLimits(app);
  const result = await client.post('/api/auth/register', { email, password, username });
  if (result.status !== 201) throw new Error(`register failed: ${result.status} ${result.text}`);
  const profile = [...app.db.store.profiles.values()].find((p) => p.email === email.toLowerCase());
  return { profile, result };
}

/** Promote a profile to admin the way a DBA would (direct row update). */
export function promoteToAdmin(app, email) {
  const profile = [...app.db.store.profiles.values()].find((p) => p.email === email.toLowerCase());
  if (!profile) throw new Error(`profile not found: ${email}`);
  profile.role = 'admin';
  return profile;
}

/** Seed a wallet through the audited admin endpoint (no direct ledger writes). */
export async function seedBalance(adminClient, userId, amount = 100_000, reason = 'Seed saldo pengujian') {
  const result = await adminClient.post(`/api/admin/users/${userId}/wallet`, {
    direction: 'credit',
    amount,
    reason
  });
  if (result.status !== 200) throw new Error(`wallet seed failed: ${result.status} ${result.text}`);
  return result.json;
}

export async function walletBalance(client) {
  const result = await client.get('/api/wallet?page=1');
  return result.json?.balance;
}

/** Supplier order id is admin-only information. */
export async function supplierOrderId(adminClient, orderId) {
  const response = await adminClient.get(`/api/admin/orders/${orderId}`);
  if (response.status !== 200) throw new Error(`admin order lookup failed: ${response.status}`);
  return response.json.order.supplier.orderId;
}

export async function firstService(client) {
  const catalog = await client.get('/api/public/catalog');
  const service = catalog.json?.services?.[0];
  if (!service) throw new Error('catalog is empty');
  return service;
}
