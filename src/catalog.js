// ============================================================================
// CATALOG — mirrors the supplier catalogue into public.services with the
// configured markup, and serves the public catalogue to landing page/services.
//
// Sync policy (explicit, to respect supplier rate limits):
//   servers -> apps (allowlist) -> countries per app (top N by stock) -> prices
//   only the cheapest offer per (app, country) becomes a sellable service.
//   `refresh` is left at the supplier default (0) so cached catalogue data is
//   used; a forced refresh would multiply upstream calls.
// ============================================================================
import { composePrice, fromDbAmount, resolvePrice, describePricing } from './money.js';

const SERVICE_CODE = (server, appId, countryId) => `tk-${server}-${appId}-${countryId}`;

/** Bounded concurrency: protects the supplier's rate limit and our latency. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createCatalogService({ db, supplier, settings, logger, config }) {
  const state = {
    lastRunAt: null,
    lastResult: null,
    running: false
  };

  const pricingPolicy = async () => settings.get('pricing_policy');
  const supplierSettings = async () => settings.get('supplier');

  /** Public catalogue with integer prices, grouped for the UI. */
  async function listPublic() {
    const rows = await db.services.listPublic();
    const services = rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      appId: row.provider_app_id,
      appName: row.app_name,
      countryId: row.country_id,
      countryName: row.country_name,
      countryIso: row.country_iso,
      callingCode: row.country_calling_code,
      price: fromDbAmount(row.price),
      stock: row.stock,
      active: row.is_active,
      syncedAt: row.price_synced_at,
      sortOrder: row.sort_order
    }));

    const byApp = new Map();
    for (const s of services) {
      const entry = byApp.get(s.appId) || { id: s.appId, name: s.appName, countries: [], minPrice: s.price, totalStock: 0 };
      entry.countries.push(s);
      entry.minPrice = Math.min(entry.minPrice, s.price);
      entry.totalStock += s.stock;
      byApp.set(s.appId, entry);
    }
    for (const entry of byApp.values()) {
      entry.countries.sort((a, b) => a.price - b.price);
      entry.countryCount = entry.countries.length;
    }

    return {
      services,
      apps: [...byApp.values()].sort((a, b) => a.name.localeCompare(b.name)),
      countries: [
        ...new Map(
          services.map((s) => [s.countryId, { id: s.countryId, name: s.countryName, iso: s.countryIso, callingCode: s.callingCode }])
        ).values()
      ].sort((a, b) => a.name.localeCompare(b.name)),
      syncedAt: services.reduce((acc, s) => (s.syncedAt && (!acc || s.syncedAt > acc) ? s.syncedAt : acc), null),
      source: supplier.isMock ? 'mock' : supplier.isConfigured ? 'supplier' : 'unavailable'
    };
  }

  /** Live quote for one app + country, used when a user picks a number. */
  async function quote({ serviceId, appId, countryId, serverId }) {
    const sup = await supplierSettings();
    const policy = await pricingPolicy();
    let service = null;
    if (serviceId) {
      service = await db.services.get(serviceId);
      if (!service || !service.is_active) throw Object.assign(new Error('Layanan tidak tersedia'), { status: 404, expose: true, code: 'SERVICE_NOT_AVAILABLE' });
    }

    const app = appId || service?.provider_app_id;
    const country = countryId || service?.country_id;
    const server = serverId || service?.provider_server || sup.server || 'server1';

    if (!supplier.quotesEnabled || !supplier.isConfigured) {
      // No live supplier: fall back to the last synchronised price, clearly
      // flagged so the UI can show "harga terakhir tersinkron".
      if (!service) throw Object.assign(new Error('Harga live tidak tersedia'), { status: 503, expose: true, code: 'CATALOG_STALE' });
      const priced = resolvePrice({
        supplierPrice: fromDbAmount(service.supplier_price),
        policy,
        serviceMarkupBps: service.markup_bps,
        category: service.provider_app_id
      });
      return {
        offerId: null,
        supplierPrice: priced.supplierPrice,
        markupBps: priced.markupBps,
        taxBps: policy.tax_bps,
        price: priced,
        stock: service.stock,
        quotedAt: service.price_synced_at,
        live: false
      };
    }

    const { offers, quotedAt } = await supplier.getPrices({ server, app, country });
    if (!offers.length) {
      throw Object.assign(new Error('Nomor untuk kombinasi ini sedang kosong'), { status: 409, expose: true, code: 'OUT_OF_STOCK' });
    }
    const cheapest = offers[0];
    // Override precedence is resolved centrally (service > category > default).
    // Previously this path used the global default and silently ignored a
    // per-service markup set in the admin panel.
    const priced = resolvePrice({
      supplierPrice: cheapest.price,
      policy,
      serviceMarkupBps: service?.markup_bps ?? null,
      category: app || service?.provider_app_id || null
    });
    const markupBps = priced.markupBps;
    const price = priced;
    return {
      offerId: cheapest.offerId,
      offerKey: cheapest.id,
      supplierPrice: priced.supplierPrice,
      markupBps,
      taxBps: policy.tax_bps,
      price,
      stock: offers.reduce((s, o) => s + o.stock, 0),
      quotedAt,
      server,
      live: true
    };
  }

  /**
   * Full catalogue synchronisation (called by a job, never by a request).
   *
   * Two production constraints shape this loop:
   *   · serverless functions are killed at maxDuration, so the sync stops
   *     itself first and leaves previous rows intact — a half-filled server
   *     payload would deactivate the rows it never fetched;
   *   · TeleKos rate-limits, so price fetches run with bounded concurrency
   *     instead of one-at-a-time.
   */
  async function sync({
    trigger = 'scheduler',
    maxCountriesPerApp = 12,
    maxApps = 10,
    budgetMs = config?.jobs?.catalogSyncBudgetMs ?? 45000,
    concurrency = config?.jobs?.catalogSyncConcurrency ?? 6
  } = {}) {
    if (state.running) return { skipped: true, reason: 'already_running' };
    if (!supplier.isConfigured) return { skipped: true, reason: 'supplier_not_configured' };

    state.running = true;
    const started = Date.now();
    const outOfBudget = () => Date.now() - started > budgetMs;
    const sup = await supplierSettings();
    const policy = await pricingPolicy();
    const allowlist = Array.isArray(sup.app_allowlist) ? sup.app_allowlist : [];
    let upserted = 0;
    let deactivated = 0;
    const errors = [];
    const incompleteServers = [];
    const provider = supplier.mode === 'mock' ? 'telekos-mock' : 'telekos';

    await db.services.recordSyncRun({ provider, status: 'running', server: sup.server, started_at: new Date().toISOString() });

    try {
      const servers = await supplier.getServers();
      const usable = servers.filter((s) => s.available && !s.maintenance).map((s) => s.id);
      const serverIds = usable.includes(sup.server) ? [sup.server, ...usable.filter((s) => s !== sup.server)].slice(0, 2) : usable.slice(0, 2);
      if (!serverIds.length) throw new Error('tidak ada server supplier yang tersedia');

      for (const server of serverIds) {
        if (outOfBudget()) { incompleteServers.push(`${server}:budget`); continue; }

        const apps = (await supplier.getApps(server))
          .filter((a) => allowlist.length === 0 || allowlist.includes(a.id))
          .slice(0, maxApps);

        // Countries are cheap (one call per app); prices are the expensive part.
        const countriesByApp = await mapLimit(apps, concurrency, async (app) => {
          try {
            return { app, countries: await supplier.getCountries({ server, app: app.id }) };
          } catch (err) {
            errors.push(`${server}/${app.id}: ${err.code || err.message}`);
            return { app, countries: [] };
          }
        });

        const tasks = [];
        for (const { app, countries } of countriesByApp) {
          const withStock = countries
            .filter((c) => c.stock > 0)
            .sort((a, b) => b.stock - a.stock)
            .slice(0, maxCountriesPerApp);
          for (const country of withStock) tasks.push({ app, country });
        }

        let aborted = false;
        const priced = await mapLimit(tasks, concurrency, async ({ app, country }) => {
          if (aborted || outOfBudget()) { aborted = true; return null; }
          try {
            const { offers } = await supplier.getPrices({ server, app: app.id, country: country.id });
            if (!offers.length) return null;
            const cheapest = offers[0];
            // The catalogue must display exactly what checkout will charge, so
            // it goes through the same engine and stores the markup that was
            // actually applied (fixed markup, min margin and rounding included).
            const composed = resolvePrice({
              supplierPrice: cheapest.price,
              policy,
              category: app.id
            });
            return {
              code: SERVICE_CODE(server, app.id, country.id),
              name: `${app.name} ${country.name}`,
              provider_app_id: app.id,
              app_name: app.name,
              country_id: country.id,
              country_name: country.name,
              country_iso: country.iso,
              country_calling_code: country.callingCode,
              supplier_price: composed.supplierPrice,
              markup_bps: composed.markupBps,
              price: composed.totalPrice,
              stock: offers.reduce((total, o) => total + o.stock, 0),
              is_active: offers.some((o) => o.stock > 0)
            };
          } catch (err) {
            errors.push(`${server}/${app.id}/${country.id}: ${err.code || err.message}`);
            return null;
          }
        });

        const serverItems = priced.filter(Boolean);
        // A partial payload would deactivate rows we never fetched, so an
        // aborted sweep writes nothing for that server.
        if (aborted) {
          incompleteServers.push(`${server}:budget`);
        } else if (serverItems.length) {
          const result = await db.services.sync(provider, server, serverItems);
          upserted += result.upserted;
          deactivated += result.deactivated;
        }
      }

      const status = incompleteServers.length
        ? (upserted > 0 ? 'partial' : 'failed')
        : errors.length === 0 ? 'success' : upserted > 0 ? 'partial' : 'failed';
      state.lastRunAt = new Date().toISOString();
      state.lastResult = {
        status,
        upserted,
        deactivated,
        errors: errors.slice(0, 10),
        incompleteServers,
        durationMs: Date.now() - started,
        trigger
      };
      await db.services.recordSyncRun({
        provider,
        status,
        services_upserted: upserted,
        services_seen: upserted + deactivated,
        error: (errors.length || incompleteServers.length)
          ? [...errors.slice(0, 4), ...incompleteServers].join('; ')
          : null,
        finished_at: new Date().toISOString()
      });
      logger.info('catalog sync finished', state.lastResult);
      return state.lastResult;
    } catch (err) {
      state.lastResult = { status: 'failed', error: err.message, durationMs: Date.now() - started, trigger };
      logger.error('catalog sync failed', { error: err.message });
      await db.services.recordSyncRun({
        provider, status: 'failed', error: String(err.message).slice(0, 300),
        finished_at: new Date().toISOString()
      }).catch(() => {});
      return state.lastResult;
    } finally {
      state.running = false;
    }
  }

  return {
    listPublic,
    quote,
    sync,
    get status() {
      return {
        ...state,
        supplier: supplier.status(),
        mode: config.supplier.mode
      };
    }
  };
}
