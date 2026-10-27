// ============================================================================
// UI TESTS — every page module is rendered against a real DOM (linkedom) with
// deterministic API fixtures. Catches import errors, undefined access and
// missing loading / unavailable states without a browser.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, installFetch, FIXTURES, catalogFixture } from './support/dom-env.mjs';
import { turnstileConfig } from '../public/js/turnstile.js';

const page = (name) => import(`../public/js/pages/${name}.js`).then((m) => m.default);

test('Turnstile public settings are read from the real /api/public/config app envelope', () => {
  assert.deepEqual(
    turnstileConfig({ app: { turnstile: { enabled: true, siteKey: 'public-key' } } }),
    { enabled: true, siteKey: 'public-key' }
  );
  assert.deepEqual(turnstileConfig({ app: { turnstile: { enabled: false, siteKey: '' } } }), { enabled: false, siteKey: '' });
});

const walletFixture = () => ({
  balance: 96780,
  currency: 'IDR',
  updatedAt: new Date().toISOString(),
  transactions: [
    {
      id: 't1', type: 'purchase', label: 'Pembelian nokos', direction: 'debit',
      amount: 2530, balanceAfter: 96780, referenceType: 'order',
      referenceId: FIXTURES.order.id, description: null, createdAt: new Date().toISOString()
    }
  ],
  pagination: { page: 1, perPage: 15, total: 1, pages: 1 },
  activeOrders: [{ ...FIXTURES.order, otp: undefined }],
  deposits: [{ id: 'd1', amount: 25000, approvedAmount: 25000, status: 'approved', note: null, adminNote: 'OK', createdAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), hasProof: true }],
  pendingDepositCount: 0,
  depositPolicy: { ...FIXTURES.config.deposit },
  refundPolicy: FIXTURES.config.refundPolicy,
  paymentGateway: { enabled: false, message: 'Pembayaran otomatis belum aktif.' }
});

const adminDashboard = () => ({
  generated_at: new Date().toISOString(),
  users: { total: 12, active: 11, suspended: 1, admins: 2 },
  orders: { total: 40, today: 5, active: 2, completed: 31, refunded: 3, needs_review: 1 },
  finance: {
    gross_revenue: 750000, supplier_cost: 600000, net_profit: 150000, refunded_total: 2530,
    deposits_approved: 300000, deposits_pending_count: 1, deposits_pending_amount: 25000, wallet_liability: 120000
  },
  recent_orders: [{ id: FIXTURES.order.id, status: 'completed', total_price: 2530, created_at: new Date().toISOString(), email: 'user@finzz.test' }],
  supplier: { mode: 'mock', configured: true, mock: true, requests: 12, failures: 0, rateLimit: { limit: 60, remaining: 60 }, lastError: null },
  catalog: { lastResult: { status: 'success', upserted: 193, deactivated: 0 }, lastRunAt: new Date().toISOString() },
  jobs: {
    poller: { ticks: 10, processed: 8, failures: 0 },
    reconciliation: { runs: 3, orphaned: 0 }
  },
  payment: { enabled: false, mode: 'disabled', message: 'Pembayaran otomatis belum aktif.' }
});

function baseRoutes(extra = []) {
  const fetchedAt = new Date().toISOString();
  const cache = { source: 'mock', fetchedAt, ageSeconds: 0, fresh: true, stale: false, cacheHit: false, refreshRequested: false, refreshInProgress: false, lastError: null };
  return [
    { match: '/api/public/config', body: FIXTURES.config },
    { match: '/api/public/catalog/servers', body: { servers: [{ id: 'server1', name: 'Server 1', available: true, maintenance: false }], cache } },
    { match: '/api/public/catalog/apps', body: { serverId: 'server1', apps: [{ id: 'wa', name: 'WhatsApp' }, { id: 'tg', name: 'Telegram' }], cache } },
    { match: '/api/public/catalog/countries', body: { serverId: 'server1', appId: 'wa', countries: [
      { id: 6, name: 'Indonesia', iso: 'ID', callingCode: '+62', stock: 50 },
      { id: 7, name: 'Malaysia', iso: 'MY', callingCode: '+60', stock: 0 }
    ], cache } },
    { match: '/api/public/catalog/prices', body: ({ path }) => {
      const query = new URL(`http://localhost${path}`).searchParams;
      const app = query.get('app');
      const country = Number(query.get('country'));
      const offers = app === 'tg'
        ? [{ id: 'tg-low', offerId: 'offer-tg-low', salePrice: 900, currency: 'IDR', stock: 50 }]
        : country === 7
          ? [{ id: 'wa-empty', offerId: 'offer-wa-empty', salePrice: 1200, currency: 'IDR', stock: 0 }]
          : [
              { id: 'wa-high', offerId: 'offer-wa-high', salePrice: 2500, currency: 'IDR', stock: 100 },
              { id: 'wa-low', offerId: 'offer-wa-low', salePrice: 1000, currency: 'IDR', stock: 20 }
            ];
      return {
        server: { id: 'server1', name: 'Server 1', available: true, maintenance: false },
        app: { id: app || 'wa', name: app === 'tg' ? 'Telegram' : 'WhatsApp' },
        country: { id: country || 6, name: country === 7 ? 'Malaysia' : 'Indonesia', iso: country === 7 ? 'MY' : 'ID', callingCode: country === 7 ? '+60' : '+62', stock: country === 7 ? 0 : 50 },
        offers, quotedAt: fetchedAt, cache
      };
    } },
    { match: '/api/public/catalog', body: catalogFixture() },
    { match: '/api/public/quote', body: { price: 2530, stock: 4820, quotedAt: new Date().toISOString(), live: false, source: 'mock', cache: { source: 'mock', fresh: true, stale: false, fetchedAt, ageSeconds: 0 }, server: 'server1' } },
    {
      match: '/api/health',
      body: {
        ok: true, time: new Date().toISOString(), latencyMs: 3, version: '2.0.0', environment: 'test',
        database: { driver: 'pg', ok: true, latencyMs: 2 },
        supplier: { mode: 'mock', configured: true, mock: true, contractVerified: false, webhookConfigured: true, lastError: null },
        payment: { enabled: false, mode: 'disabled' },
        jobs: { poller: { ticks: 4, processed: 2, failures: 0 }, reconciliation: { runs: 1 } }
      }
    },
    { match: '/api/auth/reset-password/validate', body: { valid: true, expiresAt: new Date(Date.now() + 600000).toISOString() } },
    {
      match: '/api/auth/verification-context',
      body: {
        present: true, active: true, expired: false, consumed: false, alreadyVerified: false,
        emailMasked: 'u***r@finzz.test', expiresAt: new Date(Date.now() + 1800000).toISOString(),
        lastSentAt: new Date().toISOString(), emailSent: true, deliveryProblem: null,
        resendAt: new Date(Date.now() + 45000).toISOString(), resendCount: 0, resendCooldownSeconds: 60
      }
    },
    { match: '/api/wallet', body: walletFixture() },
    {
      match: '/api/notifications',
      body: {
        notifications: [
          { id: 2, type: 'order.waiting', severity: 'info', title: 'Nomor sudah terbit', body: 'Nomor virtual untuk WhatsApp Indonesia sudah aktif.', orderId: FIXTURES.order.id, depositId: null, meta: {}, readAt: null, createdAt: new Date().toISOString() },
          { id: 1, type: 'deposit.approved', severity: 'success', title: 'Deposit disetujui', body: 'Deposit Rp25.000 sudah masuk ke saldo Anda.', orderId: null, depositId: 'd1', meta: { amount: 25000 }, readAt: new Date().toISOString(), createdAt: new Date(Date.now() - 3600_000).toISOString() }
        ],
        unreadCount: 1,
        total: 2,
        pagination: { page: 1, perPage: 20, total: 2, pages: 1 }
      }
    },
    { match: '/api/orders/active', body: { orders: [{ ...FIXTURES.order }] } },
    { match: /^\/api\/orders\/[^/]+\/events/, body: { events: [{ type: 'supplier_state', from: 'pending', to: 'waiting', source: 'supplier', message: 'Nomor diterbitkan', at: new Date().toISOString() }] } },
    { match: /^\/api\/orders\/[^/?]+$/, body: { order: { ...FIXTURES.order } } },
    { match: '/api/orders', body: { orders: [{ ...FIXTURES.order }], pagination: { page: 1, perPage: 12, total: 1, pages: 1 } } },
    { match: '/api/deposits', body: { deposits: [], pagination: { page: 1, perPage: 10, total: 0, pages: 1 } } },
    { match: '/api/auth/identities', body: { loginMethods: { passwordEnabled: true, identities: [] } } },
    {
      match: '/api/profile',
      body: {
        profile: { id: 'u1', email: 'user@finzz.test', username: 'user1', fullName: 'User Satu', phone: '0812', role: 'admin', status: 'active', emailVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString() },
        session: { createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ip: '127.0.0.1', userAgent: 'node-test' }
      }
    },
    { match: '/api/admin/dashboard', body: adminDashboard() },
    { match: '/api/admin/deposits', body: { deposits: [{ ...walletFixture().deposits[0], user: { id: 'u1', email: 'user@finzz.test' }, userNote: 'Transfer BCA' }], pagination: { page: 1, perPage: 20, total: 1, pages: 1 } } },
    { match: '/api/admin/orders', body: { orders: [{ ...FIXTURES.order, user: { id: 'u1', email: 'user@finzz.test' } }], pagination: { page: 1, perPage: 25, total: 1, pages: 1 } } },
    { match: '/api/admin/users', body: { users: [{ id: 'u1', email: 'user@finzz.test', username: 'user1', fullName: 'User Satu', role: 'admin', status: 'active', balance: 96780, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }], pagination: { page: 1, perPage: 20, total: 1, pages: 1 } } },
    { match: '/api/admin/services', body: { services: [{ id: FIXTURES.service.id, code: FIXTURES.service.code, name: FIXTURES.service.name, appName: 'WhatsApp', countryName: 'Indonesia', server: 'server1', supplierPrice: 2200, price: 2530, markupBps: 1500, stock: 4820, active: true, syncedAt: new Date().toISOString() }], total: 1, lastSync: { startedAt: new Date().toISOString(), status: 'success', upserted: 193, error: null } } },
    { match: '/api/admin/audit', body: { entries: [{ id: 1, action: 'wallet.adjustment', targetType: 'wallet', targetId: 'u1', reason: 'Kompensasi', before: null, after: {}, ip: '127.0.0.1', admin: { id: 'a1', email: 'admin@finzz.test' }, createdAt: new Date().toISOString() }], pagination: { page: 1, perPage: 30, total: 1, pages: 1 } } },
    {
      match: '/api/admin/settings',
      body: {
        settings: {
          store_profile: { name: 'FINZZ Store', tagline: 'Nomor virtual', support_email: 'support@finzz.store', support_whatsapp: '', support_telegram: '' },
          deposit_policy: { min_amount: 1000, max_amount: 5000000, instructions: 'Transfer', bank_accounts: [{ bank_name: 'BCA', account_number: '123', account_holder: 'PT FINZZ' }], expiry_hours: 24 },
          pricing_policy: { default_markup_bps: 1500, tax_bps: 0, tax_label: 'PPN' },
          operations: { sales_open: true, maintenance_message: '', order_poll_interval_ms: 4000, server_poll_interval_ms: 15000, order_expiry_seconds: 1260, max_active_orders_per_user: 5 },
          refund_policy: { summary: 'Refund bila OTP tidak diterima.' },
          legal: { terms_version: '2026-10-01', privacy_version: '2026-10-01' },
          supplier: { provider: 'telekos', server: 'server1', app_allowlist: [], sync_enabled: true }
        },
        payment: { enabled: false, mode: 'disabled', provider: null, message: 'Pembayaran otomatis belum aktif.' }
      }
    },
    ...extra
  ];
}

function makeCtx({ user = { id: 'u1', email: 'user@finzz.test', role: 'admin' }, pathname = '/', search = '', api, publicSettings = FIXTURES.config, config = FIXTURES.config } = {}) {
  const { createStore } = globalThis.__finzzStore;
  const store = createStore({
    user,
    config,
    csrfToken: 'csrf-token',
    publicSettings,
    balance: 96780,
    theme: 'dark'
  });
  const navigations = [];
  const toasts = [];
  return {
    api,
    store,
    navigate: (path) => navigations.push(path),
    layout: globalThis.__finzzLayout(store, (path) => navigations.push(path)),
    toast: (options) => toasts.push(options),
    refreshSession: async () => user,
    refreshBalance: async () => 96780,
    ApiError: globalThis.__finzzApiError,
    loadPublicSettings: async () => publicSettings,
    key: pathname === '/' ? 'landing' : pathname.slice(1),
    query: new URLSearchParams(search),
    pathname,
    __navigations: navigations,
    __toasts: toasts
  };
}

function assertNoVisibleNullText(root, label) {
  const matches = [];
  const visit = (node) => {
    if (node.nodeType === 3 && /\bnull\b/i.test(node.nodeValue || '')) matches.push(node.nodeValue.trim());
    for (const child of Array.from(node.childNodes || [])) visit(child);
  };
  visit(root);
  assert.deepEqual(matches, [], `${label} must not render a visible null text node`);
}

test.before?.(() => {});

test('page modules render against a DOM with fixtures', async () => {
  setupDom();
  const { createApi, ApiError } = await import('../public/js/api.js');
  const { createStore } = await import('../public/js/store.js');
  const { createLayout } = await import('../public/js/layout.js');
  globalThis.__finzzStore = { createStore };
  globalThis.__finzzApiError = ApiError;
  globalThis.__finzzLayout = (store, navigate) =>
    createLayout({ store, navigate, getTheme: () => 'dark', onToggleTheme: () => {}, onLogout: async () => {} });

  const fetcher = installFetch(baseRoutes());
  const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  try {
    // ------------------------------------------------------------------ login
    {
      const ctx = makeCtx({ api, user: null, pathname: '/login', config: { ...FIXTURES.config, demoAccounts: null } });
      const rendered = await (await page('login'))(ctx);
      assertNoVisibleNullText(rendered.node, 'login with no demo accounts or OAuth settings');
      assert.equal(rendered.node.querySelector('.oauth-login__button'), null, 'Google sign-in is hidden when OAuth is not configured');
      const password = rendered.node.querySelector('input[name="password"]');
      const visibilityToggle = rendered.node.querySelector('.auth-password__toggle');
      assert.equal(password.type, 'password');
      visibilityToggle.dispatchEvent(new Event('click', { bubbles: true }));
      assert.equal(password.type, 'text', 'the password can be revealed');
      assert.equal(visibilityToggle.getAttribute('aria-pressed'), 'true');
      visibilityToggle.dispatchEvent(new Event('click', { bubbles: true }));
      assert.equal(password.type, 'password', 'the password can be hidden again');
      assert.match(rendered.node.querySelector('.auth-side--showcase').textContent, /Akun terlindungi/);
      const headerMark = rendered.node.querySelector('.topbar .brand__mark svg')?.outerHTML;
      const footerMark = ctx.layout.footer().querySelector('.brand__mark svg')?.outerHTML;
      assert.ok(headerMark && footerMark);
      assert.equal(headerMark, footerMark, 'header and footer share the redesigned FINZZ mark');
      assert.match(headerMark, /stroke="#7c8cff"/);
      assert.match(headerMark, /stroke="#2ee6b6"/);
      rendered.cleanup?.();
    }
    {
      const publicSettings = {
        ...FIXTURES.config,
        app: { ...FIXTURES.config.app, turnstile: { enabled: false, siteKey: '' }, oauth: { google: true } }
      };
      const ctx = makeCtx({ api, user: null, pathname: '/login', search: 'oauth=denied&next=%2Fwallet', publicSettings });
      const rendered = await (await page('login'))(ctx);
      const googleButton = rendered.node.querySelector('.oauth-login__button');
      assert.ok(googleButton, 'Google sign-in appears only for a configured OAuth integration');
      assert.equal(googleButton.getAttribute('href'), '/api/auth/google?next=%2Fwallet');
      assert.equal(googleButton.querySelector('img')?.getAttribute('src'), '/assets/brands/google.svg', 'OAuth uses the local multicolor Google brand asset');
      assert.match(rendered.node.textContent, /Login Google dibatalkan/i);
      assertNoVisibleNullText(rendered.node, 'login with Google and an OAuth error');
      rendered.cleanup?.();
    }

    // ---------------------------------------------------------------- landing
    {
      const ctx = makeCtx({ api, user: null, pathname: '/' });
      const rendered = await (await page('landing'))(ctx);
      await settle();
      assert.ok(rendered.node);
      const html = rendered.node.outerHTML ?? rendered.node.toString();
      assert.match(html, /FINZZ/i);
      assert.ok(!/%\s*uptime/i.test(html), 'no invented uptime claim');
      assert.ok(!/99[,.]\d\s*%/.test(html), 'no invented success-rate claim');
      assert.match(html, /WA|WhatsApp/, 'database-mirrored catalogue is rendered');
      assert.match(html, /Data demo \(mock supplier\)/, 'demo source is identified on the mirror view');
      assert.match(html, /Mirror katalog terakhir disinkronkan/, 'the landing page labels the database mirror timestamp accurately');
      const marquee = rendered.node.querySelector('.brand-marquee');
      assert.ok(marquee && !marquee.hasAttribute('hidden'), 'a real one-app catalogue still gets a scrolling brand strip');
      const track = marquee.querySelector('.brand-marquee__track');
      assert.match(track.style.getPropertyValue('--marquee-duration'), /^\d+(?:\.\d+)?s$/, 'the continuous scroll duration is applied as a CSS custom property');
      const groups = Array.from(marquee.querySelectorAll('.brand-marquee__group'));
      assert.ok(groups.length >= 4, 'the animation repeats the real group enough times to cover the viewport');
      assert.equal(groups[0].hasAttribute('aria-hidden'), false, 'one unique catalogue group remains accessible');
      assert.equal(groups[0].querySelectorAll('.brand-chip').length, 1);
      assert.ok(groups.slice(1).every((group) => group.getAttribute('aria-hidden') === 'true'), 'visual loop copies are hidden from assistive technology');
      assert.equal(groups[0].querySelector('.brand-chip__logo')?.getAttribute('src'), '/assets/brands/whatsapp.svg');
      rendered.cleanup?.();
    }

    // ------------------------------------------------------------- dashboard
    {
      const ctx = makeCtx({ api, pathname: '/dashboard', search: '' });
      const rendered = await (await page('dashboard'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Ringkasan saldo|Halo/);
      assert.match(html, /Order aktif/);
      rendered.cleanup?.();
    }

    // -------------------------------------------------------------- services
    {
      const ctx = makeCtx({ api, pathname: '/services' });
      const rendered = await (await page('services'))(ctx);
      await settle();
      const countryButton = [...rendered.node.querySelectorAll('.country-chip')].find((button) => /Indonesia/.test(button.textContent));
      assert.ok(countryButton, 'dynamic server/app/country data has loaded');
      countryButton.dispatchEvent(new Event('click'));
      await settle();
      const html = rendered.node.outerHTML;
      assert.match(html, /Beli nomor virtual/);
      assert.match(html, /WhatsApp/);
      assert.match(html, /Rp/);
      rendered.cleanup?.();
    }

    // ----------------------------------------------------------------- status
    {
      const ctx = makeCtx({ api, user: null, pathname: '/status' });
      const rendered = await (await page('status'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Status layanan/i);
      assert.match(html, /terhubung/i, 'the database row reports the real driver state');
      assert.match(html, /mock/i, 'a mock supplier is labelled as mock, never as live');
      assert.ok(!/real-?time/i.test(html), 'no real-time claim on the status page');
      rendered.cleanup?.();
    }

    // ---------------------------------------------------------- verify email
    {
      const ctx = makeCtx({ api, user: null, pathname: '/verify-email' });
      const rendered = await (await page('verify-email'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Verifikasi email/i);
      assert.match(html, /name="code"/, 'the six-digit code field is rendered');
      assert.match(html, /one-time-code/i, 'autocomplete hints the OS code autofill');
      // The whole point of the rework: no email field, and the masked address
      // comes from the server context instead of a query string.
      assert.ok(!/name="email"/.test(html), 'the user must not retype their email');
      assert.match(html, /u\*\*\*r@finzz\.test/, 'the masked address is shown from the server context');
      assert.ok(!/supabase/i.test(html), 'no provider leftovers on the verification page');
      rendered.cleanup?.();
    }

    // --------------------------------------------------------- reset password
    {
      const ctx = makeCtx({ api, user: null, pathname: '/reset-password', search: '?token=token-uji-123' });
      const rendered = await (await page('reset-password'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Atur password baru/i);
      assert.match(html, /name="password"/);
      assert.match(html, /name="confirm"/);
      rendered.cleanup?.();
    }

    // A dead link must be explained instead of showing a password form.
    // The fetch stack is swapped only for this block and restored afterwards,
    // otherwise every later page in this test would hit 404 fixtures.
    {
      const previousFetch = globalThis.fetch;
      installFetch([{ match: '/api/auth/reset-password/validate', body: { valid: false, reason: 'EXPIRED' } }]);
      try {
        const ctx = makeCtx({ api, user: null, pathname: '/reset-password', search: '?token=basi' });
        const rendered = await (await page('reset-password'))(ctx);
        const html = rendered.node.outerHTML;
        assert.match(html, /kedaluwarsa/i, 'the expired reason is shown');
        assert.ok(!/name="password"/.test(html), 'no password form for a dead link');
        rendered.cleanup?.();
      } finally {
        globalThis.fetch = previousFetch;
      }
    }

    // ---------------------------------------------------------------- orders
    {
      const ctx = makeCtx({ api, pathname: '/orders', search: `?id=${FIXTURES.order.id}` });
      const rendered = await (await page('orders'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Order &amp; OTP|Order & OTP/);
      assert.match(html, /445566|Menunggu/);
      rendered.cleanup?.();
    }

    // ---------------------------------------------------------------- wallet
    {
      const ctx = makeCtx({ api, pathname: '/wallet' });
      const rendered = await (await page('wallet'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Saldo &amp; deposit|Saldo & deposit/);
      assert.match(html, /Ajukan deposit/);
      assert.match(html, /96\.780|96780/);
      rendered.cleanup?.();
    }

    // --------------------------------------------------------------- profile
    {
      const ctx = makeCtx({ api, pathname: '/profile' });
      const rendered = await (await page('profile'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Profil &amp; keamanan|Profil & keamanan/);
      assert.match(html, /Metode masuk/);
      assert.match(html, /Password akun/);
      assert.match(html, /user@finzz.test/);
      rendered.cleanup?.();
    }

    // ----------------------------------------------------------------- admin
    {
      const ctx = makeCtx({ api, pathname: '/admin' });
      const rendered = await (await page('admin'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Panel admin/);
      assert.match(html, /Laba bersih/);
      assert.match(html, /Rp/);
      rendered.cleanup?.();
    }

    // ------------------------------------------------------------- static pages
    for (const [name, expected] of [['terms', /Syarat/], ['privacy', /Privasi|Kebijakan/], ['not-found', /tidak ditemukan/], ['forbidden', /Akses ditolak/]]) {
      const ctx = makeCtx({ api, pathname: `/${name}` });
      const rendered = await (await page(name))(ctx);
      assert.match(rendered.node.outerHTML, expected, `${name} renders its message`);
      rendered.cleanup?.();
    }

    // ---------------------------------------------------------------- auth pages
    for (const name of ['login', 'register', 'forgot-password', 'reset-password', 'verify-email']) {
      const ctx = makeCtx({ api, user: null, pathname: `/${name}` });
      const rendered = await (await page(name))(ctx);
      assert.ok(rendered.node.outerHTML.length > 200, `${name} renders`);
      assertNoVisibleNullText(rendered.node, name);
      rendered.cleanup?.();
    }
  } finally {
    fetcher.restore();
  }
});

test('pages degrade gracefully when the API fails', async () => {
  setupDom();
  const { createApi, ApiError } = await import('../public/js/api.js');
  const fetcher = installFetch([
    { match: '/api/public/config', status: 200, body: FIXTURES.config },
    { match: '/api/public/catalog', status: 503, body: { error: { code: 'SUPPLIER_UNAVAILABLE', message: 'Supplier tidak dapat dihubungi.' } } },
    { match: '/api/wallet', status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Server sedang bermasalah.' } } }
  ]);
  const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

  try {
    const landingCtx = makeCtx({ api, user: null, pathname: '/' });
    const landing = await (await page('landing'))(landingCtx);
    await settle();
    const landingHtml = landing.node.outerHTML;
    assert.match(landingHtml, /tidak tersedia|belum tersedia|Tidak tersedia/i, 'the landing page states that data is unavailable');
    landing.cleanup?.();

    const servicesCtx = makeCtx({ api, pathname: '/services' });
    const services = await (await page('services'))(servicesCtx);
    await settle();
    assert.match(services.node.outerHTML, /Gagal memuat katalog|tidak tersedia/i);
    services.cleanup?.();
  } finally {
    fetcher.restore();
  }
});

test('new marketing pages render their content and the help search filters', async () => {
  setupDom();
  const { createApi } = await import('../public/js/api.js');
  const fetcher = installFetch(baseRoutes());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });

    // -------------------------------------------------------------- about
    {
      const ctx = makeCtx({ api, user: null, pathname: '/tentang' });
      const rendered = await (await page('tentang'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Tentang/, 'about page renders its eyebrow');
      assert.match(html, /Argon2id|ledger|refund/i, 'about page lists real product principles');
      rendered.cleanup?.();
    }

    // --------------------------------------------------------------- help
    {
      const ctx = makeCtx({ api, user: null, pathname: '/bantuan' });
      const rendered = await (await page('bantuan'))(ctx);
      const root = rendered.node;
      const html = root.outerHTML;
      assert.match(html, /Pusat bantuan/);
      const searchInput = root.querySelector('input[type="search"]');
      assert.ok(searchInput, 'help centre exposes a search box');

      // A nonsense query hides every accordion item and shows the empty state.
      searchInput.value = 'zzz-tidak-cocok';
      searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settle();
      const visibleItems = [...root.querySelectorAll('.accordion__item')].filter((n) => !n.classList.contains('hidden'));
      assert.equal(visibleItems.length, 0, 'non-matching questions are hidden');
      assert.match(root.outerHTML, /Tidak ada hasil yang cocok/, 'an explicit empty state is shown');

      // A real keyword brings matching items back.
      searchInput.value = 'refund';
      searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settle();
      const matched = [...root.querySelectorAll('.accordion__item')].filter((n) => !n.classList.contains('hidden'));
      assert.ok(matched.length >= 1, 'refund questions match the keyword');
      rendered.cleanup?.();
    }

    // ----------------------------------------------------------- security
    {
      const ctx = makeCtx({ api, user: null, pathname: '/keamanan' });
      const rendered = await (await page('keamanan'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Keamanan/);
      assert.match(html, /Argon2id/, 'the security page names the real password hasher');
      assert.match(html, /Row Level Security/i, 'the Postgres RLS control is described');
      rendered.cleanup?.();
    }

    // ------------------------------------------------------------ contact
    {
      const ctx = makeCtx({ api, user: null, pathname: '/kontak' });
      const rendered = await (await page('kontak'))(ctx);
      const html = rendered.node.outerHTML;
      assert.match(html, /Kontak/);
      // The fixture publishes support@finzz.store, so the email card must appear.
      assert.match(html, /support@finzz\.store/, 'configured support channels are rendered');
      assert.ok(!/\+62\d{8,}/.test(html), 'no invented phone numbers on the contact page');
      rendered.cleanup?.();
    }
  } finally {
    fetcher.restore();
  }
});

test('client router allows guests to browse services while private routes stay protected', async () => {
  const { window } = setupDom({ pathname: '/services', bootState: {
    page: 'services', path: '/services', status: 200, user: null,
    config: { csrfCookieName: 'fz_csrf' }, csrfToken: 'csrf-token', preloaded: {}
  } });
  const fetcher = installFetch(baseRoutes());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await import(`../public/js/main.js?guest-services-${Date.now()}`);
    await settle();
    const root = window.document.getElementById('app-root');
    assert.match(root.outerHTML, /Beli nomor virtual/);
    assert.ok(root.querySelector('.country-chip'), 'guest can browse dynamic catalog data');
    assert.equal(window.location.assigned, undefined, 'guest is not redirected to login merely for browsing');
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new window.Event('popstate'));
    await settle();
  } finally {
    fetcher.restore();
  }
});

test('main.js boots, routes and mounts a page from the server state', async () => {
  const { window } = setupDom({
    pathname: '/dashboard',
    bootState: {
      page: 'dashboard',
      path: '/dashboard',
      status: 200,
      user: { id: 'u1', email: 'user@finzz.test', role: 'user', username: 'user1' },
      config: { csrfCookieName: 'fz_csrf' },
      csrfToken: 'csrf-token',
      preloaded: {}
    }
  });
  const fetcher = installFetch(baseRoutes());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  try {
    await import('../public/js/main.js');
    await settle();

    const root = window.document.getElementById('app-root');
    assert.ok(root, 'app-root exists');
    const html = root.outerHTML;
    assert.ok(html.length > 500, 'the router mounted real content');
    assert.match(html, /Dashboard|saldo|Order/i);
    // The layout chrome (header + navigation) is mounted as well.
    assert.match(html, /FINZZ/);

    // Leave the polling page so its interval is cleared and the test process
    // can exit (a leaked timer would hang `npm test`).
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new window.Event('popstate'));
    await settle();
    assert.match(root.outerHTML, /FINZZ/, 'the router renders the next page and clears timers');
  } finally {
    fetcher.restore();
  }
});

test('dynamic catalogue UI preserves supplier context, sorts prices numerically, and returns guests to purchase context', async () => {
  const { window } = setupDom();
  const { createApi, ApiError } = await import('../public/js/api.js');
  const { createStore } = await import('../public/js/store.js');
  const { createLayout } = await import('../public/js/layout.js');
  globalThis.__finzzStore = { createStore };
  globalThis.__finzzApiError = ApiError;
  globalThis.__finzzLayout = (store, navigate) =>
    createLayout({ store, navigate, getTheme: () => 'dark', onToggleTheme: () => {}, onLogout: async () => {} });
  const fetcher = installFetch(baseRoutes());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const { createApi } = await import('../public/js/api.js');
    const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });
    const ctx = makeCtx({ api, user: null, pathname: '/services' });
    const rendered = await (await page('services'))(ctx);
    await settle();
    const root = rendered.node;

    assert.ok(!/Katalog TeleKos tidak tersedia/.test(root.outerHTML), 'dynamic catalogue data rendered');
    const bar = root.querySelector('.filter-bar');
    assert.ok(bar, 'filter bar is mounted');
    assert.match(bar.outerHTML, /Pilih server/);
    assert.match(bar.outerHTML, /Pilih aplikasi/);
    assert.match(bar.outerHTML, /Cari negara, ISO, atau kode telepon/);
    assert.match(bar.outerHTML, /Urutkan penawaran/);
    assert.match(bar.outerHTML, /Hanya tampilkan stok tersedia/);
    assert.match(root.outerHTML, /WhatsApp · pilih negara/);

    const grid = () => root.querySelector('.country-grid')?.outerHTML || '';
    assert.match(grid(), /Indonesia/, 'a stocked supplier country is shown');
    assert.ok(!/Malaysia/.test(grid()), 'zero-stock countries are filtered by the default toggle');

    const stockToggle = root.querySelector('input[type="checkbox"]');
    stockToggle.checked = false;
    stockToggle.dispatchEvent(new window.Event('change'));
    await settle();
    assert.match(grid(), /Malaysia/, 'users may turn off the availability filter and see valid zero-stock data');

    const countryButton = [...root.querySelectorAll('.country-chip')].find((button) => /Indonesia/.test(button.textContent));
    assert.ok(countryButton, 'supplier country ID is represented by a selectable chip');
    countryButton.dispatchEvent(new window.Event('click'));
    await settle();
    let rows = [...root.querySelectorAll('.copy-field')].map((row) => row.textContent);
    assert.equal(rows.length, 2, 'all returned offers are shown');
    assert.match(rows[0], /1\.000/, 'default order is the lowest numeric sale price');
    assert.match(rows[1], /2\.500/);
    assert.match(root.outerHTML, /Masuk untuk membeli/, 'guest is prompted to authenticate before checkout');

    const sort = root.querySelector('select[aria-label="Urutkan penawaran"]');
    sort.querySelectorAll('option').forEach((option) => option.removeAttribute('selected'));
    sort.querySelector('option[value="price-desc"]').setAttribute('selected', '');
    sort.dispatchEvent(new window.Event('change'));
    await settle();
    rows = [...root.querySelectorAll('.copy-field')].map((row) => row.textContent);
    assert.match(rows[0], /2\.500/, 'descending sort uses the numeric sale price');

    const buyButton = [...root.querySelectorAll('button')].find((button) => button.textContent.includes('Masuk untuk membeli'));
    assert.ok(buyButton);
    buyButton.dispatchEvent(new window.Event('click'));
    const loginNavigation = ctx.__navigations.at(-1);
    assert.match(loginNavigation, /^\/login\?next=/);
    const next = new URL(loginNavigation, 'http://localhost').searchParams.get('next');
    const purchaseContext = new URL(next, 'http://localhost');
    assert.equal(purchaseContext.pathname, '/services');
    assert.equal(purchaseContext.searchParams.get('server'), 'server1');
    assert.equal(purchaseContext.searchParams.get('app'), 'wa');
    assert.equal(purchaseContext.searchParams.get('country'), '6');
    assert.equal(purchaseContext.searchParams.get('offer'), 'offer-wa-high', 'selected supplier offer ID is returned after login unchanged');

    const appSelect = root.querySelector('select[aria-label="Pilih aplikasi"]');
    appSelect.querySelectorAll('option').forEach((option) => option.removeAttribute('selected'));
    appSelect.querySelector('option[value="tg"]').setAttribute('selected', '');
    appSelect.dispatchEvent(new window.Event('change'));
    await settle();
    assert.match(root.outerHTML, /Telegram · pilih negara/, 'app selection follows the supplier ID');
    rendered.cleanup?.();
  } finally {
    fetcher.restore();
  }
});
test('profile shows safe Google link controls and password recovery for OAuth-only accounts', async () => {
  setupDom();
  const { createApi, ApiError } = await import('../public/js/api.js');
  const { createStore } = await import('../public/js/store.js');
  const { createLayout } = await import('../public/js/layout.js');
  globalThis.__finzzStore = { createStore };
  globalThis.__finzzApiError = ApiError;
  globalThis.__finzzLayout = (store, navigate) =>
    createLayout({ store, navigate, getTheme: () => 'dark', onToggleTheme: () => {}, onLogout: async () => {} });

  const routes = baseRoutes();
  const identityRoute = routes.find((route) => route.match === '/api/auth/identities');
  const fetcher = installFetch(routes);
  const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });
  const publicSettings = {
    ...FIXTURES.config,
    app: { ...FIXTURES.config.app, oauth: { google: true } }
  };
  try {
    identityRoute.body = { loginMethods: { passwordEnabled: true, identities: [] } };
    const unlinked = await (await page('profile'))(makeCtx({ api, pathname: '/profile', publicSettings }));
    assert.match(unlinked.node.outerHTML, /Tautkan Google/, 'Google linking is available only when configured and authenticated');

    identityRoute.body = { loginMethods: { passwordEnabled: false, identities: [
      { provider: 'google', email: 'user@finzz.test', name: 'User Google', linkedAt: new Date().toISOString() }
    ] } };
    const linked = await (await page('profile'))(makeCtx({ api, pathname: '/profile', publicSettings }));
    assert.match(linked.node.outerHTML, /Terhubung/);
    assert.match(linked.node.outerHTML, /user@finzz\.test/);
    assert.match(linked.node.outerHTML, /Atur password melalui email/);
    assert.ok(!linked.node.outerHTML.includes('provider-subject'), 'Google subject is never rendered to the browser');
    assert.ok(!linked.node.outerHTML.includes('user@finzz.test:google'), 'identity key material is never rendered');
  } finally {
    fetcher.restore();
  }
});

test('notifications page lists real inbox rows and marks them read', async () => {
  setupDom();
  const { createApi } = await import('../public/js/api.js');
  // Order matters: installFetch matches in array order, so the POST routes for
  // the inbox actions must come before the generic GET fixture.
  const postRoutes = [
    { match: '/api/notifications/read-all', method: 'POST', body: { updated: 1, unreadCount: 0, message: '1 notifikasi ditandai sudah dibaca.' } },
    { match: '/api/notifications/read', method: 'POST', body: { updated: 1, unreadCount: 0, message: 'Notifikasi ditandai sudah dibaca.' } }
  ];
  const ordered = installFetch([...postRoutes, ...baseRoutes()]);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const api = createApi({ getCsrfToken: () => 'csrf-token', onUnauthorized: () => {} });
    const ctx = makeCtx({ api, pathname: '/notifications' });
    const rendered = await (await page('notifications'))(ctx);
    await settle();
    const html = rendered.node.outerHTML;

    assert.ok(!/tidak dapat dimuat/i.test(html), 'the inbox loaded instead of its error state');
    assert.match(html, /Nomor sudah terbit/, 'an unread row is rendered');
    assert.match(html, /Deposit disetujui/, 'a read row is rendered');
    assert.match(html, /1 belum dibaca/, 'the unread counter is real, not decorative');
    assert.match(html, /notif--unread/, 'unread rows are visually distinct');
    assert.match(html, /Tandai semua/, 'bulk action present');

    // The unread count is mirrored into the shared store for the header bell.
    assert.equal(ctx.store.get('unreadNotifications'), 1);

    // "Tandai semua" posts to the real endpoint.
    const markAll = [...rendered.node.querySelectorAll('button')].find((b) => /Tandai semua/.test(b.textContent));
    assert.ok(markAll, 'the mark-all button exists');
    markAll.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
    assert.ok(
      ordered.calls.some((c) => c.method === 'POST' && c.path.startsWith('/api/notifications/read')),
      'clicking mark-all calls the API'
    );
    assert.equal(ctx.store.get('unreadNotifications'), 0);

    rendered.cleanup?.();
  } finally {
    ordered.restore();
  }
});
