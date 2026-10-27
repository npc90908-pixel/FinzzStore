// ============================================================================
// BROWSER ENVIRONMENT SHIM for page tests (linkedom + fetch fixtures).
// This is a test-only DOM; nothing here ships to the browser.
// ============================================================================
import { parseHTML } from 'linkedom';

export function setupDom({ pathname = '/', search = '', bootState = null } = {}) {
  const { window, document } = parseHTML('<!doctype html><html lang="id"><head></head><body><div id="app-root"></div></body></html>');
  if (bootState) {
    const node = document.createElement('script');
    node.setAttribute('type', 'application/json');
    node.setAttribute('id', 'finzz-state');
    node.textContent = JSON.stringify(bootState);
    document.head.appendChild(node);
  }

  const location = {
    origin: 'http://localhost:3000',
    protocol: 'http:',
    host: 'localhost:3000',
    pathname,
    search,
    hash: '',
    href: `http://localhost:3000${pathname}${search}`,
    assign(url) {
      this.assigned = url;
    },
    reload() {
      this.reloaded = true;
    }
  };

  const history = {
    state: null,
    pushState(_state, _title, url) {
      const [path, query = ''] = String(url).split('?');
      location.pathname = path;
      location.search = query ? `?${query}` : '';
      location.href = `${location.origin}${path}${location.search}`;
    },
    replaceState(state, _title, url) {
      this.state = state;
      this.pushState(state, _title, url);
    }
  };

  // Minimal stand-ins for APIs the client code touches.
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.open = () => null;
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  if (!window.Element.prototype.getBoundingClientRect) {
    window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    };
  }

  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const clipboard = {
    writes: [],
    async writeText(value) {
      clipboard.writes.push(value);
    }
  };

  const globals = {
    window,
    document,
    navigator: window.navigator,
    location,
    history,
    localStorage,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  for (const [key, value] of Object.entries(globals)) {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
      /* some globals are read-only in Node; tests that need them use the shim above */
    }
  }
  Object.defineProperty(window.navigator, 'clipboard', { value: clipboard, configurable: true });

  return { window, document, location, history, localStorage, clipboard };
}

/** Route table based fetch stub: [{ match: /regex/, status, body }] */
export function installFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method, path, url });
    for (const route of routes) {
      const matches = typeof route.match === 'string' ? path.startsWith(route.match) : route.match.test(path);
      if (matches && (!route.method || route.method === method)) {
        const status = route.status ?? 200;
        const body = typeof route.body === 'function' ? await route.body({ path, method, init }) : route.body;
        return new Response(JSON.stringify(body ?? {}), {
          status,
          headers: { 'content-type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no fixture for ${method} ${path}` } }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

export const FIXTURES = {
  config: {
    app: { name: 'FINZZ Store', version: '2.0.0' },
    store: { name: 'FINZZ Store', tagline: 'Nomor virtual instan', supportEmail: 'support@finzz.store', supportWhatsapp: null, supportTelegram: null },
    deposit: {
      minAmount: 1000,
      maxAmount: 5000000,
      instructions: 'Transfer lalu unggah bukti.',
      bankAccounts: [{ bank_name: 'BCA', account_number: '1234567890', account_holder: 'PT FINZZ' }],
      expiryHours: 24
    },
    operations: { salesOpen: true, maintenanceMessage: '', orderPollIntervalMs: 4000, orderExpirySeconds: 1260, maxActiveOrders: 5 },
    refundPolicy: 'Refund otomatis bila OTP tidak pernah diterima.',
    legal: { terms_version: '2026-10-01', privacy_version: '2026-10-01' },
    payment: { enabled: false, mode: 'disabled', message: 'Pembayaran otomatis belum aktif.' }
  },
  service: {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'tk-server1-wa-6',
    name: 'WhatsApp Indonesia',
    appId: 'wa',
    appName: 'WhatsApp',
    countryId: 6,
    countryName: 'Indonesia',
    countryIso: 'ID',
    callingCode: '+62',
    price: 2530,
    stock: 4820,
    active: true,
    syncedAt: new Date().toISOString(),
    sortOrder: 1
  },
  order: {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'waiting',
    app: { id: 'wa', name: 'WhatsApp' },
    country: { id: 6, name: 'Indonesia', iso: 'ID' },
    number: '+628123456789',
    pricing: { supplierPrice: 2200, markup: 330, tax: 0, total: 2530, currency: 'IDR' },
    canCancel: true,
    cancelAvailableAt: new Date().toISOString(),
    cancelRequested: false,
    expiresAt: new Date(Date.now() + 1200000).toISOString(),
    otpReceivedAt: null,
    otpCount: 0,
    refundedAt: null,
    completedAt: null,
    closedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastErrorCode: null,
    otp: { code: '445566', message: 'Kode verifikasi WhatsApp Anda', sender: 'WhatsApp', receivedAt: new Date().toISOString() }
  }
};

export function catalogFixture() {
  const service = { ...FIXTURES.service };
  return {
    services: [service],
    apps: [
      {
        id: 'wa',
        name: 'WhatsApp',
        countries: [service],
        minPrice: service.price,
        totalStock: service.stock,
        countryCount: 1
      }
    ],
    countries: [{ id: 6, name: 'Indonesia', iso: 'ID', callingCode: '+62' }],
    syncedAt: service.syncedAt,
    source: 'mock',
    summary: { activeServices: 1, countries: 1, apps: 1, lastCatalogSync: service.syncedAt }
  };
}
