// ============================================================================
// SHARED ROUTE HELPERS
// ============================================================================
import { errors } from '../errors.js';

export function parsePage(query, { defaultPerPage = 12, maxPerPage = 50 } = {}) {
  const page = Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, Number.parseInt(query.get('per_page') || String(defaultPerPage), 10) || defaultPerPage));
  return { page, perPage };
}

/**
 * Enforce a rate limit bucket; throws a 429 AppError when exceeded.
 *
 * @param {object} [options]
 * @param {boolean} [options.critical] sensitive endpoint (login, register,
 *   password reset, deposit, order creation, admin actions). When the shared
 *   limiter store is unavailable these fail CLOSED (503) instead of running
 *   unprotected on per-instance memory.
 */
export async function enforceLimit(ctx, bucket, limit, windowSeconds, options = {}) {
  const limiter = ctx.services.rateLimiter;
  if (!limiter) return null;
  return limiter.enforce(bucket, limit, windowSeconds, options);
}

export const ok = (body) => ({ status: 200, body });
export const created = (body) => ({ status: 201, body });
export const accepted = (body) => ({ status: 202, body });

export function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw errors.badRequest(`Field ${field} wajib diisi.`, 'MISSING_FIELD');
    }
  }
}

export function adminMeta(ctx) {
  return { ip: ctx.ip, userAgent: ctx.userAgent };
}
