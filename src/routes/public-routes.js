// ============================================================================
// PUBLIC ROUTES — health, public settings, catalogue and live quotes.
// Nothing here exposes secrets, balances or personal data.
// ============================================================================
import { AppError, errors } from '../errors.js';
import { publicConfigView } from '../config.js';
import { ok } from './helpers.js';

export function registerPublicRoutes({ router }) {
  router.get('/api/health', async (ctx) => {
    const started = Date.now();
    let dbStatus;
    try {
      dbStatus = { ...(await ctx.db.ping()), ok: true };
    } catch (err) {
      dbStatus = { ok: false, error: err.message };
    }
    const supplierStatus = ctx.services.supplier.status();
    const paymentStatus = ctx.services.payment.status();
    const body = {
      ok: dbStatus.ok,
      time: new Date().toISOString(),
      latencyMs: Date.now() - started,
      version: ctx.config.version,
      environment: ctx.config.nodeEnv,
      database: { driver: ctx.db.kind, ok: dbStatus.ok, latencyMs: dbStatus.latencyMs ?? null },
      supplier: {
        mode: supplierStatus.mode,
        configured: supplierStatus.configured,
        mock: Boolean(supplierStatus.mock),
        // TeleKos: verified means every read endpoint answered with real data
        // on this process. Never report `active`/`real-time` here.
        contractVerified: Boolean(supplierStatus.contractVerified),
        verifiedEndpoints: Array.isArray(supplierStatus.verifiedEndpoints)
          ? supplierStatus.verifiedEndpoints
          : [],
        webhookConfigured: Boolean(supplierStatus.webhookConfigured),
        lastCheckedAt: supplierStatus.lastSuccessAt,
        lastSuccessAt: supplierStatus.lastSuccessAt,
        lastError: supplierStatus.lastError ? supplierStatus.lastError.code : null
      },
      rateLimiter: ctx.services.rateLimiter ? ctx.services.rateLimiter.status() : null,
      payment: { enabled: paymentStatus.enabled, mode: paymentStatus.mode },
      jobs: ctx.services.jobs
        ? { poller: ctx.services.jobs.poller.stats, reconciliation: ctx.services.jobs.reconciliation.stats }
        : null
    };
    return ok(body);
  });

  router.get('/api/public/config', async (ctx) => {
    const publicSettings = await ctx.services.settings.getPublicWithStatus();
    const settings = publicSettings.values;
    const store = settings.store_profile;
    return ok({
      /**
       * `settingsAvailable: false` means the database could not be read and the
       * values below are DEFAULTS. The UI must label them instead of presenting
       * a default deposit limit as the store's real policy.
       */
      settingsAvailable: publicSettings.available,
      app: publicConfigView(ctx.config),
      store: {
        name: store.name,
        tagline: store.tagline,
        supportEmail: store.support_email || null,
        supportWhatsapp: store.support_whatsapp || null,
        supportTelegram: store.support_telegram || null
      },
      deposit: {
        minAmount: settings.deposit_policy.min_amount,
        maxAmount: settings.deposit_policy.max_amount,
        instructions: settings.deposit_policy.instructions,
        bankAccounts: settings.deposit_policy.bank_accounts,
        expiryHours: settings.deposit_policy.expiry_hours
      },
      operations: {
        salesOpen: settings.operations.sales_open,
        maintenanceMessage: settings.operations.maintenance_message,
        orderPollIntervalMs: settings.operations.order_poll_interval_ms,
        orderExpirySeconds: settings.operations.order_expiry_seconds,
        maxActiveOrders: settings.operations.max_active_orders_per_user
      },
      refundPolicy: settings.refund_policy.summary,
      legal: settings.legal,
      payment: ctx.services.payment.status()
    });
  });

  /**
   * Public catalogue.
   *
   * Production 2026-10-26: this endpoint answered HTTP 500 whenever
   * `rpc_public_summary` failed, even though the catalogue rows were perfectly
   * readable — a decorative count took the whole storefront down.
   *
   * The summary is now best-effort:
   *   * rows are served from `services` (the source of truth);
   *   * counts fall back to values derived from those same rows;
   *   * `summarySource` tells the UI where the numbers came from, so it never
   *     presents a derived/invented figure as a supplier statistic;
   *   * only a failure to read the catalogue itself can still fail the request,
   *     and then it answers 503 with a retryable code, not a bare 500.
   */
  router.get('/api/public/catalog', async (ctx) => {
    let catalog;
    try {
      catalog = await ctx.services.catalog.listPublic();
    } catch (err) {
      ctx.logger.error('public catalog read failed', {
        code: err?.code || null,
        pgCode: err?.pgCode || null,
        pgMessage: err?.pgMessage || null,
        table: err?.table || 'services'
      });
      throw new AppError(
        'CATALOG_UNAVAILABLE',
        'Katalog sedang tidak dapat dimuat. Coba lagi beberapa saat lagi.',
        503,
        { retryAfter: 30 }
      );
    }

    let summary = null;
    let summarySource = 'rpc';
    try {
      const raw = await ctx.db.publicSummary();
      summary = {
        activeServices: raw.active_services,
        countries: raw.countries,
        apps: raw.apps,
        lastCatalogSync: raw.last_catalog_sync
      };
    } catch (err) {
      summarySource = 'derived';
      ctx.logger.warn('public summary RPC failed, deriving counts from the catalog', {
        code: err?.code || null,
        pgCode: err?.pgCode || null,
        pgMessage: err?.pgMessage || null,
        rpc: err?.rpc || 'rpc_public_summary'
      });
      // Same source, same rows: these are real counts, just computed here.
      summary = {
        activeServices: catalog.services.length,
        countries: catalog.countries.length,
        apps: catalog.apps.length,
        lastCatalogSync: catalog.syncedAt || null
      };
    }

    return ok({
      ...catalog,
      summary,
      summarySource,
      // Evidence, not assumption: `available` only turns true when the catalog
      // actually holds rows. A configured supplier with a rejected API key
      // reports 0 services, so claiming "available" would be a lie.
      available:
        catalog.source !== 'unavailable' &&
        (catalog.services.length > 0 || catalog.apps.length > 0)
    });
  });

  router.get('/api/public/summary', async (ctx) => {
    try {
      const summary = await ctx.db.publicSummary();
      return ok({
        available: true,
        activeServices: summary.active_services,
        countries: summary.countries,
        apps: summary.apps,
        lastCatalogSync: summary.last_catalog_sync,
        generatedAt: summary.generated_at
      });
    } catch (err) {
      ctx.logger.warn('public summary unavailable', {
        code: err?.code || null,
        pgCode: err?.pgCode || null,
        rpc: err?.rpc || 'rpc_public_summary'
      });
      // 200 with available:false — the landing page renders "data belum
      // tersedia" and never invents numbers.
      return ok({
        available: false,
        activeServices: null,
        countries: null,
        apps: null,
        lastCatalogSync: null,
        generatedAt: null,
        reason: 'SUMMARY_UNAVAILABLE'
      });
    }
  });

  router.get('/api/public/quote', async (ctx) => {
    const session = await ctx.requireUser();
    const limiter = ctx.services.rateLimiter;
    if (limiter) await limiter.enforce(`quote:${session.user.id}`, 40, 60);

    const serviceId = ctx.query.get('service_id');
    if (!serviceId) throw errors.badRequest('Parameter service_id wajib diisi.', 'MISSING_FIELD');
    const quote = await ctx.services.catalog.quote({ serviceId });
    return ok({
      supplierPrice: quote.supplierPrice,
      markupBps: quote.markupBps,
      price: quote.price,
      stock: quote.stock,
      quotedAt: quote.quotedAt,
      live: quote.live,
      server: quote.server || null
    });
  });
}
