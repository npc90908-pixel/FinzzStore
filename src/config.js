// ============================================================================
// CONFIGURATION — pure function, validated at boot. Secrets are read from the
// environment only and are never logged, serialised to the client, or stored in
// the repository.
// ============================================================================
import { randomBytes } from 'node:crypto';

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Build the runtime configuration.
 * @param {Record<string,string|undefined>} env
 * @param {{allowInsecureDemo?: boolean}} [options]
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const demoRequested = bool(env.DEMO_MODE, false);

  // The application owns its PostgreSQL connection now; Supabase Auth is gone,
  // so the presence of DATABASE_URL — not a set of Supabase keys — decides
  // whether this is a real deployment or the local demo.
  const databaseUrl = (env.DATABASE_URL || '').trim();
  const hasDatabase = Boolean(databaseUrl);

  if (isProduction && demoRequested) {
    throw new ConfigError('DEMO_MODE must never be enabled in production. Configure DATABASE_URL instead.');
  }
  if (isProduction && !hasDatabase) {
    throw new ConfigError('DATABASE_URL is required in production (PostgreSQL connection string).');
  }
  if (isProduction && !(env.CRON_SECRET || '').trim()) {
    throw new ConfigError('CRON_SECRET is required in production (16+ random characters).');
  }
  if (isProduction && (env.CRON_SECRET || '').trim().length < 16) {
    throw new ConfigError('CRON_SECRET must be at least 16 characters long.');
  }
  if (isProduction && env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'false') {
    throw new ConfigError('AUTH_REQUIRE_EMAIL_VERIFICATION must not be disabled in production.');
  }

  // Demo mode is explicit now. Forgetting DATABASE_URL no longer silently
  // downgrades a deployment to an in-memory database.
  const demoMode = demoRequested;
  const encryptionKeyRaw = (env.APP_ENCRYPTION_KEY || '').trim();
  let encryptionKey;
  if (encryptionKeyRaw) {
    const buf = /^[A-Za-z0-9+/=_-]{43,}$/.test(encryptionKeyRaw)
      ? Buffer.from(encryptionKeyRaw, 'base64')
      : Buffer.from(encryptionKeyRaw, 'utf8');
    if (buf.length < 32) {
      throw new ConfigError('APP_ENCRYPTION_KEY must decode to at least 32 bytes (base64 or raw).');
    }
    encryptionKey = buf.subarray(0, 32);
  } else if (isProduction) {
    throw new ConfigError('APP_ENCRYPTION_KEY is required in production (32 random bytes, base64 encoded).');
  } else {
    // Ephemeral key for local development only: sessions do not survive restarts.
    encryptionKey = randomBytes(32);
  }

  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
  if (isProduction && !appUrl.startsWith('https://')) {
    throw new ConfigError('APP_URL must be an https:// URL in production (Cloudflare Tunnel).');
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(appUrl)) allowedOrigins.push(appUrl);

  // Dev-only affordances must never reach production.
  if (isProduction && bool(env.AUTH_EXPOSE_DEV_TOKENS, false)) {
    throw new ConfigError('AUTH_EXPOSE_DEV_TOKENS must never be enabled in production.');
  }

  // Optional integrations are presence-based: a feature switches itself on as
  // soon as its credentials exist, so there is no separate ENABLED flag to
  // keep in sync. A *partial* configuration is rejected outright — half a
  // credential set can only produce a broken widget or a dead login button.
  const turnstileKeyPair = [env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY].filter((v) => String(v || '').trim());
  if (turnstileKeyPair.length === 1) {
    throw new ConfigError('Turnstile needs BOTH TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither.');
  }
  const turnstileRequested = bool(env.TURNSTILE_ENABLED, turnstileKeyPair.length === 2);
  if (turnstileRequested && turnstileKeyPair.length !== 2) {
    throw new ConfigError('TURNSTILE_ENABLED=true requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.');
  }
  const googleCredentialCount = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
    .filter((v) => String(v || '').trim()).length;
  if (googleCredentialCount === 1) {
    throw new ConfigError('Google OAuth needs BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.');
  }
  const googleOAuthRequested = bool(env.GOOGLE_OAUTH_ENABLED, googleCredentialCount === 2);
  if (googleOAuthRequested && googleCredentialCount !== 2) {
    throw new ConfigError('GOOGLE_OAUTH_ENABLED=true requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  // The standard callback is derived from APP_URL; the optional override is
  // retained for unusual deployments but must still point at this callback.
  const googleRedirectUri = String(env.GOOGLE_REDIRECT_URI || `${appUrl}/api/auth/google/callback`).trim();
  if (googleCredentialCount === 2) {
    let redirect;
    try {
      redirect = new URL(googleRedirectUri);
    } catch {
      throw new ConfigError('GOOGLE_REDIRECT_URI must be an absolute URL on this application.');
    }
    let appOrigin;
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      throw new ConfigError('APP_URL must be a valid absolute URL before Google OAuth can be enabled.');
    }
    if (redirect.origin !== appOrigin || redirect.pathname !== '/api/auth/google/callback' || redirect.search || redirect.hash) {
      throw new ConfigError(`GOOGLE_REDIRECT_URI must be ${appUrl}/api/auth/google/callback.`);
    }
  }

  const supplierMode = (env.SUPPLIER_MODE || (env.TELEKOS_API_KEY ? 'live' : 'off')).toLowerCase();
  if (!['live', 'mock', 'off'].includes(supplierMode)) {
    throw new ConfigError('SUPPLIER_MODE must be one of: live, mock, off');
  }
  if (supplierMode === 'mock' && isProduction) {
    throw new ConfigError('SUPPLIER_MODE=mock is a test fixture and must never run in production.');
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    demoMode,
    demo: Object.freeze({
      // Seeding is skipped for the automated tests (JOBS/test harness) and can be
      // disabled with DEMO_SEED=false. Credentials are only ever published when
      // the process really is a non-production demo.
      seed: bool(env.DEMO_SEED, demoMode) && demoMode && !isProduction && nodeEnv !== 'test',
      accounts: Object.freeze(
        demoMode && !isProduction
          ? [
              {
                email: String(env.DEMO_ADMIN_EMAIL || 'admin@finzz.store').toLowerCase(),
                password: env.DEMO_ADMIN_PASSWORD || 'FinzzDemo#2026',
                role: 'admin',
                balance: 0,
                label: 'Admin demo'
              },
              {
                email: String(env.DEMO_USER_EMAIL || 'demo@finzz.store').toLowerCase(),
                password: env.DEMO_USER_PASSWORD || 'FinzzDemo#2026',
                role: 'user',
                balance: 250000,
                label: 'Pengguna demo'
              }
            ]
          : []
      )
    }),
    port: int(env.PORT, 3000, { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    appUrl,
    allowedOrigins: Object.freeze(allowedOrigins),
    trustProxy: bool(env.TRUST_PROXY, true),

    // ---------------------------------------------------- PostgreSQL (direct)
    // The application talks to PostgreSQL itself; Supabase is reduced to a
    // managed Postgres host. DATABASE_URL is backend-only and never rendered.
    database: Object.freeze({
      connectionString: databaseUrl,
      // 'no-verify' must be chosen explicitly; the default keeps TLS strict.
      ssl: (() => {
        const mode = String(env.DATABASE_SSL || (isProduction ? 'require' : '')).toLowerCase();
        if (mode === 'disable' || mode === 'false' || mode === '') return false;
        if (mode === 'no-verify') return { rejectUnauthorized: false };
        return { rejectUnauthorized: true };
      })(),
      poolMax: int(env.DATABASE_POOL_MAX, 10, { min: 1, max: 50 }),
      connectionTimeoutMs: int(env.DATABASE_CONNECTION_TIMEOUT, 8000, { min: 1000, max: 60000 }),
      idleTimeoutMs: int(env.DATABASE_IDLE_TIMEOUT, 30000, { min: 5000, max: 300000 }),
      statementTimeoutMs: int(env.DATABASE_STATEMENT_TIMEOUT, 15000, { min: 1000, max: 60000 })
    }),

    // ------------------------------------------------------- custom auth
    auth: Object.freeze({
      // Verification context: how long the "which account am I verifying"
      // cookie lives, plus the resend throttle it enforces.
      verifyContextTtlSeconds: int(env.AUTH_VERIFY_CONTEXT_TTL_SECONDS, 1800, { min: 300, max: 7200 }),
      resendCooldownSeconds: int(env.AUTH_RESEND_COOLDOWN_SECONDS, 60, { min: 15, max: 600 }),
      resendMaxPerHour: int(env.AUTH_RESEND_MAX_PER_HOUR, 5, { min: 1, max: 20 }),
      // Verification defaults to ON in production, OFF for local demo so the
      // test suite does not need an SMTP server.
      requireEmailVerification: bool(env.AUTH_REQUIRE_EMAIL_VERIFICATION, isProduction),
      otpTtlSeconds: int(env.AUTH_OTP_TTL_SECONDS, 600, { min: 300, max: 900 }),
      resetTtlSeconds: int(env.AUTH_RESET_TTL_SECONDS, 600, { min: 300, max: 900 }),
      maxAttempts: int(env.AUTH_TOKEN_MAX_ATTEMPTS, 5, { min: 1, max: 10 }),
      maxFailedLogins: int(env.AUTH_MAX_FAILED_LOGINS, 10, { min: 3, max: 50 }),
      lockSeconds: int(env.AUTH_LOCK_SECONDS, 900, { min: 60, max: 86400 }),
      // Dev-only: surfaces the OTP / reset link in the API response. Refused in
      // production by the guard below.
      exposeDevTokens: bool(env.AUTH_EXPOSE_DEV_TOKENS, false)
    }),

    // ------------------------------------------------------------- SMTP
    smtp: Object.freeze({
      host: (env.SMTP_HOST || '').trim(),
      port: int(env.SMTP_PORT, 587, { min: 1, max: 65535 }),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: (env.SMTP_FROM || '').trim(),
      timeoutMs: int(env.SMTP_TIMEOUT_MS, 10000, { min: 2000, max: 60000 })
    }),

    // ------------------------------------------------- Cloudflare Turnstile
    // Presence-based: both keys turn the widget on automatically. Setting
    // TURNSTILE_ENABLED=false explicitly still works as an emergency kill
    // switch without having to remove the keys.
    turnstile: Object.freeze({
      enabled: bool(env.TURNSTILE_ENABLED, turnstileKeyPair.length === 2) && turnstileKeyPair.length === 2,
      siteKey: (env.TURNSTILE_SITE_KEY || '').trim(),
      secretKey: (env.TURNSTILE_SECRET_KEY || '').trim(),
      expectedHostname: (env.TURNSTILE_HOSTNAME || '').trim() || null,
      timeoutMs: int(env.TURNSTILE_TIMEOUT_MS, 5000, { min: 1000, max: 15000 })
    }),

    // ------------------------------------------------------ Google OAuth
    // Optional. The login button renders only when `available` is true, which
    // simply means every credential is present — no separate enable flag.
    oauth: Object.freeze({
      enabled: bool(env.GOOGLE_OAUTH_ENABLED, googleCredentialCount === 2) && googleCredentialCount === 2,
      clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
      redirectUri: googleRedirectUri,
      available: bool(env.GOOGLE_OAUTH_ENABLED, googleCredentialCount === 2) && googleCredentialCount === 2
    }),

    storeName: (env.STORE_NAME || 'FINZZ Store').trim(),

    encryptionKey,
    cookie: Object.freeze({
      name: env.SESSION_COOKIE_NAME || 'fz_session',
      csrfName: env.CSRF_COOKIE_NAME || 'fz_csrf',
      // Short-lived proof-of-registration cookie (see migration 007). It is
      // HttpOnly and never readable by JavaScript.
      verifyName: env.VERIFY_COOKIE_NAME || 'fz_verify',
      secure: isProduction || appUrl.startsWith('https://'),
      sameSite: 'Lax',
      maxAgeSeconds: int(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 7, { min: 900, max: 60 * 60 * 24 * 30 })
    }),

    supplier: Object.freeze({
      mode: supplierMode,
      baseUrl: (env.TELEKOS_BASE_URL || 'https://telekos.id/v1').replace(/\/+$/, ''),
      apiKey: env.TELEKOS_API_KEY || '',
      webhookSecret: env.TELEKOS_WEBHOOK_SECRET || '',
      timeoutMs: int(env.TELEKOS_TIMEOUT_MS, 12000, { min: 2000, max: 60000 }),
      enabled: supplierMode === 'live' && Boolean(env.TELEKOS_API_KEY),
      quotesEnabled: supplierMode !== 'off'
    }),

    // Scheduled jobs are triggered by an external scheduler (cron-job.org or
    // Vercel Cron) because the app itself never keeps a background timer in
    // production. The secret is mandatory whenever those endpoints are exposed.
    cron: Object.freeze({
      secret: (env.CRON_SECRET || '').trim(),
      lockTtlSeconds: int(env.CRON_LOCK_TTL_SECONDS, 120, { min: 15, max: 3600 }),
      requireSecret: isProduction
    }),

    payment: Object.freeze({
      provider: (env.PAYMENT_PROVIDER || '').trim() || null,
      mode: (env.PAYMENT_MODE || 'disabled').toLowerCase(),
      secret: env.PAYMENT_SECRET || ''
    }),

    jobs: Object.freeze({
      // Jobs run in every mode, including the local demo: the in-memory driver
      // implements the same lease/claim semantics, so disabling them locally
      // would hide polling and reconciliation bugs until production.
      orderPoller: bool(env.ORDER_POLLER_ENABLED, true),
      reconciliation: bool(env.RECONCILIATION_ENABLED, true),
      catalogBootDelayMs: int(env.CATALOG_BOOT_DELAY_MS, 2000, { min: 0, max: 600000 }),
      pollIntervalMs: int(env.ORDER_POLL_INTERVAL_MS, 15000, { min: 5000, max: 120000 }),
      reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 60000, { min: 15000, max: 600000 }),
      pollBatchSize: int(env.ORDER_POLL_BATCH, 20, { min: 1, max: 100 }),
      leaseSeconds: int(env.ORDER_POLL_LEASE_SECONDS, 45, { min: 15, max: 300 }),
      enabled: bool(env.JOBS_ENABLED, true),
      // Catalogue sync budget. A serverless function is killed at maxDuration,
      // so the sync must stop *itself* first and keep the previous rows instead
      // of dying mid-write. Concurrency is bounded to stay polite to the
      // supplier's rate limits.
      catalogSyncBudgetMs: int(env.CATALOG_SYNC_BUDGET_MS, 45000, { min: 5000, max: 600000 }),
      catalogSyncConcurrency: int(env.CATALOG_SYNC_CONCURRENCY, 6, { min: 1, max: 20 })
    }),

    limits: Object.freeze({
      maxBodyBytes: int(env.MAX_BODY_BYTES, 1024 * 64, { min: 4096, max: 1024 * 1024 }),
      maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024, { min: 65536, max: 10 * 1024 * 1024 }),
      jsonBodyBytes: int(env.MAX_JSON_BYTES, 1024 * 512, { min: 4096, max: 2 * 1024 * 1024 })
    }),

    storageDir: env.UPLOAD_DIR || './storage',
    logLevel: (env.LOG_LEVEL || (isProduction ? 'info' : 'debug')).toLowerCase(),
    version: env.APP_VERSION || '2.0.0'
  });
}

/** Redacted view of the configuration, safe to expose through /api/public/health. */
export function publicConfigView(config) {
  return {
    version: config.version,
    environment: config.nodeEnv,
    demoMode: config.demoMode,
    // Demo credentials are public by design (non-production only) so the preview
    // can be explored without registering; the login page shows them.
    demoAccounts: config.demoMode && !config.isProduction
      ? config.demo.accounts.map((a) => ({ email: a.email, password: a.password, role: a.role, label: a.label }))
      : [],
    appUrl: config.appUrl,
    supplier: {
      mode: config.supplier.mode,
      configured: config.supplier.enabled,
      webhookConfigured: Boolean(config.supplier.webhookSecret)
    },
    payment: {
      provider: config.payment.provider,
      mode: config.payment.mode,
      enabled: false
    },
    // Cloudflare Turnstile site key is public by design (it is embedded in the
    // page); the secret never leaves the server.
    turnstile: {
      enabled: config.turnstile.enabled,
      siteKey: config.turnstile.enabled ? config.turnstile.siteKey : ''
    },
    oauth: { google: config.oauth.available },
    // Supabase is no longer used for anything; kept false so any stale client
    // that still checks the flag degrades to "not configured" instead of
    // trying a provider call that would 404.
    supabase: { configured: false }
  };
}
