// ============================================================================
// SETTINGS SERVICE — small TTL cache around app_settings so that rendering a
// page does not hit the database for every section. Writes invalidate the cache.
// ============================================================================

const DEFAULTS = {
  store_profile: {
    name: 'FINZZ Store',
    tagline: 'Nomor virtual instan untuk verifikasi akun',
    support_email: '',
    support_whatsapp: '',
    support_telegram: ''
  },
  deposit_policy: {
    min_amount: 10000,
    max_amount: 5000000,
    instructions: '',
    bank_accounts: [],
    expiry_hours: 24
  },
  pricing_policy: {
    default_markup_bps: 1500,
    fixed_markup: 0,
    min_margin: 0,
    tax_bps: 0,
    tax_label: 'PPN',
    rounding: { mode: 'none', step: 1 },
    category_bps: {}
  },
  operations: {
    sales_open: true,
    maintenance_message: '',
    order_poll_interval_ms: 4000,
    server_poll_interval_ms: 15000,
    order_expiry_seconds: 1260,
    max_active_orders_per_user: 5
  },
  refund_policy: { summary: '' },
  legal: { terms_version: '2026-10-01', privacy_version: '2026-10-01' },
  supplier: { provider: 'telekos', server: 'server1', app_allowlist: [], sync_enabled: true }
};

export function createSettingsService({ db, logger, ttlMs = 20_000 }) {
  const cache = new Map();
  const publicCache = { value: null, expiresAt: 0, available: true, error: null };

  const merge = (key, value) => ({ ...(DEFAULTS[key] || {}), ...(value && typeof value === 'object' ? value : {}) });

  return {
    async get(key) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      let value = null;
      try {
        value = await db.settings.get(key);
      } catch (err) {
        logger?.warn?.('settings read failed, using defaults', { key, error: err?.message });
      }
      const merged = merge(key, value);
      cache.set(key, { value: merged, expiresAt: Date.now() + ttlMs });
      return merged;
    },

    async getAll() {
      const keys = Object.keys(DEFAULTS);
      const values = await Promise.all(keys.map((k) => this.get(k)));
      return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
    },

    /**
     * Public settings plus their provenance.
     *
     * Production 2026-10-26: this read failed and the service silently served
     * DEFAULT values as if they were the store's real configuration (deposit
     * limits, maintenance state, legal versions). Callers now receive
     * `available: false` so the UI can say "konfigurasi belum tersedia" instead
     * of presenting invented limits as facts.
     *
     * @returns {{values: object, available: boolean, error: object|null}}
     */
    async getPublicWithStatus() {
      if (publicCache.value && publicCache.expiresAt > Date.now()) {
        return { values: publicCache.value, available: publicCache.available, error: publicCache.error };
      }
      let stored = {};
      let available = true;
      let error = null;
      try {
        stored = await db.settings.getPublic();
      } catch (err) {
        available = false;
        error = {
          code: err?.code || 'DB_ERROR',
          pgCode: err?.pgCode || null,
          message: err?.message || null
        };
        logger?.warn?.('public settings read failed, serving defaults flagged unavailable', {
          code: err?.code || null,
          pgCode: err?.pgCode || null,
          pgMessage: err?.pgMessage || null,
          table: err?.table || 'app_settings'
        });
      }
      const out = {};
      for (const key of Object.keys(DEFAULTS)) out[key] = merge(key, stored[key]);
      publicCache.value = out;
      publicCache.available = available;
      publicCache.error = error;
      publicCache.expiresAt = Date.now() + ttlMs;
      return { values: out, available, error };
    },

    /** Backwards compatible: values only. */
    async getPublic() {
      const { values } = await this.getPublicWithStatus();
      return values;
    },

    async update(key, value, adminId) {
      if (!(key in DEFAULTS)) throw new Error(`unknown settings key: ${key}`);
      const merged = merge(key, value);
      const saved = await db.settings.update(key, merged, adminId);
      cache.delete(key);
      publicCache.expiresAt = 0;
      return saved;
    },

    invalidate(key) {
      if (key) cache.delete(key);
      else cache.clear();
      publicCache.expiresAt = 0;
    }
  };
}
