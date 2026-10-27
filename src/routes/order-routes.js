// ============================================================================
// ORDER ROUTES
//
// GET endpoints are cheap (database only) so the browser can poll every 4s
// while the tab is visible. Supplier calls happen in the background poller;
// POST /api/orders/:id/sync is an optional accelerator guarded by a 3s window.
// ============================================================================
import * as v from '../validation.js';
import { errors } from '../errors.js';
import { parsePage, enforceLimit, ok, accepted, created } from './helpers.js';

const lastSync = new Map(); // `${userId}:${orderId}` -> timestamp

export function registerOrderRoutes({ router }) {
  router.post('/api/orders', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `order:create:${session.user.id}`, 15, 10 * 60, { critical: true });

    const body = await ctx.readJson({ limit: 8 * 1024 });
    const serviceId = body.service_id ? v.uuid(body.service_id, { field: 'service_id' }) : null;
    const idempotencyKey = v.idempotencyKey(body.idempotency_key);
    let offer = null;
    if (body.offer_id !== undefined) {
      offer = {
        server: v.string(body.server_id, { field: 'server_id', min: 1, max: 80, pattern: /^[A-Za-z0-9._:-]+$/ }),
        app: v.string(body.app_id, { field: 'app_id', min: 1, max: 80, pattern: /^[A-Za-z0-9._:-]+$/ }),
        country: v.integer(body.country_id, { field: 'country_id', min: 1, max: 2_147_483_647 }),
        offerId: v.string(body.offer_id, { field: 'offer_id', min: 1, max: 200, pattern: /^[A-Za-z0-9._:-]+$/ })
      };
    }
    if (!serviceId && !offer) throw errors.badRequest('service_id atau data penawaran wajib diisi.', 'MISSING_FIELD');
    if (serviceId && offer) throw errors.badRequest('Kirim hanya satu jenis konteks penawaran.', 'INVALID_INPUT');
    const expectedPrice = body.expected_price === undefined
      ? null
      : v.money(body.expected_price, { field: 'expected_price', min: 1 });

    const result = await ctx.services.orders.create({
      user: session.profile,
      serviceId,
      offer,
      expectedPrice,
      idempotencyKey,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    });

    const status = result.pending ? 202 : 201;
    return { status, body: result };
  });

  router.get('/api/orders', async (ctx) => {
    const session = await ctx.requireUser();
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 12 });
    const status = ctx.query.get('status');
    const allowed = ['pending', 'waiting', 'received', 'completed', 'cancelled', 'expired', 'failed', 'needs_review'];
    if (status && !allowed.includes(status)) throw errors.badRequest('Status filter tidak valid.', 'INVALID_FILTER');

    const result = await ctx.services.orders.list({
      user: session.profile,
      status: status || null,
      page,
      perPage
    });
    return ok(result);
  });

  router.get('/api/orders/active', async (ctx) => {
    const session = await ctx.requireUser();
    const orders = await ctx.services.orders.active({ user: session.profile });
    return ok({ orders });
  });

  router.get('/api/orders/:id', async (ctx) => {
    const session = await ctx.requireUser();
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    const order = await ctx.services.orders.get({ user: session.profile, orderId });
    return ok({ order });
  });

  router.post('/api/orders/:id/sync', async (ctx) => {
    const session = await ctx.requireUser();
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    const bucket = `${session.user.id}:${orderId}`;
    const last = lastSync.get(bucket) || 0;
    if (Date.now() - last < 3000) {
      return accepted({
        throttled: true,
        message: 'Sinkronisasi otomatis berjalan setiap beberapa detik.',
        order: await ctx.services.orders.get({ user: session.profile, orderId })
      });
    }
    lastSync.set(bucket, Date.now());
    await enforceLimit(ctx, `order:sync:${session.user.id}`, 60, 60);

    const order = await ctx.db.orders.getForUser(orderId, session.user.id);
    if (!order) throw errors.notFound('Order');
    if (['completed', 'cancelled', 'expired', 'failed'].includes(order.status)) {
      return ok({ order: ctx.services.orders.toPublic(order, { includeOtp: true }), terminal: true });
    }

    await ctx.services.orders.syncOrder(order, { worker: `user-${session.user.id.slice(0, 8)}` });
    const fresh = await ctx.db.orders.getForUser(orderId, session.user.id);
    return ok({ order: ctx.services.orders.toPublic(fresh, { includeOtp: true }) });
  });

  router.post('/api/orders/:id/cancel', async (ctx) => {
    const session = await ctx.requireUser();
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    await enforceLimit(ctx, `order:cancel:${session.user.id}`, 10, 10 * 60, { critical: true });
    const result = await ctx.services.orders.cancel({ user: session.profile, orderId });
    return result.pending ? accepted(result) : ok(result);
  });

  router.get('/api/orders/:id/events', async (ctx) => {
    const session = await ctx.requireUser();
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    const order = await ctx.db.orders.getForUser(orderId, session.user.id);
    if (!order) throw errors.notFound('Order');
    const { rows } = (await ctx.db.orders.eventsFor?.(orderId)) ?? { rows: [] };
    return ok({
      events: rows.map((e) => ({
        type: e.event_type,
        from: e.from_status,
        to: e.to_status,
        source: e.source,
        message: e.message,
        at: e.created_at
      }))
    });
  });
}
