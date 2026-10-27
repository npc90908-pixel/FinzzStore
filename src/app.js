// ============================================================================
// APPLICATION HANDLER — plain node:http. No framework.
//
// Responsibilities, in order: request id + nonce, security headers, static
// assets, API routing, page rendering, error handling. API 404s always return
// JSON; unknown page paths fall back to the SPA shell with a 404 status.
// ============================================================================
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { requestId, readJson, sendJson, sendError, sendHtml, cookies } from './http.js';
import { securityHeaders, assertRequestOrigin, requestOriginAllowed, clientIp } from './security.js';
import { AppError, errors } from './errors.js';
import { renderDocument } from './render.js';
import { pageFor } from './pages.js';
import { publicConfigView } from './config.js';
import { safeReturnPath } from './validation.js';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const STATIC_PREFIXES = ['/css/', '/js/', '/assets/'];

export function createApp({ config, logger, db, auth, services, router }) {
  const publicDir = path.resolve('public');

  const serveStatic = async (req, res, pathname) => {
    const relative = pathname.replace(/^\/+/, '');
    if (relative.includes('\0')) throw errors.badRequest('Path tidak valid.');
    const absolute = path.resolve(publicDir, relative);
    if (!absolute.startsWith(publicDir + path.sep)) throw errors.forbidden();
    const ext = path.extname(absolute).toLowerCase();
    if (ext === '.html' || !(ext in MIME)) throw errors.notFound('Aset');

    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw errors.notFound('Aset');

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': info.size,
      ETag: etag,
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(absolute).pipe(res);
    return true;
  };

  const buildContext = (req, res, { nonce, url, params, route }) => {
    const ip = clientIp(req, config);
    const ctx = {
      req,
      res,
      url,
      params: params || {},
      query: url.searchParams,
      requestId: req.requestId,
      nonce,
      config,
      logger,
      db,
      auth,
      services,
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      cookies: cookies(req),
      route: route || null,

      /** Authenticated context or 401. */
      async requireUser() {
        return auth.requireUser(req);
      },
      async requireAdmin() {
        return auth.requireAdmin(req);
      },
      /** CSRF check against the server-side session (double submit + hash). */
      async requireCsrf(authCtx) {
        const session = authCtx || (await auth.requireUser(req));
        if (!auth.verifyCsrf(req, session)) throw errors.csrf();
        return session;
      },
      readJson(options) {
        return readJson(req, { limit: config.limits.jsonBodyBytes, ...options });
      },
      json(status, body, headers) {
        sendJson(res, status, body, headers);
      }
    };
    return ctx;
  };

  async function handleApi(req, res, url, nonce) {
    const origin = req.headers.origin;
    if (origin) {
      if (!requestOriginAllowed(req, config)) {
        sendJson(res, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin tidak diizinkan.' } });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key, Accept');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const matched = router.match(req.method, url.pathname);
    if (!matched) {
      // API 404 must be JSON, never the SPA shell.
      sendJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Endpoint API tidak ditemukan.', requestId: req.requestId }
      });
      return;
    }
    if (matched.methodNotAllowed) {
      res.setHeader('Allow', matched.methodNotAllowed.join(', '));
      sendJson(res, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `Metode ${req.method} tidak didukung untuk endpoint ini.`,
          allowed: matched.methodNotAllowed,
          requestId: req.requestId
        }
      });
      return;
    }

    const { route, params } = matched;
    const ctx = buildContext(req, res, { nonce, url, params, route });

    // State-changing requests: verify origin always, CSRF unless the route is
    // explicitly public (login/register/reset/webhook with its own signature).
    if (!['GET', 'HEAD'].includes(req.method)) {
      assertRequestOrigin(req, config);
      if (route.meta?.public !== true && route.meta?.csrf !== false) {
        const session = await auth.requireUser(req);
        if (!auth.verifyCsrf(req, session)) throw errors.csrf();
      }
    }

    const result = await route.handler(ctx);
    if (res.headersSent) return;
    if (result === undefined) {
      sendJson(res, 204, {});
      return;
    }
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      sendJson(res, result.status, result.body, result.headers);
      return;
    }
    sendJson(res, 200, result);
  }

  async function handlePage(req, res, url, nonce) {
    const meta = pageFor(url.pathname);
    const authCtx = await auth.attach(req);

    // Anonymous visitor on a private page → login with a safe internal return path.
    if (meta?.requiresAuth && !authCtx) {
      const next = safeReturnPath(url.pathname + url.search, '/dashboard');
      res.writeHead(302, {
        Location: `/login?next=${encodeURIComponent(next)}`,
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }
    if (meta?.guestOnly && authCtx) {
      res.writeHead(302, { Location: '/dashboard', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    let status = 200;
    let pageMeta = meta;
    let pageKey = meta?.key;
    let errorPage = null;

    if (!meta) {
      status = 404;
      pageKey = 'not-found';
      pageMeta = { title: 'Halaman tidak ditemukan — FINZZ Store', description: 'Halaman tidak ditemukan.' };
    } else if (meta.requiresAdmin && authCtx?.profile.role !== 'admin') {
      status = 403;
      pageKey = 'forbidden';
      pageMeta = { title: 'Akses ditolak — FINZZ Store', description: 'Akses ditolak.' };
    }

    const state = {
      path: url.pathname + url.search,
      status,
      user: authCtx
        ? {
            id: authCtx.user.id,
            email: authCtx.user.email,
            username: authCtx.profile.username,
            fullName: authCtx.profile.full_name,
            role: authCtx.profile.role,
            status: authCtx.profile.status
          }
        : null,
      csrfToken: authCtx
        ? (() => {
            // The raw CSRF token is only available from the cookie (non-HttpOnly).
            const jar = cookies(req);
            return jar[config.cookie.csrfName] || null;
          })()
        : null,
      config: {
        ...publicConfigView(config),
        pollIntervalMs: 4000,
        supportEmail: null
      },
      preloaded: {}
    };

    const html = renderDocument({ page: pageKey, meta: pageMeta, nonce, state, status, errorPage });
    sendHtml(res, status, html, { nonce, config });
  }

  return async function handler(req, res) {
    const id = requestId();
    req.requestId = id;
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('X-Request-Id', id);
    for (const [header, value] of Object.entries(securityHeaders(nonce, config))) {
      res.setHeader(header, value);
    }

    // Pages whose URL carries a one-time secret (reset link, verification code)
    // must not leak it through the Referer header of any request they trigger.
    // `no-referrer` is stricter than the site-wide default on purpose.
    if (/^\/(reset-password|verify-email)(\/|$)/.test(String(req.url || '').split('?')[0])) {
      res.setHeader('Referrer-Policy', 'no-referrer');
    }

    let url;
    try {
      url = new URL(req.url, config.appUrl);
    } catch {
      sendError(res, errors.badRequest('URL tidak valid.'), { requestId: id, logger });
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, nonce);
        return;
      }
      if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
        if (!['GET', 'HEAD'].includes(req.method)) throw errors.methodNotAllowed(['GET', 'HEAD']);
        await serveStatic(req, res, url.pathname);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw errors.methodNotAllowed(['GET', 'HEAD']);
      await handlePage(req, res, url, nonce);
    } catch (err) {
      logger.error('unhandled request error', { requestId: id, path: url.pathname, err });
      if (res.headersSent) {
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendError(res, err, { requestId: id, logger });
        return;
      }
      const status = err instanceof AppError ? err.status : 500;
      const html = renderDocument({
        page: 'error',
        meta: { title: 'Terjadi kesalahan — FINZZ Store', description: 'Terjadi kesalahan pada server.' },
        nonce,
        status,
        state: { path: url.pathname, config: publicConfigView(config) },
        errorPage: err instanceof AppError && err.expose ? err.message : 'Terjadi kesalahan pada server.'
      });
      sendHtml(res, status, html, { nonce, config });
    }
  };
}
