// ============================================================================
// SECURITY PRIMITIVES — headers/CSP, cookies, CSRF, tokens, encryption,
// timing-safe comparison, origin checks and rate limiting.
// ============================================================================
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { AppError, errors } from './errors.js';

// ---------------------------------------------------------------------------
// HTML escaping (used by the server-side renderer)
// ---------------------------------------------------------------------------
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** JSON embedded in <script type="application/json"> must not break out. */
export function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// TOKENS & HASHING
// ---------------------------------------------------------------------------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (input) => createHash('sha256').update(input).digest('hex');

export function timingSafeEqualStr(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// SECRETS AT REST (Supabase refresh tokens in the sessions table)
// ---------------------------------------------------------------------------
export function encryptSecret(plaintext, key) {
  if (!plaintext) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(payload, key) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid encrypted payload');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// COOKIES
// ---------------------------------------------------------------------------
export function parseCookies(headerValue = '') {
  const out = {};
  for (const part of String(headerValue).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join('; ');
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

// ---------------------------------------------------------------------------
// ORIGIN / CSRF
// ---------------------------------------------------------------------------
export function originAllowed(origin, config) {
  if (!origin) return true; // same-origin navigations and server-to-server calls
  try {
    const parsed = new URL(origin);
    return config.allowedOrigins.some((allowed) => {
      try {
        return new URL(allowed).origin === parsed.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Same-origin is decided by comparing the Origin/Referer host with the Host the
 * request actually arrived on. Without this, a deployment behind a tunnel or a
 * preview proxy (a hostname the operator did not hardcode) would reject its own
 * form submissions as cross-origin. Cross-SITE requests still fail, because
 * their Origin host never equals the Host header.
 */
function sameHost(origin, req) {
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    if (!host) return false;
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** True when the request's Origin is absent, same-host, or allowlisted. */
export function requestOriginAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return sameHost(origin, req) || originAllowed(origin, config);
}

export function assertRequestOrigin(req, config) {
  if (!requestOriginAllowed(req, config)) throw errors.origin();
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (!sameHost(refererOrigin, req) && !originAllowed(refererOrigin, config)) throw errors.origin();
    } catch (err) {
      if (err?.code === 'ORIGIN_NOT_ALLOWED') throw err;
      throw errors.origin();
    }
  }
  // Modern browsers send this; reject cross-site writes outright.
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) throw errors.origin();
}

export function verifyCsrf(req, session) {
  if (!session) throw errors.csrf();
  const header = req.headers['x-csrf-token'];
  if (!header || typeof header !== 'string') throw errors.csrf();
  if (!timingSafeEqualStr(sha256(header), session.csrf_hash)) throw errors.csrf();
}

// ---------------------------------------------------------------------------
// CLIENT IP
// ---------------------------------------------------------------------------
export function clientIp(req, config) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length < 64) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim().slice(0, 64);
  }
  return (req.socket?.remoteAddress || '0.0.0.0').slice(0, 64);
}

// ---------------------------------------------------------------------------
// SECURITY HEADERS + CSP
// ---------------------------------------------------------------------------
export function securityHeaders(nonce, config) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    'upgrade-insecure-requests'
  ].join('; ');

  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-DNS-Prefetch-Control': 'off'
  };
  if (config.isProduction) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

// ---------------------------------------------------------------------------
// RATE LIMITING (shared through PostgreSQL when available)
// ---------------------------------------------------------------------------
/**
 * RATE LIMITER
 *
 * Two storage backends:
 *   * distributed — `rpc_rate_limit_hit` in PostgreSQL, shared by every Vercel
 *     serverless instance and every PM2 worker. This is the only correct mode
 *     for production, because each serverless instance has its own memory.
 *   * memory — per-process Map. Development, the in-memory driver and the
 *     automated tests.
 *
 * Production incident 2026-10-26: when the RPC failed the limiter silently fell
 * back to per-instance memory behind a single warn line, so on Vercel every
 * instance counted on its own and the limit effectively disappeared. Now:
 *
 *   * a failed distributed store is reported as `degraded` with the real
 *     PostgREST diagnostic (logged once per minute, not per request);
 *   * sensitive endpoints (`critical: true`) FAIL CLOSED with a safe 503 +
 *     Retry-After instead of running unprotected;
 *   * public read paths keep working (memory fallback) so a limiter outage can
 *     never take the landing page or the catalogue down;
 *   * `status()` exposes the mode for /api/health.
 */
export function createRateLimiter({ db, logger, config } = {}) {
  const memory = new Map();

  // The in-memory driver is a legitimate deployment for demo/tests; only a
  // real PostgreSQL deployment is *expected* to have a distributed limiter
  // (several serverless instances share one rate_limits table).
  const expectsDistributed = db?.kind === 'pg';

  const state = {
    expectsDistributed,
    hasDistributed: Boolean(db?.rateLimit?.hit) && expectsDistributed,
    degraded: false,
    // `mode` harus berbasis bukti, bukan asumsi: 'distributed' hanya boleh
    // dilaporkan setelah satu panggilan RPC benar-benar berhasil.
    verifiedAt: null,
    failures: 0,
    fallbacks: 0,
    lastFailureAt: null,
    lastErrorCode: null,
    lastErrorRpc: null,
    lastWarnAt: 0
  };

  const memoryHit = (key, limit, windowSeconds) => {
    const now = Date.now();
    const bucket = memory.get(key);
    if (!bucket || now - bucket.start >= windowSeconds * 1000) {
      memory.set(key, { start: now, count: 1 });
      return { allowed: true, remaining: limit - 1, resetAt: now + windowSeconds * 1000, count: 1 };
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.start + windowSeconds * 1000,
      count: bucket.count
    };
  };

  const cleanup = () => {
    const now = Date.now();
    for (const [key, bucket] of memory) {
      if (now - bucket.start > 60 * 60 * 1000) memory.delete(key);
    }
  };
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref?.();

  const noteFailure = (err) => {
    state.degraded = true;
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastErrorCode = err?.code || null;
    state.lastErrorRpc = err?.rpc || null;
    // One line per minute: an outage must not turn into a log flood that then
    // becomes the outage.
    const now = Date.now();
    if (now - state.lastWarnAt > 60_000) {
      state.lastWarnAt = now;
      logger?.warn?.('rate limiter storage unavailable — using local fallback', {
        rpc: 'rpc_rate_limit_hit',
        code: err?.code || null,
        pgCode: err?.pgCode || null,
        pgMessage: err?.pgMessage || null,
        pgHint: err?.pgHint || null,
        expectsDistributed,
        failures: state.failures
      });
    }
  };

  /**
   * Count one hit.
   * @returns {{allowed:boolean, limit:number, remaining:number, resetAt:number,
   *            count:number, storage:'distributed'|'memory', degraded:boolean}}
   */
  async function hit(key, limit, windowSeconds) {
    if (state.hasDistributed) {
      try {
        const res = await db.rateLimit.hit(key, limit, windowSeconds);
        if (res) {
          state.degraded = false;
          state.verifiedAt = new Date().toISOString();
          return { ...res, storage: 'distributed', degraded: false };
        }
      } catch (err) {
        noteFailure(err);
        state.fallbacks += 1;
      }
    }
    return { ...memoryHit(key, limit, windowSeconds), storage: 'memory', degraded: state.degraded };
  }

  /**
   * Enforce a bucket.
   * `critical` endpoints are refused (503) when the shared store is down instead
   * of being served without protection. Non-critical paths always degrade to the
   * local counter.
   */
  async function enforce(key, limit, windowSeconds, { critical = false } = {}) {
    const result = await hit(key, limit, windowSeconds);

    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      throw errors.rateLimited(retryAfter);
    }

    // Fail closed only when a distributed store was actually expected. Tests and
    // the local demo run on the in-memory driver and must never trip this.
    if (critical && result.storage === 'memory' && state.expectsDistributed) {
      throw new AppError(
        'RATE_LIMIT_UNAVAILABLE',
        'Perlindungan penyalahgunaan sedang tidak tersedia. Coba lagi sebentar lagi.',
        503,
        { retryAfter: 30 }
      );
    }
    return result;
  }

  return {
    hit,
    enforce,
    status() {
      const mode = !state.hasDistributed
        ? 'memory'
        : state.degraded
          ? 'degraded'
          : state.verifiedAt
            ? 'distributed'
            : 'unverified';
      return {
        mode,
        distributed: state.hasDistributed && !state.degraded && Boolean(state.verifiedAt),
        verifiedAt: state.verifiedAt,
        expectsDistributed: state.expectsDistributed,
        degraded: state.degraded,
        failures: state.failures,
        fallbacks: state.fallbacks,
        lastFailureAt: state.lastFailureAt,
        lastError: state.lastErrorCode
          ? { code: state.lastErrorCode, rpc: state.lastErrorRpc }
          : null
      };
    },
    reset() {
      memory.clear();
    }
  };
}
