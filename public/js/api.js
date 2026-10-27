// ============================================================================
// API CLIENT — fetch wrapper with timeout, CSRF header, error normalisation.
// Tokens never live in localStorage: the session is an HttpOnly cookie.
// ============================================================================

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || 'Terjadi kesalahan.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const DEFAULT_TIMEOUT = 20000;

export function createApi({ getCsrfToken, onUnauthorized }) {
  const csrf = () => (typeof getCsrfToken === 'function' ? getCsrfToken() : null);

  async function request(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      timeout = DEFAULT_TIMEOUT,
      retries = method === 'GET' ? 1 : 0,
      signal: externalSignal = null,
      expect = 'json'
    } = options;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const onAbort = () => controller.abort();
      if (externalSignal) externalSignal.addEventListener('abort', onAbort, { once: true });

      try {
        const headers = { Accept: 'application/json' };
        if (body !== null) headers['Content-Type'] = 'application/json';
        const token = csrf();
        if (token && method !== 'GET') headers['X-CSRF-Token'] = token;

        const response = await fetch(path, {
          method,
          headers,
          credentials: 'same-origin',
          body: body === null ? undefined : JSON.stringify(body),
          signal: controller.signal
        });

        if (response.status === 401 && typeof onUnauthorized === 'function') {
          onUnauthorized(response);
        }

        if (expect === 'blob' && response.ok) return response.blob();

        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }

        if (!response.ok) {
          const error = payload?.error || {};
          throw new ApiError(
            response.status,
            error.code || `HTTP_${response.status}`,
            error.message || `Permintaan gagal (${response.status}).`,
            {
              field: error.field,
              retryAfter: error.retryAfter,
              allowed: error.allowed,
              requestId: error.requestId,
              // Safe, server-provided context (e.g. the masked address an
              // unverified login must continue with).
              verification: error.verification
            }
          );
        }
        return payload;
      } catch (err) {
        const isAbort = err?.name === 'AbortError';
        const network = err instanceof TypeError;
        if ((isAbort || network) && attempt <= retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          continue;
        }
        if (isAbort) throw new ApiError(0, 'TIMEOUT', 'Permintaan melebihi batas waktu. Periksa koneksi Anda.');
        if (network) throw new ApiError(0, 'NETWORK', 'Tidak dapat menghubungi server. Periksa koneksi Anda.');
        throw err;
      } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
    blob: (path, options) => request(path, { ...options, method: 'GET', expect: 'blob' })
  };
}

/** Build a query string, skipping empty values. */
export function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

export function newIdempotencyKey(prefix = 'ord') {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now().toString(36)}-${hex}`;
}
