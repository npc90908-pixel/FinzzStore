// ============================================================================
// RECONCILIATION JOB
//
// Every minute (single lease across all PM2 instances):
//   1. flag `pending` orders that lost their supplier reference as needs_review
//      (never auto-refunded: we cannot prove the supplier has no order)
//   2. delete expired server sessions
//   3. re-sync orders stuck in `needs_review`
// Every 30 minutes: refresh the supplier catalogue (separate lease).
// ============================================================================
import { randomUUID } from 'node:crypto';

export function createReconciliationJob({ db, orders, catalog, auth, logger, config, state }) {
  const workerId = `recon-${process.pid}-${randomUUID().slice(0, 8)}`;
  let timer = null;
  let catalogTimer = null;
  const stats = {
    runs: 0,
    orphaned: 0,
    needsReviewRetried: 0,
    sessionsCleaned: 0,
    catalogSyncs: 0,
    lastRunAt: null,
    lastCatalogSyncAt: null,
    lastError: null
  };

  async function runOnce() {
    const hasLease = await db.jobs.acquire('reconciliation', workerId, 120);
    if (!hasLease) return { skipped: 'lease' };
    try {
      const orphaned = await db.orders.flagOrphans(180);
      stats.orphaned += orphaned;

      // Give ambiguous orders another chance to resolve against the supplier.
      const { rows } = await db.orders.adminList({ status: 'needs_review', limit: 10 });
      for (const order of rows) {
        if (!order.supplier_order_id) continue;
        try {
          await orders.syncOrder(order, { worker: workerId });
          stats.needsReviewRetried += 1;
        } catch (err) {
          logger.warn('needs_review re-sync failed', { orderId: order.id, error: err?.message });
        }
      }

      if (auth) {
        await auth.cleanup();
        stats.sessionsCleaned += 1;
      }

      stats.runs += 1;
      stats.lastRunAt = new Date().toISOString();
      if (orphaned) logger.warn('orders flagged for review', { count: orphaned });
      return { orphaned, retried: stats.needsReviewRetried };
    } catch (err) {
      stats.lastError = { at: new Date().toISOString(), message: err?.message };
      logger.error('reconciliation failed', { error: err?.message });
      return { error: err?.message };
    } finally {
      await db.jobs.release('reconciliation', workerId).catch(() => {});
    }
  }

  async function runCatalogSync({ trigger = 'scheduler' } = {}) {
    if (!catalog || !config.supplier.quotesEnabled) return { skipped: 'supplier_disabled' };
    const hasLease = await db.jobs.acquire('catalog-sync', `${workerId}-cat`, 900);
    if (!hasLease) return { skipped: 'lease' };
    try {
      const result = await catalog.sync({ trigger });
      stats.catalogSyncs += 1;
      stats.lastCatalogSyncAt = new Date().toISOString();
      if (state) state.lastCatalogSync = result;
      return result;
    } finally {
      await db.jobs.release('catalog-sync', `${workerId}-cat`).catch(() => {});
    }
  }

  return {
    workerId,
    runOnce,
    runCatalogSync,
    start() {
      if (!config.jobs.enabled) return;
      if (config.jobs.reconciliation && !timer) {
        timer = setInterval(() => runOnce().catch(() => {}), config.jobs.reconcileIntervalMs);
        timer.unref?.();
        setTimeout(() => runOnce().catch(() => {}), 8000).unref?.();
        logger.info('reconciliation job started', { intervalMs: config.jobs.reconcileIntervalMs });
      }
      // Catalogue refresh: a quick warm-up after boot (the storefront must not
      // show "data unavailable" for the first half-minute), then every 30 min.
      if (config.supplier.quotesEnabled && !catalogTimer) {
        catalogTimer = setInterval(() => runCatalogSync().catch(() => {}), 30 * 60 * 1000);
        catalogTimer.unref?.();
        const bootDelay = config.jobs.catalogBootDelayMs ?? 2000;
        setTimeout(() => {
          runCatalogSync({ trigger: 'startup' }).catch((err) => {
            logger.warn('startup catalog sync failed', { error: err?.message });
          });
        }, bootDelay).unref?.();
      }
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (catalogTimer) clearInterval(catalogTimer);
      timer = null;
      catalogTimer = null;
      await db.jobs.release('reconciliation', workerId).catch(() => {});
      logger.info('reconciliation job stopped');
    },
    get stats() {
      return { ...stats };
    }
  };
}
