// ============================================================================
// BOOTSTRAP — assembles configuration, database, services, router and the
// request handler. Shared by server.js (real process) and the test harness so
// production wiring and test wiring can never drift apart.
// ============================================================================
import { loadConfig } from './config.js';
import { createPgDatabase } from './database-pg.js';
import { createMemoryDatabase } from './database-memory.js';
import { createAuthService } from './auth-local.js';
import { createGoogleOAuth } from './auth-google.js';
import { createMailer } from './auth/mailer.js';
import { createTurnstileVerifier, hashPassword } from './auth/security.js';
import { createSettingsService } from './settings.js';
import { createSupplierClient } from './supplier.js';
import { createMockSupplier } from './supplier-mock.js';
import { createCatalogService } from './catalog.js';
import { createOrderService } from './orders.js';
import { createWalletService } from './wallet.js';
import { createDepositService } from './deposits.js';
import { createNotificationService } from './notifications.js';
import { createPaymentAdapter } from './payment/adapter.js';
import { createOrderPoller } from './jobs/order-poller.js';
import { createReconciliationJob } from './jobs/reconciliation.js';
import { createRouter } from './router.js';
import { registerRoutes } from './routes/index.js';
import { createApp } from './app.js';
import { createRateLimiter } from './security.js';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function isSupabaseSessionPooler(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.hostname.toLowerCase().endsWith('.pooler.supabase.com') && url.port === '5432';
  } catch {
    return false;
  }
}

export async function createApplication({ env = process.env, logger, supplierOptions = null, paymentOptions = null } = {}) {
  if (!logger) throw new Error('createApplication requires a logger');
  const config = loadConfig(env);
  if (config.isVercel && isSupabaseSessionPooler(config.database.connectionString)) {
    logger.warn(
      'Supabase session-mode pooler detected on Vercel; use the transaction-mode DATABASE_URL (port 6543) to avoid the session client limit.'
    );
  }

  // Custom authentication is the only auth path now: Supabase Auth is not used
  // anywhere. A real deployment must supply DATABASE_URL; the in-memory driver
  // exists only for the local demo and the test suite.
  let db;
  if (config.database.connectionString && !config.demoMode) {
    db = createPgDatabase(config, { logger });
  } else {
    db = createMemoryDatabase({ logger });
  }

  // A Vercel cold start is not a readiness probe. Pinging here adds a database
  // round-trip to every cold start and makes a transient pooler limit prevent
  // the whole app from initializing (including routes that can degrade
  // gracefully). Health routes still perform their own explicit checks.
  if (!config.isVercel) {
    try {
      await db.ping();
    } catch (err) {
      logger.error('database health check failed at boot', { error: err.message });
      if (config.isProduction) {
        // createApplication may be retried after a failed startup; close the
        // pool before propagating so failed starts cannot leak clients.
        await db.close().catch((closeError) => {
          logger.warn('database pool cleanup after failed boot failed', { error: closeError.message });
        });
        throw err;
      }
    }
  }

  await mkdir(config.storageDir, { recursive: true, mode: 0o700 });

  const settings = createSettingsService({ db, logger });
  const mailer = createMailer(config, { logger });
  const turnstile = createTurnstileVerifier(config, { logger });
  const auth = createAuthService({ db, config, logger, mailer, turnstile });
  const googleOAuth = createGoogleOAuth(config, { logger });

  const supplier = config.supplier.mode === 'mock'
    ? createMockSupplier({ logger, ...(supplierOptions || {}) })
    : createSupplierClient(config, { logger });

  const catalog = createCatalogService({ db, supplier, settings, logger, config });
  const orders = createOrderService({ db, supplier, settings, catalog, logger, config });
  const payment = createPaymentAdapter(config, { logger, ...(paymentOptions || {}) });
  const wallet = createWalletService({ db, settings, orders, payment });
  const deposits = createDepositService({ db, settings, config, payment, logger });
  const jobsState = {};
  const rateLimiter = createRateLimiter({ db, logger });
  const notifications = createNotificationService({ db, logger });

  const services = {
    settings, auth, googleOAuth, mailer, supplier, catalog, orders, wallet, deposits, payment, notifications,
    jobsState, rateLimiter, db, config
  };

  const router = createRouter();
  registerRoutes({ router, services, config, logger });

  // ------------------------------------------------------------------------
  // DEMO SEED — creates the two preview accounts (admin + funded user) so a
  // reviewer can explore orders, OTPs and the admin dashboard immediately.
  // Only runs for the in-memory demo; the credentials are published through the
  // public config and shown on the login page.
  // ------------------------------------------------------------------------
  if (config.demo.seed && typeof db.profiles?.seedDemo === 'function') {
    await seedDemoAccounts({ db, config, logger });
  }

  const jobs = {
    poller: createOrderPoller({ db, orders, logger, config }),
    reconciliation: createReconciliationJob({ db, orders, catalog, auth, deposits, logger, config, state: jobsState })
  };
  services.jobs = jobs;

  const handler = createApp({ config, logger, db, auth, services, router });

  return { config, db, services, jobs, router, handler, logger };
}

function deterministicUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

async function seedDemoAccounts({ db, config, logger }) {
  let adminId = null;
  for (const account of config.demo.accounts) {
    const existing = await db.profiles.byEmail(account.email).catch(() => null);
    if (existing) {
      if (account.role === 'admin') adminId = existing.id;
      continue;
    }
    // Custom auth: hash the published demo password with Argon2id, then
    // register through the same path a real user takes.
    const passwordHash = await hashPassword(account.password);
    const { profile } = await db.profiles.seedDemo({
      email: account.email,
      passwordHash,
      role: account.role,
      verified: true
    });
    if (account.role === 'admin') adminId = profile.id;
    if (account.balance > 0 && adminId) {
      await db.wallets
        .adjust(profile.id, adminId, {
          direction: 'credit',
          amount: account.balance,
          reason: 'Saldo awal akun demo',
          reference: deterministicUuid(`demo-seed:${account.email}`)
        })
        .catch((err) => logger.warn('demo balance seed skipped', { error: err.message }));
    }
  }
  logger.warn('DEMO ACCOUNTS READY — credentials are public and must never exist in production', {
    accounts: config.demo.accounts.map((a) => `${a.label}: ${a.email}`)
  });
}
