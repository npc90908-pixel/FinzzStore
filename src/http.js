// ============================================================================
// HTTP HELPERS — body reading with strict limits, JSON/HTML responses, cookies.
// Built on node:http primitives only.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { AppError, errors } from './errors.js';
import { clearCookie, parseCookies, serializeCookie } from './security.js';

export function requestId() {
  return randomUUID();
}

export function getHeader(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read and parse a JSON body with a hard byte limit and Content-Type check.
 * Aborts the socket when the limit is exceeded to avoid buffering garbage.
 */
export async function readJson(req, { limit = 64 * 1024, requireJson = true } = {}) {
  const contentType = String(getHeader(req, 'content-type') || '').split(';')[0].trim().toLowerCase();
  if (requireJson && contentType !== 'application/json') throw errors.unsupportedMedia();
  const declared = Number(getHeader(req, 'content-length'));
  if (Number.isFinite(declared) && declared > limit) throw errors.payloadTooLarge(limit);

  const raw = await readRaw(req, { limit });
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', 'Body JSON tidak valid.', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_JSON', 'Body harus berupa objek JSON.', 400);
  }
  return parsed;
}

export async function readRaw(req, { limit = 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      req.destroy();
      throw errors.payloadTooLarge(limit);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    ...headers
  });
  res.end(body);
}

export function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

export function sendError(res, error, { requestId: id, logger } = {}) {
  const isApp = error instanceof AppError;
  // ValidationError (validation.js) and other domain errors mark themselves as
  // `expose: true` with a 4xx status. They must reach the client as a real
  // validation response instead of a generic 500.
  const isDomain = !isApp && error?.expose === true && Number.isInteger(error?.status)
    && error.status >= 400 && error.status < 500 && typeof error?.code === 'string';
  const exposed = isApp || isDomain;
  const status = exposed ? error.status : 500;
  const payload = {
    error: {
      code: exposed ? error.code : 'INTERNAL_ERROR',
      message: exposed ? error.message : 'Terjadi kesalahan pada server.',
      ...(error?.field ? { field: error.field } : {}),
      ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}),
      ...(error?.allowed ? { allowed: error.allowed } : {}),
      // Structured, already-safe detail (e.g. the verification context a login
      // must hand back so the user does not retype their email). Only fields
      // explicitly attached by our own code reach this point.
      ...(error?.verification ? { verification: error.verification } : {}),
      requestId: id || null
    }
  };
  if (!exposed || status >= 500) {
    logger?.error?.('request failed', {
      err: error,
      requestId: id,
      status,
      code: error?.code
    });
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, payload, error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
}

export function sendHtml(res, status, html, { nonce, config, headers = {} } = {}) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...(nonce ? { 'Content-Security-Policy': buildCsp(nonce, config) } : {}),
    ...headers
  });
  res.end(body);
}

export function buildCsp(nonce, config = {}) {
  const turnstileSources = config?.turnstile?.enabled ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${turnstileSources}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${turnstileSources}`,
    ...(config?.turnstile?.enabled ? ["frame-src 'self' https://challenges.cloudflare.com"] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "manifest-src 'self'"
  ].join('; ');
}

export function cookies(req) {
  return parseCookies(getHeader(req, 'cookie') || '');
}

export function appendCookies(res, cookieStrings) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing.slice() : [String(existing)]) : [];
  for (const c of cookieStrings) if (c) list.push(c);
  if (list.length) res.setHeader('Set-Cookie', list);
}

export function setSessionCookies(res, config, { sessionToken, csrfToken }) {
  const common = { secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: '/' };
  appendCookies(res, [
    serializeCookie(config.cookie.name, sessionToken, {
      ...common,
      httpOnly: true,
      maxAge: config.cookie.maxAgeSeconds
    }),
    serializeCookie(config.cookie.csrfName, csrfToken, {
      ...common,
      httpOnly: false,
      maxAge: config.cookie.maxAgeSeconds
    })
  ]);
}

/** Refresh only the readable CSRF cookie (session cookie stays untouched). */
export function setCsrfCookie(res, config, csrfToken) {
  const common = { secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: '/' };
  appendCookies(res, [
    serializeCookie(config.cookie.csrfName, csrfToken, {
      ...common,
      httpOnly: false,
      maxAge: config.cookie.maxAgeSeconds
    })
  ]);
}

/** Proof-of-registration cookie. HttpOnly: the page never sees the token. */
export function setVerifyCookie(res, config, token, maxAgeSeconds) {
  appendCookies(res, [
    serializeCookie(config.cookie.verifyName, token, {
      secure: config.cookie.secure,
      sameSite: config.cookie.sameSite,
      path: '/',
      httpOnly: true,
      maxAge: maxAgeSeconds
    })
  ]);
}

export function clearVerifyCookie(res, config) {
  appendCookies(res, [
    clearCookie(config.cookie.verifyName, {
      secure: config.cookie.secure,
      sameSite: config.cookie.sameSite,
      path: '/',
      httpOnly: true
    })
  ]);
}

export function clearSessionCookies(res, config) {
  const common = { secure: config.cookie.secure, sameSite: config.cookie.sameSite, path: '/' };
  appendCookies(res, [
    clearCookie(config.cookie.name, { ...common, httpOnly: true }),
    clearCookie(config.cookie.csrfName, { ...common, httpOnly: false })
  ]);
}

/** Basic in-memory guard against runaway duplicate submissions per process. */
export function createInFlightGuard() {
  const active = new Set();
  return {
    async run(key, fn) {
      if (active.has(key)) throw new AppError('DUPLICATE_SUBMIT', 'Permintaan sebelumnya masih diproses.', 409);
      active.add(key);
      try {
        return await fn();
      } finally {
        active.delete(key);
      }
    }
  };
}
