#!/usr/bin/env node
// ============================================================================
// FINZZ STORE V2 — entry point.
// Node.js 24, ES Modules, node:http only. See README.md for deployment.
// ============================================================================
import { createServer } from 'node:http';
import { ConfigError } from './src/config.js';
import { createLogger } from './src/logging.js';
import { createApplication } from './src/bootstrap.js';

const ON_VERCEL = Boolean(process.env.VERCEL);

// Vercel's filesystem is read-only except /tmp, and there is no long-lived
// process: background jobs run through Vercel Cron (see /api/cron/*).
if (ON_VERCEL) {
  process.env.UPLOAD_DIR ||= '/tmp/finzz-storage';
  process.env.JOBS_ENABLED ||= 'false';
  if (!process.env.APP_URL && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    process.env.APP_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
}

let appPromise = null;
function getApp() {
  appPromise ||= createApplication({
    env: process.env,
    logger: createLogger({ level: process.env.LOG_LEVEL || 'info' })
  }).catch((err) => {
    appPromise = null; // allow retry on the next invocation
    throw err;
  });
  return appPromise;
}

/** Vercel entry: one request = one call. Must be the default export. */
export default async function vercelHandler(req, res) {
  try {
    const { handler } = await getApp();
    await handler(req, res);
  } catch (err) {
    createLogger().error('request failed', { error: err?.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: err?.message || 'Terjadi kesalahan pada server.' } }));
    }
  }
}

async function main() {
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

  let app;
  try {
    app = await createApplication({ env: process.env, logger });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('invalid configuration', { error: err.message });
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    throw err;
  }

  const { config, db, services, jobs, handler } = app;
  const bootLogger = logger.child({ env: config.nodeEnv, version: config.version });

  bootLogger.info('starting FINZZ Store', {
    demoMode: config.demoMode,
    supplierMode: config.supplier.mode,
    auth: services.auth.kind,
    database: db.kind
  });
  if (db.kind === 'memory') {
    // The in-memory driver only ever runs the local demo. Saying so plainly is
    // the point: nothing here should look like a real deployment.
    bootLogger.warn(
      'in-memory database active (local demo only). Set DATABASE_URL to use PostgreSQL.'
    );
  }

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      bootLogger.error('fatal request handler error', { err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server.' } }));
      }
    });
  });

  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 500;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  bootLogger.info('http server listening', { port: config.port, host: config.host, appUrl: config.appUrl });

  jobs.poller.start();
  jobs.reconciliation.start();

  // ----------------------------------------------------------------- shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info('shutting down', { signal });
    const forceTimer = setTimeout(() => {
      bootLogger.error('forced shutdown after timeout');
      process.exit(1);
    }, 15000);
    forceTimer.unref();
    try {
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await jobs.poller.stop();
      await jobs.reconciliation.stop();
      await db.close();
    } catch (err) {
      bootLogger.error('error during shutdown', { error: err.message });
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    bootLogger.error('unhandled promise rejection', { reason });
  });
  process.on('uncaughtException', (err) => {
    bootLogger.error('uncaught exception', { err });
    shutdown('uncaughtException');
  });
}

if (!ON_VERCEL) {
  main().catch((err) => {
    createLogger().error('fatal boot error', { err });
    process.exitCode = 1;
  });
}
