// ============================================================================
// ORDER POLLER (client)
// * reads our own API every 4s while the tab is visible (cheap DB read);
// * asks the server to sync with the supplier at a slower cadence;
// * stops entirely when the tab is hidden or every order is terminal.
// ============================================================================

export function createOrderPoller({
  api,
  onOrders,
  onError = null,
  intervalMs = 4000,
  syncEveryMs = 12000,
  syncOrderId = null
}) {
  let timer = null;
  let inFlight = false;
  let stopped = false;
  let lastSyncAt = 0;

  const tick = async () => {
    if (stopped || inFlight) return;
    if (document.hidden) return;
    inFlight = true;
    try {
      const { orders } = await api.get('/api/orders/active', { retries: 0 });
      if (stopped) return;
      onOrders?.(orders || []);

      const active = (orders || []).filter((o) => ['pending', 'waiting', 'received', 'needs_review'].includes(o.status));
      if (active.length === 0) {
        stop();
        return;
      }

      const now = Date.now();
      if (now - lastSyncAt >= syncEveryMs) {
        const target = syncOrderId
          ? active.find((o) => o.id === syncOrderId) || active[0]
          : active.find((o) => o.status === 'waiting' || o.status === 'pending') || active[0];
        if (target) {
          lastSyncAt = now;
          api.post(`/api/orders/${target.id}/sync`).catch(() => {});
        }
      }
    } catch (err) {
      onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    tick();
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (document.hidden) {
      if (timer) clearInterval(timer);
      timer = null;
    } else if (!stopped) {
      start();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  start();

  return {
    stop() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    },
    refresh: tick
  };
}
