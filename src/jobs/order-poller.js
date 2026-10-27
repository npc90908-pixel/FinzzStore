// ============================================================================
// ORDER POLLER JOB
//
// * Runs every ORDER_POLL_INTERVAL_MS (default 15s) — the browser polls its own
//   visible order every 4s, this job keeps state correct without a browser.
// * A PostgreSQL job lease guarantees that only ONE PM2 instance (or one of its
//   workers) polls at a time, even with several processes.
// * Orders are claimed with `for update skip locked` (rpc_claim_orders_for_sync)
//   and a 45s lease, so two workers can never process the same order.
// * State lives in PostgreSQL: a restart resumes exactly where it stopped.
// ============================================================================
import { randomUUID } from 'node:crypto';

export function createOrderPoller({ db, orders, logger, config }) {
  const workerId = `poller-${process.pid}-${randomUUID().slice(0, 8)}`;
  let timer = null;
  let running = false;
  const stats = { ticks: 0, processed: 0, failures: 0, lastTickAt: null, lastError: null, skippedLease: 0 };

  async function tick({ force = false } = {}) {
    if (running && !force) return { skipped: 'busy' };
    running = true;
    try {
      const leaseSeconds = config.jobs.leaseSeconds + 15;
      const hasLease = await db.jobs.acquire('order-poller', workerId, leaseSeconds);
      if (!hasLease) {
        stats.skippedLease += 1;
        return { skipped: 'lease' };
      }

      const claimed = await db.orders.claimForSync(
        config.jobs.pollBatchSize,
        config.jobs.leaseSeconds,
        workerId
      );
      stats.ticks += 1;
      stats.lastTickAt = new Date().toISOString();

      let processed = 0;
      for (const order of claimed) {
        try {
          const result = await orders.syncOrder(order, { worker: workerId });
          if (result?.changed) processed += 1;
        } catch (err) {
          stats.failures += 1;
          stats.lastError = { at: new Date().toISOString(), message: err?.message, orderId: order.id };
          logger.error('order sync failed', { orderId: order.id, error: err?.message });
          await db.orders.releaseLease(order.id, new Date(Date.now() + 60000).toISOString(), 'SYNC_ERROR', err?.message)
            .catch(() => {});
        }
      }
      stats.processed += processed;
      if (claimed.length) logger.info('order poller tick', { claimed: claimed.length, processed });
      return { claimed: claimed.length, processed };
    } catch (err) {
      stats.failures += 1;
      stats.lastError = { at: new Date().toISOString(), message: err?.message };
      logger.error('order poller tick failed', { error: err?.message });
      return { error: err?.message };
    } finally {
      running = false;
    }
  }

  return {
    workerId,
    tick,
    start() {
      if (!config.jobs.enabled || !config.jobs.orderPoller) {
        logger.info('order poller disabled by configuration');
        return;
      }
      if (timer) return;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, config.jobs.pollIntervalMs);
      timer.unref?.();
      logger.info('order poller started', { intervalMs: config.jobs.pollIntervalMs, workerId });
      // First tick shortly after boot, after the HTTP server is listening.
      setTimeout(() => tick().catch(() => {}), 2500).unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await db.jobs.release('order-poller', workerId).catch(() => {});
      logger.info('order poller stopped');
    },
    get stats() {
      return { ...stats, workerId, intervalMs: config.jobs.pollIntervalMs, running };
    }
  };
}
