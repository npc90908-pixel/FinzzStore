// Express 5 application boundary. The existing route handler is retained as a
// compatibility adapter during the incremental migration so API contracts,
// raw webhook bodies, cookies, CSRF, and security headers remain unchanged.
// New routes should be implemented as Express routers and migrated in slices.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function invokeExpressApp(expressApp, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.off('finish', onFinish);
      res.off('close', onFinish);
      res.off('error', onError);
    };
    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    res.once('finish', onFinish);
    res.once('close', onFinish);
    res.once('error', onError);
    try {
      expressApp(req, res);
      if (res.writableFinished) onFinish();
    } catch (error) {
      onError(error);
    }
  });
}

export function createExpressApp({ handler, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  // Do not add express.json() globally: AstraPay and TeleKos webhook signature
  // verification requires the exact raw request body.
  app.use((req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  });
  app.use((error, req, res, _next) => {
    logger?.error?.('Express boundary error', { requestId: req.requestId, error: error?.message });
    if (res.headersSent) return res.end();
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server.' } });
  });
  return app;
}
