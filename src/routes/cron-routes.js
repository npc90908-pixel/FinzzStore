// ============================================================================
// CRON ROUTES — every durable job is triggered from outside the process.
//
// Vercel (and any serverless runtime) has no long-lived worker, and the master
// rule for this project is: no in-memory timers for durable work. So the
// scheduler is external (cron-job.org in production, or Vercel Cron), and it
// calls these endpoints over HTTPS with a shared secret.
//
// Guarantees implemented here:
//   * `Authorization: Bearer <CRON_SECRET>`, compared in constant time;
//   * a PostgreSQL lock (public.cron_locks) so two overlapping invocations —
//     two scheduler retries, two regions, a manual curl during a scheduled run —
//     can never execute the same job twice;
//   * the lock has a TTL, so a crashed invocation cannot block the schedule;
//   * every run is recorded (status + result summary) and is visible in the
//     admin panel through /api/admin/health.
//
// Both POST (documented) and GET (Vercel Cron compatibility) are accepted.
// ============================================================================
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { ok } from './helpers.js';

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // timingSafeEqual requires equal lengths; compare a hash-free fixed buffer so
  // the length check itself does not leak timing on the secret's prefix.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function authorize(ctx, config) {
  const secret = config.cron.secret;
  if (!secret) throw new AppError('CRON_NOT_CONFIGURED', 'CRON_SECRET belum diset.', 503);
  const header = String(ctx.req.headers.authorization || '');
  const given = header.replace(/^Bearer\s+/i, '');
  if (!given || !constantTimeEquals(given, secret)) {
    throw new AppError('UNAUTHORIZED', 'Tidak diizinkan.', 401);
  }
}

/**
 * Run `fn` while holding a named PostgreSQL lock.
 * Returns {skipped:'locked'} instead of running twice — a 200, because a
 * scheduler must not treat "already running" as a failure worth retrying.
 */
function runLocked(ctx, config, name, fn) {
  const owner = `cron-${randomUUID()}`;
  return (async () => {
    const claim = await ctx.db.cron.claim(name, owner, config.cron.lockTtlSeconds);
    if (!claim.claimed) {
      ctx.logger.info('cron skipped, lock held elsewhere', {
        job: name,
        owner: claim.owner,
        lockedUntil: claim.locked_until
      });
      return { job: name, skipped: 'locked', lockedUntil: claim.locked_until };
    }

    const startedAt = Date.now();
    try {
      const result = await fn();
      const payload = { job: name, ran: true, durationMs: Date.now() - startedAt, result };
      await ctx.db.cron.release(name, owner, 'success', summarize(result));
      ctx.logger.info('cron finished', { job: name, durationMs: payload.durationMs });
      return payload;
    } catch (err) {
      await ctx.db.cron
        .release(name, owner, 'error', { error: String(err.message).slice(0, 200) })
        .catch(() => {});
      ctx.logger.error('cron failed', { job: name, error: err.message, code: err.code });
      throw err;
    }
  })();
}

/** Keep the stored result small: cron_locks.last_result is for humans. */
function summarize(result) {
  if (!result || typeof result !== 'object') return { value: String(result).slice(0, 200) };
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    } else if (Array.isArray(value)) {
      out[key] = `${value.length} item`;
    } else if (typeof value === 'object') {
      out[key] = 'obj';
    }
  }
  return out;
}

export function registerCronRoutes({ router, config, services, logger }) {
  const handler = (name, fn) => async (ctx) => {
    authorize(ctx, config);
    const outcome = await runLocked({ ...ctx, logger }, config, name, () => fn(ctx));
    return ok(outcome);
  };

  // Poll open orders at the supplier. Safe to call every minute.
  const poll = handler('orders.poller', () => services.jobs.poller.tick({ force: true }));

  // Reconcile ambiguous orders, refunds and the catalogue in one sweep.
  const reconcile = handler('orders.reconcile', async () => {
    const result = await services.jobs.reconciliation.runOnce();
    const catalog = await services.jobs.reconciliation
      .runCatalogSync({ trigger: 'cron' })
      .catch((err) => ({ error: err.message }));
    return { ...result, catalog };
  });

  // Catalogue-only refresh, for schedules that want a longer interval.
  const catalog = handler('catalog.sync', () => services.jobs.reconciliation.runCatalogSync({ trigger: 'cron' }));

  for (const path of ['/api/cron/poll', '/api/cron/reconcile', '/api/cron/catalog']) {
    const routes = { '/api/cron/poll': poll, '/api/cron/reconcile': reconcile, '/api/cron/catalog': catalog };
    router.post(path, routes[path], { public: true });
    // Vercel Cron issues GET requests; keep it working without weakening auth.
    router.get(path, routes[path], { public: true });
  }
}
