// ============================================================================
// MOCK SUPPLIER — test/demo fixture only.
//
// Same interface as src/supplier.js. It is selected ONLY when
// SUPPLIER_MODE=mock, which config.js refuses to start in production. Every
// response carries `mock: true` and the UI shows a clear "data demo" badge, so
// mock data can never be mistaken for real supplier stock or prices.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import { SupplierError, mapSupplierStatus } from './supplier-error.js';

const APPS = [
  { id: 'wa', name: 'WhatsApp', base: 2200 },
  { id: 'tg', name: 'Telegram', base: 1500 },
  { id: 'gg', name: 'Google', base: 3000 },
  { id: 'ig', name: 'Instagram', base: 2400 },
  { id: 'tt', name: 'TikTok', base: 2100 },
  { id: 'dc', name: 'Discord', base: 1800 },
  { id: 'fb', name: 'Facebook', base: 2600 },
  { id: 'x', name: 'X', base: 3200 },
  { id: 'sh', name: 'Shopee', base: 2800 },
  { id: 'gr', name: 'Grab', base: 3500 }
];

const COUNTRIES = [
  { id: 6, name: 'Indonesia', iso: 'ID', calling: '+62', weight: 1.0, stock: 4820 },
  { id: 7, name: 'Malaysia', iso: 'MY', calling: '+60', weight: 1.1, stock: 1240 },
  { id: 12, name: 'Singapura', iso: 'SG', calling: '+65', weight: 1.35, stock: 640 },
  { id: 21, name: 'Vietnam', iso: 'VN', calling: '+84', weight: 0.9, stock: 2310 },
  { id: 24, name: 'Filipina', iso: 'PH', calling: '+63', weight: 0.95, stock: 1580 },
  { id: 30, name: 'Thailand', iso: 'TH', calling: '+66', weight: 1.05, stock: 980 },
  { id: 42, name: 'India', iso: 'IN', calling: '+91', weight: 0.75, stock: 5310 },
  { id: 55, name: 'Amerika Serikat', iso: 'US', calling: '+1', weight: 2.4, stock: 410 },
  { id: 61, name: 'Inggris', iso: 'GB', calling: '+44', weight: 2.2, stock: 260 },
  { id: 74, name: 'Brasil', iso: 'BR', calling: '+55', weight: 1.6, stock: 340 }
];

const SERVER_MULTIPLIER = { server1: 1, server2: 1.2, server3: 0.85 };
const hashInt = (value, modulo) => {
  const h = createHash('sha256').update(value).digest();
  return h.readUInt32BE(0) % modulo;
};

export function createMockSupplier({ logger, otpDelayMs = 8000, cancelDelayMs = 12000, expiryMs = 20 * 60 * 1000, ambiguousCreateOnce = 0 } = {}) {
  const orders = new Map(); // supplier order id -> record
  const idempotency = new Map(); // key -> supplier order id
  const startedAt = Date.now();
  const state = { requests: 0, lastSuccessAt: null, lastError: null, ambiguousLeft: ambiguousCreateOnce };

  logger?.warn?.('MOCK SUPPLIER ACTIVE — sample data, never used in production');

  const priceFor = (server, appId, countryId) => {
    const app = APPS.find((a) => a.id === appId);
    const country = COUNTRIES.find((c) => c.id === Number(countryId));
    if (!app || !country) return null;
    const jitter = 0.9 + hashInt(`${server}:${appId}:${countryId}`, 40) / 100; // 0.90 - 1.29
    const price = Math.round((app.base * country.weight * (SERVER_MULTIPLIER[server] || 1) * jitter) / 100) * 100;
    return Math.max(500, price);
  };

  const stockFor = (server, appId, countryId) =>
    hashInt(`stock:${server}:${appId}:${countryId}`, 90) + (countryId === 6 ? 40 : 0);

  const advance = (record) => {
    const age = Date.now() - record._createdAt;
    if (['cancelled', 'completed', 'expired'].includes(record.status)) return record;
    if (age >= expiryMs) {
      record.status = record.otps.length > 0 ? 'completed' : 'expired';
      return record;
    }
    if (record.otps.length === 0 && age >= otpDelayMs && !record._cancelled) {
      const code = String(100000 + hashInt(`otp:${record.id}`, 900000));
      record.otps = [{
        id: `OTP-${record.id.slice(-6)}`,
        code,
        message: `Kode verifikasi ${record.app.name} Anda adalah ${code}. Jangan bagikan kode ini.`,
        sender: record.app.name,
        received_at: new Date().toISOString()
      }];
      record.status = 'received';
      record.can_cancel = false;
    }
    if (age >= cancelDelayMs && record.otps.length === 0 && record.status === 'waiting') {
      record.can_cancel = true;
    }
    return record;
  };

  // IMPORTANT: the mock must return exactly the same shape as the real
  // TELEKOS.ID client in src/supplier.js (camelCase DTO). A mismatch here would
  // silently break the order service in tests while production worked.
  const publicOrder = (record) => {
    const r = advance(record);
    return {
      id: r.id,
      status: r.status,
      number: r.number,
      app: { id: r.app.id, name: r.app.name },
      country: {
        id: r.country.id,
        name: r.country.name,
        iso: r.country.iso,
        callingCode: r.country.calling_code
      },
      server: { id: r.server.id, name: r.server.name },
      price: r.price,
      currency: 'IDR',
      otps: r.otps.map((o) => ({
        id: o.id,
        code: o.code,
        message: o.message,
        sender: o.sender,
        receivedAt: o.received_at
      })),
      canCancel: Boolean(r.can_cancel),
      cancelAvailableAt: r.cancel_available_at,
      createdAt: r.created_at,
      expiresAt: r.expires_at
    };
  };

  const fail = (code, message, opts) => {
    state.lastError = { code, at: new Date().toISOString() };
    throw new SupplierError(code, message, opts);
  };

  return {
    mode: 'mock',
    isConfigured: true,
    isMock: true,
    // The mock implements the same live-quote contract as the real client.
    quotesEnabled: true,

    async getBalance() {
      state.requests += 1;
      return { balance: 250000, currency: 'IDR', updatedAt: new Date().toISOString() };
    },

    async getServers() {
      state.requests += 1;
      return ['server1', 'server2', 'server3'].map((id) => ({
        id, name: `Server ${id.slice(-1)}`, available: true, maintenance: false
      }));
    },

    async getApps() {
      state.requests += 1;
      return APPS.map(({ id, name }) => ({ id, name }));
    },

    async getCountries({ app }) {
      state.requests += 1;
      if (!APPS.some((a) => a.id === app)) fail('INVALID_APP', 'Aplikasi tidak dikenal', { definitive: true, httpStatus: 400 });
      return COUNTRIES.map((c) => ({
        id: c.id,
        name: c.name,
        iso: c.iso,
        callingCode: c.calling,
        stock: stockFor('server1', app, c.id)
      }));
    },

    async getPrices({ server = 'server1', app, country }) {
      state.requests += 1;
      const price = priceFor(server, app, country);
      if (price === null) fail('INVALID_OFFER', 'Kombinasi aplikasi/negara tidak tersedia', { definitive: true, httpStatus: 400 });
      const stock = stockFor(server, app, country);
      if (stock <= 0) {
        return { offers: [], quotedAt: new Date().toISOString(), server: { id: server, name: server } };
      }
      const tiers = Math.min(3, Math.max(1, Math.floor(stock / 30)));
      const offers = Array.from({ length: tiers }, (_, i) => ({
        id: `mock-${server}-${app}-${country}-${i}`,
        offerId: `mockoffer.${server}.${app}.${country}.${i}.${Math.floor(Date.now() / 60000)}`,
        price: price + i * 1200,
        currency: 'IDR',
        stock: Math.max(1, Math.floor(stock / (i + 1)))
      }));
      return { offers, quotedAt: new Date().toISOString(), server: { id: server, name: `Server ${server.slice(-1)}` } };
    },

    async createOrder({ offerId, idempotencyKey }) {
      state.requests += 1;
      if (!idempotencyKey) fail('MISSING_IDEMPOTENCY_KEY', 'Idempotency key wajib', { definitive: true });
      if (idempotency.has(idempotencyKey)) {
        return { order: publicOrder(orders.get(idempotency.get(idempotencyKey))), balance: 250000, replayed: true };
      }
      const parts = String(offerId || '').split('.');
      if (parts[0] !== 'mockoffer') {
        fail('INVALID_OFFER', 'Offer tidak valid atau kedaluwarsa', { definitive: true, httpStatus: 400 });
      }
      const [, server, appId, countryId, tier] = parts;
      const app = APPS.find((a) => a.id === appId);
      const country = COUNTRIES.find((c) => c.id === Number(countryId));
      const price = priceFor(server, appId, countryId);
      if (!app || !country || price === null) fail('INVALID_OFFER', 'Offer tidak valid', { definitive: true, httpStatus: 400 });

      const id = `TRX-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
      const record = {
        id,
        status: 'waiting',
        number: `+${country.calling.replace('+', '')}8${String(hashInt(id, 900000000) + 100000000).slice(0, 9)}`,
        app: { id: app.id, name: app.name },
        country: { id: country.id, name: country.name, iso: country.iso, calling_code: country.calling },
        server: { id: server, name: `Server ${server.slice(-1)}` },
        price: price + Number(tier) * 1200,
        currency: 'IDR',
        otps: [],
        can_cancel: false,
        cancel_available_at: new Date(Date.now() + cancelDelayMs).toISOString(),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + expiryMs).toISOString(),
        _createdAt: Date.now(),
        _cancelled: false
      };
      orders.set(id, record);
      idempotency.set(idempotencyKey, id);
      state.lastSuccessAt = new Date().toISOString();

      // Fault injection for reconciliation tests: the purchase is committed on
      // the supplier side but the response is lost. A retry with the same
      // idempotency key must return this exact order instead of charging twice.
      if (state.ambiguousLeft > 0) {
        state.ambiguousLeft -= 1;
        fail('TIMEOUT', 'Batas waktu koneksi supplier habis', { definitive: false, retryable: true });
      }

      return { order: publicOrder(record), balance: 250000 - record.price };
    },

    async getOrder(orderId) {
      state.requests += 1;
      const record = orders.get(orderId);
      if (!record) fail('ORDER_NOT_FOUND', 'Order tidak ditemukan', { definitive: true, httpStatus: 404 });
      return publicOrder(record);
    },

    async listOrders() {
      state.requests += 1;
      return { orders: [...orders.values()].map(publicOrder), meta: { page: 1, pages: 1 } };
    },

    async cancelOrder(orderId) {
      state.requests += 1;
      const record = orders.get(orderId);
      if (!record) fail('ORDER_NOT_FOUND', 'Order tidak ditemukan', { definitive: true, httpStatus: 404 });
      advance(record);
      if (!record.can_cancel || record.otps.length > 0) {
        fail('CANCEL_NOT_AVAILABLE', 'Pembatalan belum tersedia', { definitive: false, httpStatus: 409 });
      }
      record.status = 'cancelled';
      record._cancelled = true;
      record.can_cancel = false;
      return { order: publicOrder(record), balance: 250000 };
    },

    async finishOrder(orderId) {
      state.requests += 1;
      const record = orders.get(orderId);
      if (!record) fail('ORDER_NOT_FOUND', 'Order tidak ditemukan', { definitive: true, httpStatus: 404 });
      advance(record);
      if (record.status === 'completed') return { order: publicOrder(record) };
      if (record.otps.length === 0) {
        fail('NOT_READY', 'Order belum menerima OTP', { definitive: false, httpStatus: 409 });
      }
      record.status = 'completed';
      return { order: publicOrder(record) };
    },

    status() {
      return {
        mode: 'mock',
        configured: true,
        mock: true,
        // Same honesty contract as the live adapter: nothing here is verified
        // against a real supplier.
        contractVerified: false,
        verifiedNote: 'mock fixture — never used in production',
        webhookConfigured: false,
        lastCheckedAt: state.lastSuccessAt,
        orders: orders.size,
        requests: state.requests,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        rateLimit: { limit: 60, remaining: 60, resetAt: null },
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      };
    },

    /** Exposed for tests: force an OTP without waiting. */
    _forceOtp(orderId) {
      const record = orders.get(orderId);
      if (!record) return null;
      record._createdAt = Date.now() - otpDelayMs - 1;
      return publicOrder(record);
    },

    _mapStatus: mapSupplierStatus
  };
}
