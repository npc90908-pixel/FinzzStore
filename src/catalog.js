// ============================================================================
// CATALOG — TeleKos discovery, live prices, safe checkout quotes, and the
// optional PostgreSQL catalogue mirror.
//
// The live adapter uses only the documented GET /servers, /apps,
// /countries and /prices routes. Public discovery is guest-readable, cached,
// single-flight within a process, and protected by a short PostgreSQL lease
// across workers. A caller can request a bounded /prices refresh; checkout
// always revalidates the selected supplier offer before charging the wallet.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { fromDbAmount, resolvePrice } from './money.js';

const SERVICE_CODE = (server, appId, countryId) => `tk-${server}-${appId}-${countryId}`;
const READ_CACHE_TTL_MS = 20_000;
const PRICE_CACHE_TTL_MS = 12_000;
const MAX_CACHE_ENTRIES = 500;
const READ_LEASE_SECONDS = 60;

/** Bounded concurrency protects the upstream rate limit and our latency. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function unavailable(message = 'Katalog TeleKos belum dapat dimuat. Coba lagi sebentar.') {
  return new AppError('CATALOG_UNAVAILABLE', message, 503, { retryAfter: 15 });
}

export function createCatalogService({ db, supplier, settings, logger, config }) {
  const state = {
    lastRunAt: null,
    lastResult: null,
    running: false,
    dynamicReads: 0,
    dynamicFailures: 0,
    lastDynamicSuccessAt: null,
    lastDynamicError: null
  };
  const dynamicCache = new Map();
  const inFlight = new Map();

  const remember = (key, entry) => {
    dynamicCache.delete(key);
    dynamicCache.set(key, entry);
    while (dynamicCache.size > MAX_CACHE_ENTRIES) {
      dynamicCache.delete(dynamicCache.keys().next().value);
    }
  };

  const pricingPolicy = async () => settings.get('pricing_policy');
  const supplierSettings = async () => settings.get('supplier');

  const sourceName = () => supplier.isMock ? 'mock' : supplier.isConfigured ? 'telekos' : 'unavailable';
  const leaseName = (key) => `catalog-read-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

  function describeCache(entry, { cacheHit = true, refreshRequested = false, refreshInProgress = false } = {}) {
    const now = Date.now();
    const ageMs = Math.max(0, now - entry.fetchedAtMs);
    return {
      source: sourceName(),
      fetchedAt: entry.fetchedAt,
      providerQuotedAt: entry.data?.quotedAt || null,
      ageSeconds: Math.floor(ageMs / 1000),
      fresh: ageMs <= entry.ttlMs && !entry.lastError,
      stale: ageMs > entry.ttlMs || Boolean(entry.lastError),
      cacheHit,
      refreshRequested,
      refreshInProgress,
      lastError: entry.lastError || null
    };
  }

  /**
   * Read-through cache with process single-flight and a DB-backed per-key
   * lease. On a failed refresh the last successful response is served as stale
   * with an explicit status; it is never relabeled as current.
   */
  async function dynamicRead(key, loader, { refresh = false, ttlMs = READ_CACHE_TTL_MS } = {}) {
    state.dynamicReads += 1;
    const cached = dynamicCache.get(key) || null;
    const ageMs = cached ? Math.max(0, Date.now() - cached.fetchedAtMs) : Infinity;

    if (!refresh && cached && ageMs <= cached.ttlMs) {
      return { data: cached.data, cache: describeCache(cached, { cacheHit: true }) };
    }

    const running = inFlight.get(key);
    if (running) {
      const entry = await running;
      return { data: entry.data, cache: describeCache(entry, { cacheHit: true, refreshRequested: refresh }) };
    }

    if (!supplier.isConfigured) {
      if (cached) return { data: cached.data, cache: describeCache(cached, { cacheHit: true, refreshRequested: refresh }) };
      throw unavailable('Data supplier belum dikonfigurasi. Katalog live tidak tersedia.');
    }

    const owner = `catalog-${process.pid}-${randomUUID().slice(0, 8)}`;
    let locked = false;
    if (db.jobs?.acquire) {
      try {
        locked = await db.jobs.acquire(leaseName(key), owner, READ_LEASE_SECONDS);
      } catch (err) {
        logger?.warn?.('catalog read lease unavailable', { code: err?.code || null });
      }
    } else {
      locked = true;
    }

    if (!locked) {
      if (cached) {
        return {
          data: cached.data,
          cache: describeCache(cached, { cacheHit: true, refreshRequested: refresh, refreshInProgress: true })
        };
      }
      throw new AppError('CATALOG_REFRESH_IN_PROGRESS', 'Katalog sedang diperbarui. Coba lagi sebentar.', 503, { retryAfter: 5 });
    }

    const promise = (async () => {
      try {
        const data = await loader();
        const fetchedAtMs = Date.now();
        const entry = {
          data,
          fetchedAtMs,
          fetchedAt: new Date(fetchedAtMs).toISOString(),
          ttlMs,
          lastError: null
        };
        remember(key, entry);
        state.lastDynamicSuccessAt = entry.fetchedAt;
        state.lastDynamicError = null;
        return entry;
      } catch (err) {
        state.dynamicFailures += 1;
        state.lastDynamicError = { code: err?.code || 'UPSTREAM_ERROR', at: new Date().toISOString() };
        logger?.warn?.('catalog upstream read failed', {
          key: key.slice(0, 120),
          code: err?.code || null,
          status: err?.httpStatus || null
        });
        if (cached) {
          const stale = { ...cached, lastError: err?.code || 'UPSTREAM_ERROR' };
          remember(key, stale);
          return stale;
        }
        throw unavailable();
      } finally {
        inFlight.delete(key);
        if (locked && db.jobs?.release) await db.jobs.release(leaseName(key), owner).catch(() => {});
      }
    })();
    inFlight.set(key, promise);

    const entry = await promise;
    return {
      data: entry.data,
      cache: describeCache(entry, { cacheHit: false, refreshRequested: refresh })
    };
  }

  async function readServers({ refresh = false } = {}) {
    const result = await dynamicRead('servers', () => supplier.getServers(), { refresh });
    return { servers: result.data, cache: result.cache };
  }

  async function readApps({ server, refresh = false }) {
    const serverId = String(server);
    const result = await dynamicRead(`apps:${serverId}`, () => supplier.getApps(serverId), { refresh });
    return { serverId, apps: result.data, cache: result.cache };
  }

  async function readCountries({ server, app, refresh = false }) {
    const serverId = String(server);
    const appId = String(app);
    const result = await dynamicRead(`countries:${serverId}:${appId}`, () => supplier.getCountries({ server: serverId, app: appId }), { refresh });
    return { serverId, appId, countries: result.data, cache: result.cache };
  }

  async function readPrices({ server, app, country, refresh = false }) {
    const serverId = String(server);
    const appId = String(app);
    const countryId = Number(country);
    const key = `prices:${serverId}:${appId}:${countryId}`;
    const result = await dynamicRead(
      key,
      async () => supplier.getPrices({ server: serverId, app: appId, country: countryId, refresh }),
      { refresh, ttlMs: PRICE_CACHE_TTL_MS }
    );
    return { serverId, appId, countryId, ...result };
  }

  function assertSelected(items, id, type) {
    const found = items.find((item) => String(item.id) === String(id));
    if (!found) throw new AppError('OFFER_STALE', `Pilihan ${type} tidak lagi tersedia. Muat ulang katalog.`, 409);
    return found;
  }

  /** Return every valid supplier offer, priced for display; never expose cost. */
  async function publicPrices({ server, app, country, refresh = false }) {
    const [serversResult, appsResult, countriesResult, pricesResult, policy] = await Promise.all([
      readServers(),
      readApps({ server }),
      readCountries({ server, app }),
      readPrices({ server, app, country, refresh }),
      pricingPolicy()
    ]);
    const serverRow = assertSelected(serversResult.servers, server, 'server');
    const appRow = assertSelected(appsResult.apps, app, 'app');
    const countryRow = assertSelected(countriesResult.countries, country, 'country');

    const offers = pricesResult.data.offers
      .map((offer) => {
        const priced = resolvePrice({ supplierPrice: offer.price, policy, category: appRow.id });
        return {
          id: offer.id,
          offerId: offer.offerId,
          salePrice: priced.totalPrice,
          currency: offer.currency,
          stock: offer.stock
        };
      })
      .filter((offer) => Number.isSafeInteger(offer.salePrice) && offer.salePrice > 0)
      .sort((a, b) => a.salePrice - b.salePrice || a.offerId.localeCompare(b.offerId));

    return {
      server: { id: serverRow.id, name: serverRow.name, available: serverRow.available, maintenance: serverRow.maintenance },
      app: { id: appRow.id, name: appRow.name },
      country: {
        id: countryRow.id,
        name: countryRow.name,
        iso: countryRow.iso,
        callingCode: countryRow.callingCode,
        stock: countryRow.stock
      },
      offers,
      quotedAt: pricesResult.data.quotedAt || null,
      cache: pricesResult.cache
    };
  }

  /**
   * Checkout quote for a live supplier offer. The offer id is only a selector;
   * all IDs are checked against current catalogue data and /prices?refresh=1
   * is called again before the wallet is debited.
   */
  async function quoteOffer({ server, app, country, offerId }) {
    const serverId = String(server || '');
    const appId = String(app || '');
    const countryId = Number(country);
    const wantedOfferId = String(offerId || '');
    if (!serverId || !appId || !Number.isSafeInteger(countryId) || countryId <= 0 || !wantedOfferId) {
      throw new AppError('INVALID_OFFER', 'Pilihan nomor tidak valid. Muat ulang katalog.', 422);
    }

    const [serversResult, appsResult, countriesResult, pricesResult, policy] = await Promise.all([
      readServers(),
      readApps({ server: serverId }),
      readCountries({ server: serverId, app: appId }),
      readPrices({ server: serverId, app: appId, country: countryId, refresh: true }),
      pricingPolicy()
    ]);
    const serverRow = assertSelected(serversResult.servers, serverId, 'server');
    const appRow = assertSelected(appsResult.apps, appId, 'app');
    const countryRow = assertSelected(countriesResult.countries, countryId, 'country');
    if (!serverRow.available || serverRow.maintenance || countryRow.stock <= 0) {
      throw new AppError('OUT_OF_STOCK', 'Server atau negara sedang tidak tersedia. Pilih penawaran lain.', 409);
    }

    const offer = pricesResult.data.offers.find((item) => item.offerId === wantedOfferId && item.stock > 0);
    if (!offer) throw new AppError('OFFER_STALE', 'Harga atau stok berubah. Muat ulang penawaran sebelum membeli.', 409);

    const priced = resolvePrice({ supplierPrice: offer.price, policy, category: appRow.id });
    return {
      offerId: offer.offerId,
      offerKey: offer.id,
      supplierPrice: priced.supplierPrice,
      markupBps: priced.markupBps,
      taxBps: policy.tax_bps,
      price: priced,
      stock: offer.stock,
      quotedAt: pricesResult.data.quotedAt || null,
      live: pricesResult.cache.source === 'telekos' && pricesResult.cache.fresh && !pricesResult.cache.stale && !pricesResult.cache.lastError && !pricesResult.cache.refreshInProgress,
      source: pricesResult.cache.source,
      cache: pricesResult.cache,
      server: serverRow.id,
      serverName: serverRow.name,
      appId: appRow.id,
      appName: appRow.name,
      countryId: countryRow.id,
      countryName: countryRow.name,
      countryIso: countryRow.iso,
      callingCode: countryRow.callingCode
    };
  }

  /** Public DB mirror retained for landing summaries and offline diagnostics. */
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
    for (const service of services) {
      const entry = byApp.get(service.appId) || {
        id: service.appId, name: service.appName, countries: [], minPrice: service.price, totalStock: 0
      };
      entry.countries.push(service);
      entry.minPrice = Math.min(entry.minPrice, service.price);
      entry.totalStock += service.stock;
      byApp.set(service.appId, entry);
    }
    for (const entry of byApp.values()) {
      entry.countries.sort((a, b) => Number(a.price) - Number(b.price));
      entry.countryCount = entry.countries.length;
    }

    const countries = [...new Map(services.map((service) => [
      `${service.countryId}:${service.countryIso || ''}`,
      { id: service.countryId, name: service.countryName, iso: service.countryIso, callingCode: service.callingCode }
    ])).values()].sort((a, b) => a.name.localeCompare(b.name));

    return {
      services,
      apps: [...byApp.values()].sort((a, b) => a.name.localeCompare(b.name)),
      countries,
      syncedAt: services.reduce((latest, service) =>
        service.syncedAt && (!latest || service.syncedAt > latest) ? service.syncedAt : latest, null),
      source: supplier.isMock ? 'mock' : supplier.isConfigured ? 'supplier' : 'unavailable'
    };
  }

  /** Existing service-id quote used by compatible clients; live by default. */
  async function quote({ serviceId, refresh = false }) {
    const policy = await pricingPolicy();
    const service = await db.services.get(serviceId);
    if (!service || !service.is_active) throw new AppError('SERVICE_NOT_AVAILABLE', 'Layanan tidak tersedia.', 404);

    if (!supplier.quotesEnabled || !supplier.isConfigured) {
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
        quotedAt: service.price_synced_at || null,
        live: false,
        source: sourceName(),
        cache: null,
        server: service.provider_server
      };
    }

    const prices = await readPrices({
      server: service.provider_server,
      app: service.provider_app_id,
      country: service.country_id,
      refresh
    });
    const available = prices.data.offers.filter((offer) => offer.stock > 0);
    if (!available.length) throw new AppError('OUT_OF_STOCK', 'Nomor untuk kombinasi ini sedang kosong.', 409);
    const cheapest = available[0];
    const priced = resolvePrice({
      supplierPrice: cheapest.price,
      policy,
      serviceMarkupBps: service.markup_bps,
      category: service.provider_app_id
    });
    return {
      offerId: cheapest.offerId,
      offerKey: cheapest.id,
      supplierPrice: priced.supplierPrice,
      markupBps: priced.markupBps,
      taxBps: policy.tax_bps,
      price: priced,
      stock: available.reduce((total, offer) => total + offer.stock, 0),
      quotedAt: prices.data.quotedAt || null,
      live: prices.cache.source === 'telekos' && prices.cache.fresh && !prices.cache.stale && !prices.cache.lastError && !prices.cache.refreshInProgress,
      source: prices.cache.source,
      cache: prices.cache,
      server: service.provider_server
    };
  }

  /**
   * Full catalogue synchronization. The job never truncates the supplier's
   * returned server/app/country arrays. It uses bounded concurrency and a hard
   * runtime budget; an incomplete server is not written, so a partial response
   * cannot deactivate valid cached services.
   */
  async function sync({
    trigger = 'scheduler',
    budgetMs = config?.jobs?.catalogSyncBudgetMs ?? 45_000,
    concurrency = config?.jobs?.catalogSyncConcurrency ?? 4
  } = {}) {
    if (state.running) return { skipped: true, reason: 'already_running' };
    if (!supplier.isConfigured) return { skipped: true, reason: 'supplier_not_configured' };

    state.running = true;
    const started = Date.now();
    const outOfBudget = () => Date.now() - started >= budgetMs;
    const policy = await pricingPolicy();
    let upserted = 0;
    let deactivated = 0;
    const errors = [];
    const incompleteServers = [];
    const provider = supplier.isMock ? 'telekos-mock' : 'telekos';

    await db.services.recordSyncRun({ provider, status: 'running', started_at: new Date().toISOString() });
    try {
      const servers = await supplier.getServers();
      for (const server of servers) {
        if (outOfBudget()) {
          incompleteServers.push(`${server.id}:budget`);
          continue;
        }
        if (!server.available || server.maintenance) {
          // The /servers response itself is successful evidence that this
          // server cannot serve offers, so stale rows for just that server can
          // be deactivated without guessing about another server.
          const result = await db.services.sync(provider, server.id, []);
          upserted += result.upserted;
          deactivated += result.deactivated;
          continue;
        }

        let serverFailed = false;
        let apps;
        try {
          apps = await supplier.getApps(server.id);
        } catch (err) {
          errors.push(`${server.id}/apps:${err.code || 'ERROR'}`);
          incompleteServers.push(server.id);
          continue;
        }

        const countryResults = await mapLimit(apps, concurrency, async (app) => {
          try {
            return { app, countries: await supplier.getCountries({ server: server.id, app: app.id }) };
          } catch (err) {
            serverFailed = true;
            errors.push(`${server.id}/${app.id}/countries:${err.code || 'ERROR'}`);
            return { app, countries: null };
          }
        });

        const tasks = [];
        for (const result of countryResults) {
          if (!result.countries) continue;
          for (const country of result.countries) tasks.push({ app: result.app, country });
        }
        let budgetExceeded = false;
        const pricedRows = await mapLimit(tasks, concurrency, async ({ app, country }) => {
          if (outOfBudget()) {
            budgetExceeded = true;
            return null;
          }
          try {
            const { offers } = await supplier.getPrices({ server: server.id, app: app.id, country: country.id });
            const stocked = offers.filter((offer) => offer.stock > 0);
            if (!stocked.length) return null;
            const cheapest = stocked[0];
            const composed = resolvePrice({ supplierPrice: cheapest.price, policy, category: app.id });
            return {
              code: SERVICE_CODE(server.id, app.id, country.id),
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
              stock: stocked.reduce((total, offer) => total + offer.stock, 0),
              is_active: true
            };
          } catch (err) {
            serverFailed = true;
            errors.push(`${server.id}/${app.id}/${country.id}/prices:${err.code || 'ERROR'}`);
            return null;
          }
        });

        if (budgetExceeded) {
          incompleteServers.push(`${server.id}:budget`);
          continue;
        }
        if (serverFailed) {
          incompleteServers.push(server.id);
          continue;
        }

        const result = await db.services.sync(provider, server.id, pricedRows.filter(Boolean));
        upserted += result.upserted;
        deactivated += result.deactivated;
      }

      const status = incompleteServers.length
        ? (upserted > 0 || deactivated > 0 ? 'partial' : 'failed')
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
        error: errors.length || incompleteServers.length
          ? [...errors.slice(0, 4), ...incompleteServers].join('; ').slice(0, 500)
          : null,
        finished_at: new Date().toISOString()
      });
      logger.info('catalog sync finished', state.lastResult);
      return state.lastResult;
    } catch (err) {
      state.lastResult = { status: 'failed', error: err?.code || 'SYNC_FAILED', durationMs: Date.now() - started, trigger };
      logger.error('catalog sync failed', { code: err?.code || null });
      await db.services.recordSyncRun({
        provider, status: 'failed', error: String(err?.code || 'SYNC_FAILED').slice(0, 300),
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
    quoteOffer,
    publicPrices,
    readServers,
    readApps,
    readCountries,
    readPrices,
    sync,
    get status() {
      return {
        ...state,
        supplier: supplier.status(),
        mode: config.supplier.mode,
        cacheEntries: dynamicCache.size,
        cacheTtlMs: { reads: READ_CACHE_TTL_MS, prices: PRICE_CACHE_TTL_MS }
      };
    }
  };
}
