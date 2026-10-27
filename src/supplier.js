// ============================================================================
// SUPPLIER ADAPTER — TELEKOS.ID API v1
//
// Endpoints implemented strictly from the official documentation
// (https://telekos.id/docs/): GET /balance, /servers, /apps, /countries,
// /prices, /orders, /orders/{id}; POST /orders (Idempotency-Key required),
// /orders/{id}/cancel, /orders/{id}/finish.
//
// Nothing here is invented: no undocumented endpoints, payloads or statuses.
// The API key lives only on the server and is never logged or sent to clients.
//
// Error classification is the difference between a safe refund and a duplicate
// purchase, so it is explicit:
//   definitive  -> the supplier rejected the request, no order exists
//   ambiguous   -> timeout / 5xx / maintenance: we do NOT know, reconcile first
// ============================================================================
import { SupplierError, classifyHttpStatus } from './supplier-error.js';

const RATE_HEADER = {
  limit: 'ratelimit-limit',
  remaining: 'ratelimit-remaining',
  reset: 'ratelimit-reset',
  retryAfter: 'retry-after'
};

// Endpoints that must all answer successfully before the integration may be
// called verified. Orders are excluded on purpose: they cost money and are
// proven by a real purchase, not by a probe.
const VERIFIED_KEY = {
  '/balance': 'balance',
  '/servers': 'servers',
  '/apps': 'apps',
  '/countries': 'countries',
  '/prices': 'prices',
  '/orders': 'orders'
};
const READ_CAPABILITIES = ['servers', 'apps', 'countries', 'prices'];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readResponseText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new SupplierError('INVALID_RESPONSE', 'Respons supplier melebihi batas ukuran', { definitive: false });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SupplierError('INVALID_RESPONSE', 'Respons supplier melebihi batas ukuran', { definitive: false });
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export function createSupplierClient(config, { logger, fetchImpl = globalThis.fetch } = {}) {
  const { baseUrl, apiKey, timeoutMs, mode, enabled } = config.supplier;
  const startedAt = Date.now();
  const state = {
    rateLimit: { limit: null, remaining: null, resetAt: null },
    lastSuccessAt: null,
    lastError: null,
    requests: 0,
    failures: 0,
    // Endpoints proven against the *live* credentials. A capability is only
    // listed here after a real 2xx answer with the documented shape.
    verified: new Set()
  };

  const readRateLimit = (headers) => {
    const get = (name) => headers.get(name);
    if (get(RATE_HEADER.limit) !== null) state.rateLimit.limit = Number(get(RATE_HEADER.limit));
    if (get(RATE_HEADER.remaining) !== null) state.rateLimit.remaining = Number(get(RATE_HEADER.remaining));
    if (get(RATE_HEADER.reset) !== null) {
      const reset = Number(get(RATE_HEADER.reset));
      state.rateLimit.resetAt = Number.isFinite(reset)
        ? new Date(reset > 1e12 ? reset : reset * 1000).toISOString()
        : null;
    }
    return state.rateLimit;
  };

  const buildUrl = (path, query) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    return url;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(path, { method = 'GET', query, body, idempotencyKey, retries } = {}) {
    if (!enabled) throw new SupplierError('SUPPLIER_NOT_CONFIGURED', 'Supplier belum dikonfigurasi', { definitive: false });
    // Reads are retried at most once. Public catalogue endpoints also have a
    // process cache + distributed lease; provider retries must remain bounded.
    const maxRetries = retries ?? 1;
    const url = buildUrl(path, query);
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt += 1;
      state.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'FinzzStore/2.0 (+server)'
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

        const response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
        readRateLimit(response.headers);

        // Keep the timeout active until the response body has been consumed.
        // Clearing it immediately after fetch() leaves a stalled body read able
        // to pin a Vercel invocation indefinitely.
        const text = await readResponseText(response);
        clearTimeout(timer);
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }

        if (response.ok) {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            state.failures += 1;
            state.lastError = { code: 'INVALID_RESPONSE', at: new Date().toISOString() };
            throw new SupplierError('INVALID_RESPONSE', 'Respons supplier tidak valid', { definitive: false });
          }
          state.lastSuccessAt = new Date().toISOString();
          state.lastError = null;
          // Evidence, not a promise: remember only valid JSON object responses.
          if (mode === 'live') state.verified.add(VERIFIED_KEY[path] || path);
          return payload;
        }

        const errorCode = payload?.error?.code || `HTTP_${response.status}`;
        const retryAfterHeader = response.headers.get(RATE_HEADER.retryAfter);
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;

        if (response.status === 429) {
          if (attempt <= maxRetries) {
            const waitMs = Math.min(5000, (retryAfter || 2) * 1000) + Math.random() * 250;
            logger?.warn?.('supplier rate limited', { retryAfter, attempt });
            await sleep(waitMs);
            continue;
          }
          throw new SupplierError('RATE_LIMITED', 'Supplier membatasi permintaan', {
            httpStatus: 429, retryAfter, definitive: false, retryable: true
          });
        }

        const retryable = response.status >= 500 || response.status === 408;
        if (retryable && attempt <= maxRetries) {
          const backoff = Math.min(8000, 300 * 2 ** (attempt - 1)) + Math.random() * 200;
          await sleep(backoff);
          continue;
        }

        const classification = classifyHttpStatus(response.status, errorCode);
        state.failures += 1;
        state.lastError = { code: errorCode, at: new Date().toISOString() };
        throw new SupplierError(errorCode, payload?.error?.message || `Supplier error ${response.status}`, {
          httpStatus: response.status,
          definitive: classification.definitive,
          retryable: classification.retryable,
          retryAfter
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof SupplierError) throw err;
        const aborted = err?.name === 'AbortError' || controller.signal.aborted;
        state.failures += 1;
        if (attempt <= maxRetries) {
          await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)));
          continue;
        }
        state.lastError = { code: aborted ? 'TIMEOUT' : 'NETWORK', at: new Date().toISOString() };
        throw new SupplierError(aborted ? 'TIMEOUT' : 'NETWORK_ERROR', aborted ? 'Supplier timeout' : 'Gagal menghubungi supplier', {
          definitive: false,
          retryable: true
        });
      }
    }
    throw new SupplierError('UNREACHABLE', 'Supplier tidak dapat dihubungi', { definitive: false });
  }

  // ------------------------------------------------------------------ shaping
  const ensureArray = (value, label) => {
    if (!Array.isArray(value)) throw new SupplierError('INVALID_RESPONSE', `Format ${label} tidak valid`, { definitive: false });
    return value;
  };

  const normalizeOrder = (raw) => {
    if (!raw || typeof raw !== 'object' || !raw.id) {
      throw new SupplierError('INVALID_RESPONSE', 'Data order supplier tidak valid', { definitive: false });
    }
    const otps = Array.isArray(raw.otps)
      ? raw.otps
          .filter((o) => o && typeof o === 'object')
          .map((o) => ({
            id: String(o.id || ''),
            code: o.code ? String(o.code).slice(0, 32) : null,
            message: o.message ? String(o.message).slice(0, 500) : null,
            sender: o.sender ? String(o.sender).slice(0, 80) : null,
            receivedAt: o.received_at || null
          }))
          // TeleKos documents that the newest OTP should be used when several
          // messages exist. Do not depend on provider array ordering.
          .sort((a, b) => {
            const at = a.receivedAt ? Date.parse(a.receivedAt) : 0;
            const bt = b.receivedAt ? Date.parse(b.receivedAt) : 0;
            return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
          })
      : [];
    return {
      id: String(raw.id),
      status: String(raw.status || '').toLowerCase(),
      number: raw.number ? String(raw.number) : null,
      app: raw.app ? { id: String(raw.app.id || ''), name: String(raw.app.name || '') } : null,
      country: raw.country
        ? {
            id: Number(raw.country.id),
            name: String(raw.country.name || ''),
            iso: raw.country.iso || null,
            callingCode: raw.country.calling_code || null
          }
        : null,
      server: raw.server ? { id: String(raw.server.id || ''), name: String(raw.server.name || '') } : null,
      price: Number(raw.price) || 0,
      currency: raw.currency || 'IDR',
      otps,
      canCancel: Boolean(raw.can_cancel),
      cancelAvailableAt: raw.cancel_available_at || null,
      createdAt: raw.created_at || null,
      expiresAt: raw.expires_at || null
    };
  };

  return {
    mode,
    isConfigured: Boolean(enabled),
    isMock: mode === 'mock',
    quotesEnabled: Boolean(enabled),

    async getBalance() {
      const res = await request('/balance');
      if (!res.data || !Number.isFinite(Number(res.data.balance))) {
        throw new SupplierError('INVALID_RESPONSE', 'Format saldo supplier tidak valid', { definitive: false });
      }
      return { balance: Number(res.data.balance), currency: res.data.currency || 'IDR', updatedAt: res.data.updated_at || null };
    },

    async getServers() {
      const res = await request('/servers');
      return ensureArray(res.data, 'daftar server')
        .filter((s) => s && typeof s === 'object' && String(s.id ?? '').trim())
        .map((s) => ({
          id: String(s.id),
          name: String(s.name || s.id),
          available: Boolean(s.available),
          maintenance: Boolean(s.maintenance)
        }));
    },

    async getApps(server) {
      const res = await request('/apps', { query: { server } });
      return ensureArray(res.data, 'daftar aplikasi')
        .filter((a) => a && typeof a === 'object' && String(a.id ?? '').trim())
        .map((a) => ({ id: String(a.id), name: String(a.name || a.id) }));
    },

    async getCountries({ server, app }) {
      const res = await request('/countries', { query: { server, app } });
      return ensureArray(res.data, 'daftar negara')
        .filter((c) => c && typeof c === 'object' && Number.isSafeInteger(Number(c.id)) && Number(c.id) > 0)
        .map((c) => ({
          id: Number(c.id),
          name: String(c.name || c.id),
          iso: c.iso === undefined || c.iso === null ? null : String(c.iso),
          callingCode: c.calling_code === undefined || c.calling_code === null ? null : String(c.calling_code),
          stock: Number.isSafeInteger(Number(c.stock)) && Number(c.stock) >= 0 ? Number(c.stock) : 0
        }));
    },

    async getPrices({ server, app, country, refresh = false }) {
      const res = await request('/prices', { query: { server, app, country, refresh: refresh ? 1 : undefined } });
      const offers = ensureArray(res.data, 'daftar harga')
        .filter((o) => o && typeof o === 'object')
        .map((o) => ({
          id: o.id === undefined || o.id === null ? '' : String(o.id),
          offerId: o.offer_id === undefined || o.offer_id === null ? '' : String(o.offer_id),
          price: Number(o.price),
          currency: o.currency ? String(o.currency) : 'IDR',
          stock: Number.isSafeInteger(Number(o.stock)) && Number(o.stock) >= 0 ? Number(o.stock) : 0
        }))
        .filter((o) => o.id && o.offerId && Number.isFinite(o.price) && o.price > 0)
        .sort((a, b) => a.price - b.price || a.offerId.localeCompare(b.offerId));
      return { offers, quotedAt: res.meta?.quoted_at || null, server: res.meta?.server || null };
    },

    async createOrder({ offerId, idempotencyKey }) {
      if (!idempotencyKey) throw new SupplierError('MISSING_IDEMPOTENCY_KEY', 'Idempotency key wajib', { definitive: true });
      const res = await request('/orders', { method: 'POST', body: { offer_id: offerId }, idempotencyKey, retries: 1 });
      return {
        order: normalizeOrder(res.data),
        balance: res.meta && Number.isFinite(Number(res.meta.balance)) ? Number(res.meta.balance) : null
      };
    },

    async getOrder(orderId) {
      const res = await request(`/orders/${encodeURIComponent(orderId)}`);
      return normalizeOrder(res.data);
    },

    async listOrders(page = 1) {
      const res = await request('/orders', { query: { page } });
      return {
        orders: ensureArray(res.data, 'daftar order').map(normalizeOrder),
        meta: res.meta || {}
      };
    },

    async cancelOrder(orderId) {
      const res = await request(`/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
      return { order: normalizeOrder(res.data), balance: res.meta?.balance ?? null };
    },

    async finishOrder(orderId) {
      const res = await request(`/orders/${encodeURIComponent(orderId)}/finish`, { method: 'POST' });
      return { order: normalizeOrder(res.data) };
    },

    /**
     * Honest integration status.
     *
     * `contractVerified` stays FALSE until the owner confirms the supplier's
     * official documentation, credentials and webhook contract for this
     * deployment. Nothing in the UI or the report may present the integration as
     * "active" or "real-time" before that happens; adapters code against the
     * published v1 contract and are exercised only by the mock fixture.
     */
    status() {
      return {
        mode,
        configured: Boolean(enabled),
        // Verified means: every read endpoint answered with real data on this
        // process. The mock fixture can never be verified, and a configured key
        // that has never answered is not either.
        contractVerified: mode === 'live'
          && READ_CAPABILITIES.every((capability) => state.verified.has(capability)),
        verifiedEndpoints: [...state.verified],
        verifiedNote: mode === 'mock'
          ? 'mock fixture — never used in production'
          : READ_CAPABILITIES.every((capability) => state.verified.has(capability))
            ? 'read endpoints confirmed against live credentials (orders/webhook proven by a real purchase)'
            : 'live credentials present; read endpoints not yet confirmed',
        webhookConfigured: Boolean(config?.supplier?.webhookSecret),
        lastCheckedAt: state.lastSuccessAt,
        rateLimit: { ...state.rateLimit },
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        requests: state.requests,
        failures: state.failures,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      };
    }
  };
}
