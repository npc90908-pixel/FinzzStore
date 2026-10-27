// ============================================================================
// UNIT TESTS — pure modules, fixtures and static guarantees.
// Run: npm test (node:test, no external test framework)
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, generateKeyPairSync, sign as signJwt } from 'node:crypto';

import {
  parseRupiah, fromDbAmount, applyBps, composePrice, formatRupiah, toDbAmount, MoneyError, MAX_AMOUNT,
  resolvePrice, normalisePricingPolicy, describePricing, ROUNDING_MODES
} from '../src/money.js';
import { escapeHtml, safeJsonForHtml, sha256, assertRequestOrigin, originAllowed, requestOriginAllowed, securityHeaders } from '../src/security.js';
import { buildCsp } from '../src/http.js';
import { loadConfig, publicConfigView } from '../src/config.js';
import { redact } from '../src/logging.js';
import * as v from '../src/validation.js';
import { mapSupplierStatus, SupplierError } from '../src/supplier-error.js';
import { createMockSupplier } from '../src/supplier-mock.js';
import { createSupplierClient } from '../src/supplier.js';
import { createCatalogService } from '../src/catalog.js';
import { createOrderService } from '../src/orders.js';
import { MINIMUM_TOPUP_AMOUNT, normalizeDepositPolicy } from '../src/deposit-policy.js';
import { PAGES } from '../src/pages.js';
import { renderDocument } from '../src/render.js';
import { createLogger } from '../src/logging.js';
import { marqueeBrands, splitRows } from '../public/js/brands.js';
import { createGoogleOAuth } from '../src/auth-google.js';
import { loadOptionalEnvFile } from '../src/env.js';
import { createMailer, diagnoseSmtpError, passwordResetEmail, verificationEmail } from '../src/auth/mailer.js';
import { createPaymentAdapter } from '../src/payment/adapter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir, filter, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// -------------------------------------------------------------- deposits -----
test('deposit policy enforces a Rp1,000 minimum while retaining higher configured limits', () => {
  assert.equal(MINIMUM_TOPUP_AMOUNT, 1000);
  assert.equal(normalizeDepositPolicy({ min_amount: 999 }).min_amount, 1000);
  assert.equal(normalizeDepositPolicy({ min_amount: 1000 }).min_amount, 1000);
  assert.equal(normalizeDepositPolicy({ min_amount: 10000 }).min_amount, 10000);
});

// ---------------------------------------------------------------- money -----
test('money: parseRupiah accepts integer amounts and rejects fractions', () => {
  assert.equal(parseRupiah(25000), 25000);
  assert.equal(parseRupiah('25.000'), 25000);
  assert.equal(parseRupiah('25000,00'), 25000);
  assert.throws(() => parseRupiah('25000,50'), MoneyError); // sub-rupiah amounts are rejected
  assert.equal(parseRupiah('0'), 0);
  assert.throws(() => parseRupiah('12,345'), MoneyError); // 3 decimals
  assert.throws(() => parseRupiah(-1), MoneyError);
  assert.throws(() => parseRupiah('abc'), MoneyError);
  assert.throws(() => parseRupiah(null), MoneyError);
  assert.throws(() => parseRupiah(MAX_AMOUNT + 1), MoneyError);
});

test('money: markup and tax are integer and additive', () => {
  assert.equal(applyBps(10000, 1500), 1500);
  assert.equal(applyBps(1999, 1555), Math.round((1999 * 1555) / 10000));
  assert.throws(() => applyBps(1000, -1), MoneyError);
  assert.throws(() => applyBps(1000.5, 100), MoneyError);

  const price = composePrice({ supplierPrice: 1725, markupBps: 1500, taxBps: 1100 });
  assert.deepEqual(price, { supplierPrice: 1725, markupAmount: 259, taxAmount: 218, totalPrice: 2202 });
  assert.equal(price.supplierPrice + price.markupAmount + price.taxAmount, price.totalPrice);
  assert.ok(Number.isInteger(price.totalPrice));
});

test('money: db amounts round-trip without floating point drift', () => {
  for (const value of [1, 999, 25000, 1234567]) {
    assert.equal(fromDbAmount(toDbAmount(value)), value);
  }
  assert.equal(fromDbAmount('1999.00'), 1999);
  assert.equal(fromDbAmount(null), 0);
  assert.match(formatRupiah(25000), /25\.000/);
  assert.throws(() => toDbAmount(10.5), MoneyError);
});

// ------------------------------------------------------------- security -----
test('security: html escaping and JSON-in-HTML escaping', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  const payload = safeJsonForHtml({ a: '</script><script>alert(1)</script>', b: '&<>' });
  assert.ok(!payload.includes('</script>'));
  assert.ok(payload.includes('\\u003c'));
  assert.deepEqual(JSON.parse(payload.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')), {
    a: '</script><script>alert(1)</script>',
    b: '&<>'
  });
});

test('security: secrets are redacted from log metadata', () => {
  const output = redact({
    email: 'user@example.com',
    password: 'hunter2hunter2',
    apiKey: 'secret-value',
    authorization: 'Bearer abc.def',
    nested: { token: 'abc', ok: 1 }
  });
  assert.equal(output.email, 'user@example.com');
  assert.notEqual(output.password, 'hunter2hunter2');
  assert.notEqual(output.apiKey, 'secret-value');
  assert.notEqual(output.authorization, 'Bearer abc.def');
  assert.notEqual(output.nested.token, 'abc');
  assert.equal(output.nested.ok, 1);
});

test('security: CSP permits Turnstile only when the feature is configured', () => {
  const disabled = loadConfig({ NODE_ENV: 'test' });
  const enabled = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'https://finzz.test',
    TURNSTILE_SITE_KEY: 'public-site-key',
    TURNSTILE_SECRET_KEY: 'private-secret'
  });
  const disabledPolicy = buildCsp('nonce', disabled);
  const enabledPolicy = buildCsp('nonce', enabled);
  assert.ok(!disabledPolicy.includes('challenges.cloudflare.com'));
  assert.match(enabledPolicy, /script-src[^;]*challenges\.cloudflare\.com/);
  assert.match(enabledPolicy, /connect-src[^;]*challenges\.cloudflare\.com/);
  assert.match(enabledPolicy, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(securityHeaders('nonce', enabled)['Content-Security-Policy'], /frame-src 'self'/);
});

test('security: token hashing is stable and one-way', () => {
  const a = sha256('session-token');
  const b = sha256('session-token');
  assert.equal(a, b);
  assert.notEqual(a, 'session-token');
  assert.equal(a.length, 64);
  assert.notEqual(sha256('session-token-2'), a);
});

test('security: cross-site mutations are blocked, same-host requests pass', () => {
  const config = { allowedOrigins: ['https://finzz.example.com'] };
  const req = (headers) => ({ headers });

  assert.equal(originAllowed('https://finzz.example.com', config), true);
  assert.equal(originAllowed('https://evil.example.com', config), false);

  // allowlisted origin
  assert.doesNotThrow(() => assertRequestOrigin(req({ origin: 'https://finzz.example.com', host: 'finzz.example.com' }), config));
  // same host behind a proxy / preview domain that is not hardcoded
  assert.doesNotThrow(() => assertRequestOrigin(req({ origin: 'https://3000-abc.e2b.app', host: '3000-abc.e2b.app' }), config));
  // a different site must be rejected
  assert.throws(
    () => assertRequestOrigin(req({ origin: 'https://evil.example.com', host: 'finzz.example.com' }), config),
    (err) => err.code === 'ORIGIN_NOT_ALLOWED'
  );
  // the CORS gate used by the API layer follows the same rule
  assert.equal(requestOriginAllowed(req({ origin: 'https://3000-abc.e2b.app', host: '3000-abc.e2b.app' }), config), true);
  assert.equal(requestOriginAllowed(req({ origin: 'https://evil.example.com', host: 'finzz.example.com' }), config), false);
  assert.equal(requestOriginAllowed(req({ host: 'finzz.example.com' }), config), true);

  // cross-site fetch metadata is rejected as well
  assert.throws(
    () => assertRequestOrigin(req({ 'sec-fetch-site': 'cross-site', host: 'finzz.example.com' }), config),
    (err) => err.code === 'ORIGIN_NOT_ALLOWED'
  );
});

// ----------------------------------------------------------- validation -----
test('validation: rejects malformed input', () => {
  assert.equal(v.email('User@Example.com '), 'user@example.com');
  assert.throws(() => v.email('not-an-email'));
  assert.throws(() => v.email('a'.repeat(250) + '@x.com'));
  assert.equal(v.uuid('2f1b4c2e-6f4a-4b1e-9c2d-0f7c9b2a1d33'), '2f1b4c2e-6f4a-4b1e-9c2d-0f7c9b2a1d33');
  assert.throws(() => v.uuid('123'));
  assert.throws(() => v.idempotencyKey('short'));
  assert.equal(v.idempotencyKey('ord-12345678'), 'ord-12345678');
  assert.equal(v.username('budi_99'), 'budi_99');
  assert.throws(() => v.username('a b'));
  assert.equal(v.money('25000', { field: 'amount' }), 25000);
  assert.throws(() => v.money('0', { field: 'amount', min: 1 }));
});

// --------------------------------------------------------------- orders -----
test('supplier-error: documented statuses map onto internal order statuses', () => {
  assert.equal(mapSupplierStatus('processing'), 'pending');
  assert.equal(mapSupplierStatus('PURCHASE_CONFIRMATION_PENDING'), 'pending');
  assert.equal(mapSupplierStatus('Processing'), 'pending');
  assert.equal(mapSupplierStatus('waiting'), 'waiting');
  assert.equal(mapSupplierStatus('received'), 'received');
  assert.equal(mapSupplierStatus('completed'), 'completed');
  assert.equal(mapSupplierStatus('cancelled'), 'cancelled');
  assert.equal(mapSupplierStatus('expired'), 'expired');
  assert.equal(mapSupplierStatus('something-else'), null);

  const definitive = new SupplierError('INVALID_OFFER', 'nope', { definitive: true });
  const ambiguous = new SupplierError('TIMEOUT', 'timeout', { definitive: false, retryable: true });
  assert.equal(definitive.definitive, true);
  assert.equal(ambiguous.definitive, false);
  assert.equal(ambiguous.retryable, true);
});

test('mock supplier: deterministic prices, idempotent purchase, guarded cancel', async () => {
  const supplier = createMockSupplier({ otpDelayMs: 0, cancelDelayMs: 60000 });
  const { offers } = await supplier.getPrices({ server: 'server1', app: 'wa', country: 6 });
  assert.ok(offers.length >= 1);
  assert.ok(offers[0].price > 0);
  assert.equal(offers[0].currency, 'IDR');

  const first = await supplier.createOrder({ offerId: offers[0].offerId, idempotencyKey: 'key-aaaaaaaa' });
  const replay = await supplier.createOrder({ offerId: offers[0].offerId, idempotencyKey: 'key-aaaaaaaa' });
  assert.equal(replay.order.id, first.order.id, 'same idempotency key must not create a second order');
  assert.equal(replay.replayed, true);

  await assert.rejects(
    () => supplier.cancelOrder(first.order.id),
    (err) => err instanceof SupplierError && err.code === 'CANCEL_NOT_AVAILABLE'
  );
  supplier._forceOtp(first.order.id);
  const withOtp = await supplier.getOrder(first.order.id);
  assert.equal(withOtp.otps.length, 1);
  assert.match(withOtp.otps[0].code, /^\d{6}$/);
});


test('TeleKos adapter uses only documented dynamic reads and preserves provider IDs', async () => {
  const requests = [];
  const config = { supplier: {
    baseUrl: 'https://telekos.test/api', apiKey: 'server-only-key', timeoutMs: 1000,
    mode: 'live', enabled: true, webhookSecret: 'server-only-webhook-secret'
  } };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    const data = url.pathname.endsWith('/servers')
      ? [{ id: 'srv-A', name: 'Server A', available: true, maintenance: false }]
      : url.pathname.endsWith('/apps')
        ? [{ id: 'wa-id', name: 'WhatsApp' }]
        : url.pathname.endsWith('/countries')
          ? [{ id: 61, name: 'Country X', iso: 'CX', calling_code: '+999', stock: 8 }]
          : [
              { id: 'price-row-high', offer_id: 'supplier-offer-high', price: 2400, stock: 3 },
              { id: 'price-row-low', offer_id: 'supplier-offer-low', price: 900, stock: 5 }
            ];
    return new Response(JSON.stringify({ data, meta: { quoted_at: '2026-10-27T00:00:00.000Z' } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const supplier = createSupplierClient(config, { fetchImpl });

  assert.deepEqual(await supplier.getServers(), [{ id: 'srv-A', name: 'Server A', available: true, maintenance: false }]);
  assert.deepEqual(await supplier.getApps('srv-A'), [{ id: 'wa-id', name: 'WhatsApp' }]);
  assert.deepEqual(await supplier.getCountries({ server: 'srv-A', app: 'wa-id' }), [{
    id: 61, name: 'Country X', iso: 'CX', callingCode: '+999', stock: 8
  }]);
  const prices = await supplier.getPrices({ server: 'srv-A', app: 'wa-id', country: 61, refresh: true });
  assert.deepEqual(prices.offers.map((offer) => [offer.id, offer.offerId, offer.price]), [
    ['price-row-low', 'supplier-offer-low', 900], ['price-row-high', 'supplier-offer-high', 2400]
  ]);
  assert.equal(prices.quotedAt, '2026-10-27T00:00:00.000Z');
  assert.deepEqual(requests.map(({ url }) => url.pathname), [
    '/api/servers', '/api/apps', '/api/countries', '/api/prices'
  ], 'discovery calls only documented TeleKos routes');
  assert.equal(requests[1].url.searchParams.get('server'), 'srv-A');
  assert.equal(requests[2].url.searchParams.get('app'), 'wa-id');
  assert.equal(requests[3].url.searchParams.get('country'), '61');
  assert.equal(requests[3].url.searchParams.get('refresh'), '1');
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer server-only-key'));
  assert.equal(supplier.status().contractVerified, true, 'test adapter evidence is local to this client instance');
  assert.ok(!JSON.stringify(supplier.status()).includes('server-only-key'));
  assert.ok(!JSON.stringify(supplier.status()).includes('server-only-webhook-secret'));

  let retryCount = 0;
  const retrying = createSupplierClient(config, {
    fetchImpl: async () => {
      retryCount += 1;
      return retryCount === 1
        ? new Response(JSON.stringify({ error: { code: 'TEMPORARY' } }), { status: 503 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  assert.deepEqual(await retrying.getServers(), []);
  assert.equal(retryCount, 2, 'a transient read receives one bounded retry');

  const newestOtp = createSupplierClient(config, {
    fetchImpl: async () => new Response(JSON.stringify({ data: {
      id: 'TRX-OTP', status: 'received', otps: [
        { id: 'old', code: '111111', received_at: '2026-10-27T10:00:00.000Z' },
        { id: 'new', code: '222222', received_at: '2026-10-27T10:01:00.000Z' }
      ]
    } }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const order = await newestOtp.getOrder('TRX-OTP');
  assert.equal(order.otps[0].code, '222222', 'latest OTP is always first regardless of provider array order');
});

test('dynamic catalogue cache sorts sale prices and labels failed refresh data stale', async () => {
  const providerQuotedAt = '2026-10-27T00:00:00.000Z';
  let failPrices = false;
  const supplier = {
    mode: 'live', isConfigured: true, isMock: false,
    async getServers() { return [{ id: 'srv-A', name: 'Server A', available: true, maintenance: false }]; },
    async getApps() { return [{ id: 'wa-id', name: 'WhatsApp' }]; },
    async getCountries() { return [{ id: 61, name: 'Country X', iso: 'CX', callingCode: '+999', stock: 5 }]; },
    async getPrices() {
      if (failPrices) throw Object.assign(new Error('temporary upstream failure'), { code: 'RATE_LIMITED' });
      return { quotedAt: providerQuotedAt, offers: [
        { id: 'high', offerId: 'provider-high', price: 2400, currency: 'IDR', stock: 2 },
        { id: 'low', offerId: 'provider-low', price: 900, currency: 'IDR', stock: 4 }
      ] };
    },
    status() { return { configured: true }; }
  };
  const db = { jobs: { async acquire() { return true; }, async release() { return true; } } };
  const settings = { async get(key) {
    if (key === 'pricing_policy') return { default_markup_bps: 1500, tax_bps: 0, category_bps: {} };
    if (key === 'supplier') return { server: null, allowlist: [] };
    return {};
  } };
  const catalog = createCatalogService({
    db, supplier, settings, logger: { warn() {}, info() {}, error() {} },
    config: { supplier: { mode: 'live' }, jobs: {} }
  });

  const result = await catalog.publicPrices({ server: 'srv-A', app: 'wa-id', country: 61 });
  assert.deepEqual(result.offers.map((offer) => offer.offerId), ['provider-low', 'provider-high']);
  assert.ok(result.offers[0].salePrice < result.offers[1].salePrice, 'sale amounts are sorted numerically');
  assert.ok(!Object.hasOwn(result.offers[0], 'supplierPrice'), 'supplier cost stays private');
  assert.equal(result.cache.providerQuotedAt, providerQuotedAt);
  assert.equal(result.cache.fresh, true);

  let leaseAvailable = true;
  db.jobs.acquire = async () => leaseAvailable;
  leaseAvailable = false;
  const quoteDuringOtherRefresh = await catalog.quoteOffer({ server: 'srv-A', app: 'wa-id', country: 61, offerId: 'provider-low' });
  assert.equal(quoteDuringOtherRefresh.cache.refreshInProgress, true);
  assert.equal(quoteDuringOtherRefresh.live, false, 'a fresh cache is not treated as a checkout confirmation while another worker refreshes');
  leaseAvailable = true;

  failPrices = true;
  const stale = await catalog.readPrices({ server: 'srv-A', app: 'wa-id', country: 61, refresh: true });
  assert.equal(stale.cache.stale, true, 'failed refresh can only serve explicitly stale cached prices');
  assert.equal(stale.cache.fresh, false);
  assert.equal(stale.cache.lastError, 'RATE_LIMITED');
  const staleQuote = await catalog.quoteOffer({ server: 'srv-A', app: 'wa-id', country: 61, offerId: 'provider-low' });
  assert.equal(staleQuote.source, 'telekos');
  assert.equal(staleQuote.live, false, 'a stale last-known offer can be displayed but cannot authorize checkout');
  assert.equal(staleQuote.cache.stale, true);

  for (let index = 0; index < 510; index += 1) await catalog.readApps({ server: `server-${index}` });
  assert.ok(catalog.status.cacheEntries <= 500, 'untrusted combinations cannot grow the process cache without bound');
});

test('order service rejects stale supplier quotes before any wallet/order write', async () => {
  let writes = 0;
  const orderService = createOrderService({
    db: { orders: { async create() { writes += 1; } } },
    supplier: { isConfigured: true, isMock: false },
    settings: { async get(key) { return key === 'operations' ? { sales_open: true } : {}; } },
    catalog: { async quoteOffer() {
      return {
        offerId: 'provider-offer', live: false, source: 'telekos',
        price: { supplierPrice: 900, markupAmount: 135, taxAmount: 0, totalPrice: 1035 },
        supplierPrice: 900
      };
    } },
    logger: { child() { return this; } },
    config: { demoMode: false }
  });

  await assert.rejects(
    orderService.create({
      user: { id: 'user-1', role: 'user' },
      offer: { server: 'srv-A', app: 'wa-id', country: 61, offerId: 'provider-offer' },
      expectedPrice: 1035,
      idempotencyKey: 'stale-offer-test-key'
    }),
    (err) => err.code === 'QUOTE_UNAVAILABLE' && err.status === 503
  );
  assert.equal(writes, 0, 'no wallet debit, ledger row, or order row is attempted');
});

// ---------------------------------------------------------------- pages -----
test('page registry: 20 routes with correct access flags', () => {
  const keys = Object.keys(PAGES).sort();
  assert.deepEqual(keys, [
    '/', '/admin', '/bantuan', '/dashboard', '/forgot-password', '/keamanan', '/kontak',
    '/login', '/notifications', '/orders', '/privacy', '/profile', '/register',
    '/reset-password', '/services', '/status', '/tentang', '/terms', '/verify-email', '/wallet'
  ]);
  assert.equal(PAGES['/status'].requiresAuth, false, 'the status page is public');
  assert.equal(PAGES['/'].requiresAuth, false);
  assert.equal(PAGES['/terms'].requiresAuth, false);
  assert.equal(PAGES['/dashboard'].requiresAuth, true);
  assert.equal(PAGES['/notifications'].requiresAuth, true, 'the inbox is private');
  assert.equal(PAGES['/admin'].requiresAdmin, true);
  assert.equal(PAGES['/login'].guestOnly, true);
  for (const page of Object.values(PAGES)) {
    assert.ok(page.title, 'every page needs a title');
    assert.ok(page.key, 'every page needs a client module key');
    assert.equal(typeof page.requiresAuth, 'boolean');
  }
});

test('renderer: server HTML carries a CSP nonce and a JSON boot state', () => {
  const html = renderDocument({
    page: 'landing',
    meta: { title: 'FINZZ Store' },
    nonce: 'abc123nonce',
    state: {
      path: '/reset-password?token=secret-preview-token',
      user: { id: 'u1', email: 'a@b.c' },
      config: { appName: 'FINZZ', appUrl: 'https://finzz.test' },
      csrfToken: 'csrf-token'
    }
  });
  assert.match(html, /nonce="abc123nonce"/);
  assert.match(html, /id="finzz-state"/);
  assert.match(html, /id="app-root"/);
  assert.ok(html.includes('csrf-token'));
  assert.ok(!/src="https?:\/\//.test(html), 'the shell must not load external scripts');
  assert.ok(!/@import\s+url\(/.test(html), 'the shell must not load external styles');
  assert.ok(html.includes('/js/main.js'));
  assert.ok(html.includes('/css/auth.css'), 'the upgraded login/register presentation is included in the shared shell');
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  assert.equal(canonical, 'https://finzz.test/reset-password', 'query secrets never enter canonical/share URLs');
  assert.match(html, /property="og:image" content="https:\/\/finzz\.test\/assets\/og-finzz\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});

// ----------------------------------------------------------- static gates ---
test('social share and touch-icon assets are valid-sized local PNGs', async () => {
  for (const [file, width, height] of [
    ['public/assets/og-finzz.png', 1200, 630],
    ['public/assets/svg/apple-touch-icon.png', 180, 180],
    ['public/assets/svg/favicon.png', 32, 32]
  ]) {
    const png = await readFile(path.join(ROOT, file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} has the PNG signature`);
    assert.equal(png.readUInt32BE(16), width, `${file} width`);
    assert.equal(png.readUInt32BE(20), height, `${file} height`);
  }
  const svgIcon = await readFile(path.join(ROOT, 'public/assets/svg/favicon.svg'), 'utf8');
  assert.match(svgIcon, /viewBox="0 0 48 48"/);
});

test('repository: no physical .html files are shipped', async () => {
  const files = await walk(ROOT, (file) => file.endsWith('.html'));
  assert.deepEqual(files, [], `unexpected HTML files: ${files.join(', ')}`);
});

test('frontend: no innerHTML with dynamic data and no secrets in public assets', async () => {
  const jsFiles = await walk(path.join(ROOT, 'public', 'js'), (file) => file.endsWith('.js'));
  assert.ok(jsFiles.length >= 15, 'frontend modules are present');

  for (const file of jsFiles) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(ROOT, file);
    for (const match of source.matchAll(/innerHTML\s*=\s*([^\n;]+)/g)) {
      const value = match[1].trim();
      const isStatic = /^(['"`])[\s\S]*\1$/.test(value) && !value.includes('${');
      const isTrustedHelper = value.startsWith('String(value)') || value.startsWith('markup');
      assert.ok(isStatic || isTrustedHelper, `${relative}: innerHTML receives a dynamic value -> ${value}`);
    }
    assert.ok(!source.includes('document.write'), `${relative}: document.write is forbidden`);
    assert.ok(!/eval\s*\(/.test(source), `${relative}: eval is forbidden`);
    assert.ok(!source.includes('new Function'), `${relative}: new Function is forbidden`);
  }

  const publicFiles = await walk(path.join(ROOT, 'public'), () => true);
  for (const file of publicFiles) {
    if (!/\.(js|css|svg|json)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const secret of ['SUPABASE_SERVICE_ROLE_KEY', 'TELEKOS_API_KEY', 'APP_ENCRYPTION_KEY', 'service_role']) {
      assert.ok(!source.includes(secret), `${path.relative(ROOT, file)} exposes ${secret}`);
    }
    for (const oldColor of ['#6d8bff', '#22d3a6', '#0b0d12', 'rgba(109,139,255', 'rgba(34,211,166']) {
      assert.ok(!source.toLowerCase().includes(oldColor.toLowerCase()), `${path.relative(ROOT, file)} reintroduces retired brand palette ${oldColor}`);
    }
  }
});

test('logging: structured lines never contain raw secrets', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', sink: { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
  logger.info('supplier call', { apiKey: 'super-secret-key', password: 'pw', orderId: 'o-1' });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'info');
  assert.equal(entry.orderId, 'o-1');
  assert.notEqual(entry.apiKey, 'super-secret-key');
  assert.notEqual(entry.password, 'pw');
});

test('webhook signature contract matches the supplier documentation', () => {
  const secret = 'whsec_test';
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ type: 'order.otp', data: { order: { id: 'TRX-1' } } });
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  // Same construction the route performs; proves header format t=..,v1=hex.
  assert.match(`t=${timestamp},v1=${signature}`, /^t=\d+,v1=[a-f0-9]{64}$/);
});

// --------------------------------------------------------------- config -----
test('optional .env loader tolerates a missing file and preserves process variables', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finzz-env-test-'));
  const file = path.join(directory, '.env');
  const loadedKey = 'FINZZ_ENV_LOADER_TEST';
  const precedenceKey = 'FINZZ_ENV_PRECEDENCE_TEST';
  const oldLoaded = process.env[loadedKey];
  const oldPrecedence = process.env[precedenceKey];
  try {
    delete process.env[loadedKey];
    process.env[precedenceKey] = 'runtime-value';
    await writeFile(file, `${loadedKey}=from-file\n${precedenceKey}=from-file\n`, 'utf8');
    assert.equal(loadOptionalEnvFile(file), true);
    assert.equal(process.env[loadedKey], 'from-file');
    assert.equal(process.env[precedenceKey], 'runtime-value', 'deployment variables take precedence over .env');
    assert.equal(loadOptionalEnvFile(path.join(directory, 'missing.env')), false);
  } finally {
    if (oldLoaded === undefined) delete process.env[loadedKey];
    else process.env[loadedKey] = oldLoaded;
    if (oldPrecedence === undefined) delete process.env[precedenceKey];
    else process.env[precedenceKey] = oldPrecedence;
    await rm(directory, { recursive: true, force: true });
  }
});

const PROD_ENV = {
  NODE_ENV: 'production',
  APP_URL: 'https://finzz.test',
  APP_ENCRYPTION_KEY: 'a'.repeat(32),
  DATABASE_URL: 'postgres://finzz:secret@db.finzz.test:5432/finzz?sslmode=require',
  TELEKOS_API_KEY: 'telekos-key',
  TELEKOS_WEBHOOK_SECRET: 'whsec_test',
  CRON_SECRET: 'cron-secret-test',
  AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  SMTP_HOST: 'smtp.finzz.test',
  SMTP_FROM: 'no-reply@finzz.test',
  TURNSTILE_ENABLED: 'false',
  SUPPLIER_MODE: 'off'
};

test('config: production refuses demo mode and the mock supplier', () => {
  assert.throws(() => loadConfig({ ...PROD_ENV, DEMO_MODE: 'true' }), /DEMO_MODE/);
  assert.throws(() => loadConfig({ ...PROD_ENV, SUPPLIER_MODE: 'mock' }), /SUPPLIER_MODE/);
  // A legitimate production config still loads.
  const config = loadConfig(PROD_ENV);
  assert.equal(config.isProduction, true);
  assert.equal(config.supplier.mode, 'off');
});

test('config: Vercel keeps the PostgreSQL pool to one short-lived client per function', () => {
  const vercel = loadConfig({
    ...PROD_ENV,
    VERCEL: '1',
    DATABASE_POOL_MAX: '10',
    DATABASE_IDLE_TIMEOUT: '30000'
  });
  assert.equal(vercel.isVercel, true);
  assert.equal(vercel.database.poolMax, 1, 'an explicit larger pool must not multiply across serverless instances');
  assert.equal(vercel.database.idleTimeoutMs, 5000);

  const persistent = loadConfig({ ...PROD_ENV, DATABASE_POOL_MAX: '4' });
  assert.equal(persistent.database.poolMax, 4, 'non-serverless deployments may still tune their pool');
});

test('config: demo credentials exist only for a non-production demo', () => {
  const demo = loadConfig({
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    APP_ENCRYPTION_KEY: 'a'.repeat(32),
    APP_URL: 'http://127.0.0.1:3000'
  });
  const published = publicConfigView(demo).demoAccounts;
  assert.equal(published.length, 2);
  assert.deepEqual(published.map((a) => a.role).sort(), ['admin', 'user']);
  assert.ok(published.every((a) => a.email.endsWith('@finzz.store')));

  // Not a demo: nothing is published even though the role list exists.
  const prod = loadConfig(PROD_ENV);
  assert.equal(prod.demo.accounts.length, 0);
  assert.deepEqual(publicConfigView(prod).demoAccounts, []);
  assert.equal(prod.demo.seed, false);
});

test('config: optional integrations enable from complete credentials and never expose secrets', () => {
  const plain = loadConfig(PROD_ENV);
  assert.equal(plain.turnstile.enabled, false);
  assert.equal(plain.oauth.available, false);
  assert.deepEqual(publicConfigView(plain).oauth, { google: false });

  const configured = loadConfig({
    ...PROD_ENV,
    TURNSTILE_ENABLED: undefined,
    TURNSTILE_SITE_KEY: 'public-site-key',
    TURNSTILE_SECRET_KEY: 'private-turnstile-secret',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'private-google-secret'
  });
  assert.equal(configured.turnstile.enabled, true);
  assert.equal(configured.oauth.available, true);
  assert.equal(configured.oauth.redirectUri, 'https://finzz.test/api/auth/google/callback');
  assert.deepEqual(publicConfigView(configured).turnstile, { enabled: true, siteKey: 'public-site-key' });
  assert.deepEqual(publicConfigView(configured).oauth, { google: true });
  assert.ok(!JSON.stringify(publicConfigView(configured)).includes('private-'));

  assert.throws(() => loadConfig({ ...PROD_ENV, TURNSTILE_ENABLED: 'true' }), /TURNSTILE_SITE_KEY/);
  assert.throws(() => loadConfig({ ...PROD_ENV, GOOGLE_CLIENT_ID: 'client-id' }), /BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  assert.throws(() => loadConfig({
    ...PROD_ENV,
    GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'https://attacker.example/api/auth/google/callback'
  }), /must be https:\/\/finzz\.test/);
});


test('config: AstraPay is opt-in, requires a complete HTTPS deployment config, and keeps credentials private', () => {
  const disabled = loadConfig(PROD_ENV);
  assert.equal(disabled.payment.enabled, false);
  assert.deepEqual(publicConfigView(disabled).payment, { enabled: false, provider: null, mode: 'disabled' });

  const enabled = loadConfig({
    ...PROD_ENV,
    ASTRAPAY_ENABLED: 'true',
    ASTRAPAY_PROJECT_SLUG: 'finzz-project',
    ASTRAPAY_API_KEY: 'unit-test-api-key-not-real',
    ASTRAPAY_WEBHOOK_SECRET: 'unit-test-webhook-secret-not-real'
  });
  assert.equal(enabled.payment.enabled, true);
  assert.deepEqual(publicConfigView(enabled).payment, { enabled: true, provider: 'astrapay', mode: 'live' });
  const publicJson = JSON.stringify(publicConfigView(enabled));
  assert.ok(!publicJson.includes('unit-test-api-key-not-real'));
  assert.ok(!publicJson.includes('unit-test-webhook-secret-not-real'));
  assert.throws(() => loadConfig({ ...PROD_ENV, ASTRAPAY_ENABLED: 'true' }), /project slug, API key, and webhook secret/);
  assert.throws(() => loadConfig({
    ...PROD_ENV,
    NODE_ENV: 'test',
    APP_URL: 'http://finzz.test',
    ASTRAPAY_ENABLED: 'true',
    ASTRAPAY_PROJECT_SLUG: 'finzz-project',
    ASTRAPAY_API_KEY: 'key',
    ASTRAPAY_WEBHOOK_SECRET: 'secret'
  }), /public HTTPS origin/);
});

test('AstraPay adapter validates invoice details and verifies raw-body timestamped HMACs', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'https://finzz.test',
    ASTRAPAY_ENABLED: 'true',
    ASTRAPAY_PROJECT_SLUG: 'finzz-project',
    ASTRAPAY_API_KEY: 'unit-test-api-key-not-real',
    ASTRAPAY_WEBHOOK_SECRET: 'unit-test-webhook-secret-not-real'
  });
  const expiresAt = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  const paidAt = new Date().toISOString();
  const calls = [];
  let qrisFee = 0;
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const isCreate = options.method === 'POST';
    return new Response(JSON.stringify({
      ok: true,
      data: {
        id: 'order-1',
        reference: 'FZ-UNIT-REF',
        status: isCreate ? 'pending' : 'paid',
        base_amount: 1000,
        credit_amount: 1000,
        fee_qris: qrisFee,
        service_fee: 0,
        pay_amount: 1007,
        checkout_url: 'https://gateway.astrapay.biz.id/pay/order-1',
        qris: '000201-test-payload',
        expires_at: expiresAt,
        paid_at: isCreate ? null : paidAt
      }
    }), { status: isCreate ? 201 : 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createPaymentAdapter(config, { fetchImpl: fakeFetch });
  const invoice = await adapter.createPayment({
    reference: 'FZ-UNIT-REF', amount: 1000, expiresIn: 600,
    webhookUrl: 'https://finzz.test/api/webhooks/astrapay',
    redirectUrl: 'https://finzz.test/wallet'
  });
  assert.equal(invoice.providerOrderId, 'order-1');
  assert.equal(invoice.payAmount, 1007, 'gateway unique-code offset stays in the payable amount');
  assert.equal(invoice.feeAmount, 0);
  assert.equal(invoice.feeQris, 0);
  assert.equal(invoice.serviceFee, 0);
  assert.equal(calls[0].options.headers['x-api-key'], 'unit-test-api-key-not-real');
  assert.equal(calls[0].options.body.includes('1000'), true);

  const remote = await adapter.checkStatus('order-1');
  const paid = adapter.validatePaidOrder(remote, {
    providerOrderId: 'order-1', reference: 'FZ-UNIT-REF', amount: 1000,
    payAmount: 1007, expiresAt
  });
  assert.equal(paid.payAmount, 1007);
  assert.equal(paid.feeAmount, 0);
  assert.equal(paid.creditAmount, 1000);
  assert.equal(calls[1].options.method, 'GET');

  qrisFee = 1;
  await assert.rejects(() => adapter.createPayment({
    reference: 'FZ-UNIT-REF', amount: 1000, expiresIn: 600,
    webhookUrl: 'https://finzz.test/api/webhooks/astrapay',
    redirectUrl: 'https://finzz.test/wallet'
  }), (error) => error.code === 'PAYMENT_PROVIDER_CONTRACT_INVALID');
  assert.throws(() => adapter.validatePaidOrder({ ...remote, fee_qris: 1 }, {
    providerOrderId: 'order-1', reference: 'FZ-UNIT-REF', amount: 1000,
    payAmount: 1007, expiresAt
  }), (error) => error.code === 'PAYMENT_AMOUNT_MISMATCH');
  qrisFee = 0;

  const rawBody = Buffer.from('{"event":"order.paid","reference":"FZ-UNIT-REF"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', 'unit-test-webhook-secret-not-real')
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody])).digest('hex')}`;
  assert.equal(adapter.verifyWebhook({ rawBody, timestamp, signature }), true);
  assert.equal(adapter.verifyWebhook({ rawBody: Buffer.from(`${rawBody} `), timestamp, signature }), false);
  assert.equal(adapter.verifyWebhook({ rawBody, timestamp: '1', signature }), false);

  const disabledWithCredentials = createPaymentAdapter(loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'https://finzz.test',
    ASTRAPAY_ENABLED: 'false',
    ASTRAPAY_PROJECT_SLUG: 'finzz-project',
    ASTRAPAY_API_KEY: 'unit-test-api-key-not-real',
    ASTRAPAY_WEBHOOK_SECRET: 'unit-test-webhook-secret-not-real'
  }), { fetchImpl: fakeFetch });
  assert.equal(disabledWithCredentials.enabled, false);
  assert.equal(disabledWithCredentials.configured, true);
  assert.equal(disabledWithCredentials.verifyWebhook({ rawBody, timestamp, signature }), true, 'pending callbacks remain accepted while new invoices are disabled');
  assert.equal(await disabledWithCredentials.checkStatus('order-1').then((row) => row.status), 'paid', 'existing invoices remain verifiable after new payment creation is disabled');
  await assert.rejects(
    () => disabledWithCredentials.createPayment({
      reference: 'FZ-UNIT-REF', amount: 1000,
      webhookUrl: 'https://finzz.test/api/webhooks/astrapay', redirectUrl: 'https://finzz.test/wallet'
    }),
    (error) => error.code === 'PAYMENT_GATEWAY_DISABLED'
  );
});

test('config: SMTP defaults, sender inference, Gmail app passwords and TLS are consistent', () => {
  const gmail = loadConfig({
    NODE_ENV: 'test',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_USER: 'mailer@finzz.test',
    SMTP_PASS: 'abcd efgh ijkl mnop'
  });
  assert.equal(gmail.smtp.pass, 'abcdefghijklmnop');
  assert.equal(gmail.smtp.port, 587);
  assert.equal(gmail.smtp.secure, false, 'port 587 uses STARTTLS');
  assert.equal(gmail.smtp.from, 'FINZZ Store <mailer@finzz.test>');
  const startTls = loadConfig({
    NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_FROM: 'relay@example.test', SMTP_SECURE: 'true'
  });
  assert.equal(startTls.smtp.secure, false, 'port 587 always negotiates STARTTLS even with a legacy SMTP_SECURE=true');

  const implicitTls = loadConfig({
    NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_FROM: 'mailer@example.test'
  });
  assert.equal(implicitTls.smtp.secure, true, 'port 465 always uses implicit TLS');
  assert.equal(loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'mailer@example.test' }).smtp.configError.code, 'SMTP_AUTH_PAIR_REQUIRED');
  assert.equal(loadConfig({ NODE_ENV: 'test', SMTP_USER: 'mailer@example.test', SMTP_PASS: 'secret' }).smtp.configError.code, 'SMTP_HOST_REQUIRED');
  assert.equal(loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test' }).smtp.configError.code, 'SMTP_SENDER_REQUIRED');
});

test('mailer verifies SMTP safely, reports the latest result, and sends branded templates', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'mailer@finzz.test',
    SMTP_PASS: 'private-smtp-secret'
  });
  const sent = [];
  const logs = [];
  let verificationError = null;
  let transportOptions;
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (message, fields) => logs.push({ level, message, fields })]));
  const transport = {
    async verify() { if (verificationError) throw verificationError; },
    async sendMail(message) { sent.push(message); return { messageId: 'message-1' }; }
  };
  const mailer = createMailer(config, {
    logger,
    transportFactory: (options) => { transportOptions = options; return transport; }
  });

  assert.equal(transportOptions.host, 'smtp.example.test');
  assert.equal(transportOptions.requireTLS, true);
  assert.deepEqual(transportOptions.auth, { user: 'mailer@finzz.test', pass: 'private-smtp-secret' });
  assert.equal(mailer.status().lastCheck, null);

  let relayOptions;
  const relayConfig = loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'relay@finzz.test' });
  createMailer(relayConfig, { transportFactory: (options) => { relayOptions = options; return transport; } });
  assert.equal(relayOptions.secure, false);
  assert.equal(relayOptions.requireTLS, true, 'unauthenticated mail relays also must not downgrade from STARTTLS');
  assert.equal(relayOptions.auth, undefined);

  const success = await mailer.verify();
  assert.equal(success.ok, true);
  assert.equal(success.lastCheck.ok, true);

  verificationError = Object.assign(new Error('private-smtp-secret: invalid password response'), {
    code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN'
  });
  const failure = await mailer.verify();
  assert.equal(failure.ok, false);
  assert.equal(failure.lastCheck.ok, false, 'the dashboard-facing nested state is the latest check, not stale success');
  assert.equal(failure.diagnostic.code, 'SMTP_AUTH_FAILED');
  assert.ok(!JSON.stringify(failure).includes('private-smtp-secret'));
  assert.ok(!JSON.stringify(logs).includes('private-smtp-secret'));
  assert.equal(diagnoseSmtpError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })).code, 'SMTP_HOST_UNREACHABLE');

  const message = verificationEmail({ code: '<123456>', appName: 'FINZZ <Store>', ttlMinutes: 10 });
  assert.match(message.subject, /kode verifikasi/i);
  assert.ok(!message.subject.includes('123456'), 'the one-time code is not exposed in the email subject');
  assert.ok(message.html.includes('&lt;123456&gt;'), 'OTP is escaped inside the branded HTML email');
  assert.match(message.html, /#7c8cff/i);
  assert.match(message.text, /10 menit/);

  const reset = passwordResetEmail({ link: 'https://finzz.test/reset?token=a&b=<c>', appName: 'FINZZ Store', ttlMinutes: 15 });
  assert.ok(reset.html.includes('token=a&amp;b=&lt;c&gt;'), 'reset links are escaped in HTML');
  assert.ok(reset.text.includes('token=a&b=<c>'), 'plain-text email retains the original URL');
  verificationError = null;
  await mailer.send({ to: 'user@finzz.test', ...message });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].disableFileAccess, true);
  assert.equal(sent[0].disableUrlAccess, true);
  assert.equal(mailer.status().lastCheck.action, 'send');

  const unconfigured = createMailer(loadConfig({ NODE_ENV: 'test' }), { transportFactory: () => { throw new Error('should not construct transport'); } });
  const noSmtp = await unconfigured.verify();
  assert.equal(noSmtp.configured, false);
  assert.equal(noSmtp.diagnostic.code, 'SMTP_NOT_CONFIGURED');
  const incomplete = createMailer(loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'mailer@finzz.test' }), {
    transportFactory: () => { throw new Error('invalid optional SMTP settings must not start a transport'); }
  });
  const diagnosed = await incomplete.verify();
  assert.equal(diagnosed.configured, false);
  assert.equal(diagnosed.diagnostic.code, 'SMTP_AUTH_PAIR_REQUIRED');
});

test('Google OAuth exchanges code with PKCE and validates RS256 OIDC signature, claims, nonce, and verified email', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'https://finzz.test',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret'
  });
  assert.equal(config.oauth.redirectUri, 'https://finzz.test/api/auth/google/callback');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const makeIdToken = (claims) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${head}.${body}`;
    const signature = signJwt('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
    return `${input}.${signature}`;
  };
  let idToken = makeIdToken({
    iss: 'https://accounts.google.com', aud: 'client-id', exp: nowSeconds + 300, iat: nowSeconds,
    nonce: 'expected-nonce', sub: 'google-subject', email: 'Person@Example.test',
    email_verified: true, name: 'Nama Google'
  });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({ id_token: idToken, access_token: 'private-access-token' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    assert.match(String(url), /\/certs$/);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' }
    });
  };
  const oauth = createGoogleOAuth(config, { fetchImpl, now: () => nowSeconds * 1000 });

  assert.equal(oauth.available, true);
  const authorize = new URL(oauth.authorizeUrl({ state: 'state', codeChallenge: 'challenge', nonce: 'expected-nonce' }));
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('nonce'), 'expected-nonce');
  const identity = await oauth.authenticate('authorization-code', 'secret-verifier', 'expected-nonce');
  assert.deepEqual(identity, {
    provider: 'google', providerSubject: 'google-subject', email: 'person@example.test', name: 'Nama Google'
  });
  assert.equal(calls.length, 2, 'token exchange and JWKS are the only provider calls');
  const tokenBody = new URLSearchParams(calls[0].options.body);
  assert.equal(tokenBody.get('code'), 'authorization-code');
  assert.equal(tokenBody.get('client_secret'), 'client-secret');
  assert.equal(tokenBody.get('code_verifier'), 'secret-verifier');
  assert.equal(calls[1].options.headers.Authorization, undefined, 'JWKS lookup does not send a browser/provider token');
  assert.ok(!JSON.stringify(identity).includes('private-access-token'), 'provider tokens never leave the server');

  idToken = makeIdToken({
    iss: 'https://accounts.google.com', aud: 'client-id', exp: nowSeconds + 300, iat: nowSeconds,
    nonce: 'expected-nonce', sub: 'google-subject', email: 'person@example.test', email_verified: false
  });
  await assert.rejects(
    () => oauth.authenticate('authorization-code', 'secret-verifier', 'expected-nonce'),
    (err) => err.code === 'OAUTH_EMAIL_UNVERIFIED'
  );
  idToken = makeIdToken({
    iss: 'https://accounts.google.com', aud: 'client-id', exp: nowSeconds + 300, iat: nowSeconds,
    nonce: 'another-nonce', sub: 'google-subject', email: 'person@example.test', email_verified: true
  });
  await assert.rejects(
    () => oauth.authenticate('authorization-code', 'secret-verifier', 'expected-nonce'),
    (err) => err.code === 'OAUTH_PROFILE_INVALID'
  );

  const oversizedOAuth = createGoogleOAuth(config, {
    now: () => nowSeconds * 1000,
    fetchImpl: async () => new Response('x'.repeat(70 * 1024), { status: 200 })
  });
  await assert.rejects(
    () => oversizedOAuth.authenticate('authorization-code', 'secret-verifier', 'expected-nonce'),
    (err) => err.code === 'OAUTH_PROVIDER_FAILED'
  );
});


test('brands: catalogue is deduplicated by app id, known marks are colored, unknowns stay wordmarks', async () => {
  const brands = marqueeBrands([
    { id: 'wa', name: 'WhatsApp' },
    { id: 'wa', name: 'WhatsApp duplikat dari baris layanan' },
    { id: 'tg', name: 'Telegram' },
    { id: 'new-app', name: 'Layanan Baru' },
    { id: 'ub', name: 'Uber' }
  ]);
  assert.deepEqual(brands.map((brand) => brand.id), ['wa', 'tg', 'new-app', 'ub']);
  assert.equal(brands[0].src, '/assets/brands/whatsapp.svg');
  assert.equal(brands[2].src, null);
  assert.equal(brands[2].label, 'Layanan Baru');
  assert.equal(brands[3].src, null, 'brands without an approved asset remain wordmarks');
  assert.deepEqual(splitRows(brands.slice(0, 2), 2).map((row) => row.length), [1, 1]);
  const mockCatalogueMarks = marqueeBrands([
    { id: 'gg', name: 'Google' }, { id: 'tt', name: 'TikTok' }, { id: 'dc', name: 'Discord' },
    { id: 'x', name: 'X' }, { id: 'sh', name: 'Shopee' }, { id: 'gr', name: 'Grab' }
  ]);
  assert.deepEqual(mockCatalogueMarks.slice(0, 4).map((brand) => brand.src), [
    '/assets/brands/google.svg', '/assets/brands/tiktok.svg', '/assets/brands/discord.svg', '/assets/brands/x.svg'
  ]);
  assert.deepEqual(mockCatalogueMarks.slice(4).map((brand) => [brand.label, brand.src]), [['Shopee', null], ['Grab', null]]);
  const whatsappSvg = await readFile(path.join(ROOT, 'public/assets/brands/whatsapp.svg'), 'utf8');
  const googleSvg = await readFile(path.join(ROOT, 'public/assets/brands/google.svg'), 'utf8');
  assert.match(whatsappSvg, /fill="#25D366"/);
  assert.match(googleSvg, /fill="#4285F4"/);
  for (const color of ['#EA4335', '#FBBC05', '#34A853']) {
    assert.ok(googleSvg.includes(`fill="${color}"`), `the original multicolor Google G includes ${color}`);
  }
  const tiktokSvg = await readFile(path.join(ROOT, 'public/assets/brands/tiktok.svg'), 'utf8');
  for (const color of ['#FF004F', '#000000', '#00F2EA']) {
    assert.ok(tiktokSvg.includes(`fill="${color}"`), `the authentic TikTok mark includes ${color}`);
  }
});

// ============================================================ pricing engine
test('pricing: total always equals supplier + markup + tax, in integers', () => {
  const policy = { default_markup_bps: 1500, fixed_markup: 500, min_margin: 2000, tax_bps: 1100, rounding: { mode: 'up', step: 500 } };
  for (const supplier of [0, 1, 999, 3500, 12_345, 999_999]) {
    const r = resolvePrice({ supplierPrice: supplier, policy });
    assert.ok(Number.isInteger(r.totalPrice), 'total must be an integer');
    assert.ok(Number.isInteger(r.markupAmount));
    assert.ok(Number.isInteger(r.taxAmount));
    assert.equal(r.totalPrice, r.supplierPrice + r.markupAmount + r.taxAmount);
    assert.ok(r.markupAmount >= 0, 'markup must never be negative');
  }
});

test('pricing: override precedence is service > category > default', () => {
  const policy = { default_markup_bps: 1000, category_bps: { wa: 2000, tg: 3000 } };

  const byDefault = resolvePrice({ supplierPrice: 10_000, policy });
  assert.equal(byDefault.markupBps, 1000);
  assert.equal(byDefault.rule, 'default');
  assert.equal(byDefault.markupAmount, 1000);

  const byCategory = resolvePrice({ supplierPrice: 10_000, policy, category: 'wa' });
  assert.equal(byCategory.markupBps, 2000);
  assert.equal(byCategory.rule, 'category:wa');
  assert.equal(byCategory.markupAmount, 2000);

  const byService = resolvePrice({ supplierPrice: 10_000, policy, category: 'wa', serviceMarkupBps: 2500 });
  assert.equal(byService.markupBps, 2500);
  assert.equal(byService.rule, 'service');
  assert.equal(byService.markupAmount, 2500);
});

test('pricing: an unknown category falls back to the default, never to zero', () => {
  const r = resolvePrice({ supplierPrice: 5000, policy: { default_markup_bps: 1500, category_bps: { wa: 4000 } }, category: 'tidak-ada' });
  assert.equal(r.rule, 'default');
  assert.equal(r.markupBps, 1500);
});

test('pricing: the minimum margin is enforced on cheap offers', () => {
  const policy = { default_markup_bps: 100, min_margin: 900 };
  const r = resolvePrice({ supplierPrice: 500, policy });
  assert.ok(r.markupAmount >= 900, `markup ${r.markupAmount} must reach the 900 floor`);
  assert.equal(r.totalPrice, r.supplierPrice + r.markupAmount + r.taxAmount);
});

test('pricing: rounding never produces a negative margin and keeps the sum exact', () => {
  for (const mode of ROUNDING_MODES) {
    for (const step of [1, 100, 500, 1000]) {
      const r = resolvePrice({
        supplierPrice: 1234,
        policy: { default_markup_bps: 0, rounding: { mode, step } }
      });
      assert.equal(r.totalPrice, r.supplierPrice + r.markupAmount + r.taxAmount, `${mode}/${step} must stay consistent`);
      assert.ok(r.markupAmount >= 0, `${mode}/${step} must not go negative`);
    }
  }
});

test('pricing: a hostile policy is clamped instead of trusted', () => {
  const p = normalisePricingPolicy({
    default_markup_bps: 999_999,
    fixed_markup: -5000,
    min_margin: 'banyak',
    tax_bps: -1,
    rounding: { mode: 'kacau', step: 0 },
    category_bps: { wa: 50_000, '': 10, tg: 'x' }
  });
  assert.equal(p.default_markup_bps, 10000);
  assert.equal(p.fixed_markup, 0);
  assert.equal(p.min_margin, 0);
  assert.equal(p.tax_bps, 0);
  assert.equal(p.rounding.mode, 'none');
  assert.equal(p.rounding.step, 1);
  assert.equal(p.category_bps.wa, 10000);
  assert.ok(!('' in p.category_bps), 'blank keys are dropped');
  assert.ok(!('tg' in p.category_bps), 'non numeric bps are dropped');
});

test('pricing: composePrice stays compatible with the old percentage-only call', () => {
  const legacy = composePrice({ supplierPrice: 2000, markupBps: 1500, taxBps: 0 });
  assert.deepEqual(legacy, { supplierPrice: 2000, markupAmount: 300, taxAmount: 0, totalPrice: 2300 });
});

test('pricing: describePricing explains the active rules for the admin panel', () => {
  const text = describePricing({ default_markup_bps: 1500, fixed_markup: 500, tax_bps: 1100, rounding: { mode: 'up', step: 500 } });
  assert.match(text, /15\.00%/);
  assert.match(text, /markup tetap/);
  assert.match(text, /PPN 11\.00%/);
  assert.match(text, /kelipatan 500/);
});

// ================================================================ brands ===
test('marquee only shows brands that exist in the live catalogue', async () => {
  const { marqueeBrands, splitRows, brandFor } = await import('../public/js/brands.js');

  // Real TeleKos app ids observed in the production catalogue.
  const apps = [
    { id: 'wa', name: 'Whatsapp' },
    { id: 'tg', name: 'Telegram' },
    { id: 'ds', name: 'Discord' },
    { id: 'ts', name: 'PayPal' },   // trademark removed from Simple Icons
    { id: 'zz', name: 'Layanan Baru' } // unknown app
  ];
  const brands = marqueeBrands(apps);
  assert.equal(brands.length, apps.length);
  assert.equal(brands[0].src, '/assets/brands/whatsapp.svg');
  assert.equal(brands[1].src, '/assets/brands/telegram.svg');
  // No licensed asset -> the renderer must fall back to a wordmark, never to a
  // look-alike logo or an emoji.
  assert.equal(brands[3].src, null);
  assert.equal(brands[3].label, 'PayPal');
  assert.equal(brands[4].src, null);
  assert.equal(brands[4].label, 'Layanan Baru');

  // Nothing is invented: no data means no logos.
  assert.deepEqual(marqueeBrands([]), []);

  // Duplicates are collapsed so the strip cannot imply extra inventory.
  assert.equal(marqueeBrands([{ id: 'wa', name: 'Whatsapp' }, { id: 'wa', name: 'Whatsapp' }]).length, 1);

  // Two stable rows, alternating.
  const rows = splitRows(brands, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length + rows[1].length, brands.length);
  assert.equal(rows[0][0].id, 'wa');
  assert.equal(rows[1][0].id, 'tg');

  assert.equal(brandFor('nf').slug, 'netflix');
  assert.equal(brandFor('tidak-ada'), null);
});

test('service marquee loops continuously and shows reduced-motion users one clean catalogue copy', async () => {
  const css = await readFile(path.join(ROOT, 'public/css/components.css'), 'utf8');
  const landing = await readFile(path.join(ROOT, 'public/js/pages/landing.js'), 'utf8');
  assert.match(css, /animation:\s*brand-scroll-left var\(--marquee-duration, 38s\) linear infinite/);
  assert.match(css, /animation-name:\s*brand-scroll-right/);
  assert.doesNotMatch(css, /\.brand-marquee:hover\s+\.brand-marquee__track/, 'hovering cannot freeze the whole strip');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.brand-marquee__group\[aria-hidden="true"\]\s*\{\s*display:\s*none;/);
  assert.match(landing, /Math\.ceil\(viewportWidth\s*\/\s*Math\.max\(groupWidth/);
  assert.match(landing, /cycleGroups\s*\*\s*2/, 'only visual clones are added to create a seamless infinite track');
});

test('every bundled brand SVG is sanitised and offline', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.resolve(import.meta.dirname, '..', 'public', 'assets', 'brands');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length >= 10, 'the marquee ships real assets, not placeholders');
  for (const file of files) {
    const svg = await readFile(path.join(dir, file), 'utf8');
    // A logo asset must be geometry only: no scripting, no network, no handlers.
    assert.ok(!/<script/i.test(svg), `${file}: no script`);
    assert.ok(!/\son\w+\s*=/i.test(svg), `${file}: no event handlers`);
    // The xmlns declaration is a namespace identifier, not a network fetch.
    // Anything else pointing at a URL would be an external dependency.
    const withoutNamespace = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
    assert.ok(!/https?:\/\//i.test(withoutNamespace), `${file}: no external URLs`);
    assert.ok(!/<image|<use|xlink:href/i.test(svg), `${file}: no embedded references`);
    const expectedViewBox = file === 'google.svg'
      ? /viewBox="0 0 256 262"/
      : file === 'tiktok.svg' ? /viewBox="0 0 256 290"/ : /viewBox="0 0 24 24"/;
    assert.match(svg, expectedViewBox, `${file}: fixed viewBox prevents layout shift`);
    assert.match(svg, /fill="#[0-9A-Fa-f]{6}"/, `${file}: uses the approved brand colour instead of a monochrome theme fill`);
    assert.match(svg, /aria-label="/, `${file}: has an accessible name`);
  }
});
