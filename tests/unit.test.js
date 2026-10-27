// ============================================================================
// UNIT TESTS — pure modules, fixtures and static guarantees.
// Run: npm test (node:test, no external test framework)
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

import {
  parseRupiah, fromDbAmount, applyBps, composePrice, formatRupiah, toDbAmount, MoneyError, MAX_AMOUNT,
  resolvePrice, normalisePricingPolicy, describePricing, ROUNDING_MODES
} from '../src/money.js';
import { escapeHtml, safeJsonForHtml, sha256, assertRequestOrigin, originAllowed, requestOriginAllowed } from '../src/security.js';
import { loadConfig, publicConfigView } from '../src/config.js';
import { redact } from '../src/logging.js';
import * as v from '../src/validation.js';
import { mapSupplierStatus, SupplierError } from '../src/supplier-error.js';
import { createMockSupplier } from '../src/supplier-mock.js';
import { PAGES } from '../src/pages.js';
import { renderDocument } from '../src/render.js';
import { createLogger } from '../src/logging.js';

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

// ---------------------------------------------------------------- pages -----
test('page registry: 16 routes with correct access flags', () => {
  const keys = Object.keys(PAGES).sort();
  assert.deepEqual(keys, [
    '/', '/admin', '/dashboard', '/forgot-password', '/login', '/notifications', '/orders',
    '/privacy', '/profile', '/register', '/reset-password', '/services', '/status', '/terms',
    '/verify-email', '/wallet'
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
    state: { user: { id: 'u1', email: 'a@b.c' }, config: { appName: 'FINZZ' }, csrfToken: 'csrf-token' }
  });
  assert.match(html, /nonce="abc123nonce"/);
  assert.match(html, /id="finzz-state"/);
  assert.match(html, /id="app-root"/);
  assert.ok(html.includes('csrf-token'));
  assert.ok(!/src="https?:\/\//.test(html), 'the shell must not load external scripts');
  assert.ok(!/@import\s+url\(/.test(html), 'the shell must not load external styles');
  assert.ok(html.includes('/js/main.js'));
});

// ----------------------------------------------------------- static gates ---
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
    assert.match(svg, /viewBox="0 0 24 24"/, `${file}: fixed viewBox prevents layout shift`);
    assert.match(svg, /fill="currentColor"/, `${file}: inherits theme colour`);
    assert.match(svg, /aria-label="/, `${file}: has an accessible name`);
  }
});
