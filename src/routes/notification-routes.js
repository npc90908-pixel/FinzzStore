// ============================================================================
// NOTIFICATION ROUTES
//
// The inbox is part of the authenticated dashboard, so every route here calls
// requireUser() first. There is no endpoint that accepts a user id from the
// request: the scope always comes from the session cookie.
// ============================================================================
import { enforceLimit, ok, parsePage } from './helpers.js';

export function registerNotificationRoutes({ router }) {
  router.get('/api/notifications', async (ctx) => {
    const session = await ctx.requireUser();
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 20, maxPerPage: 50 });
    const unreadOnly = ['1', 'true', 'yes'].includes(String(ctx.query.get('unread') || '').toLowerCase());
    const result = await ctx.services.notifications.list({
      user: session.profile,
      page,
      perPage,
      unreadOnly
    });
    return ok(result);
  });

  router.post('/api/notifications/read', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `notif:read:${session.user.id}`, 120, 60);
    const body = await ctx.readJson();
    // `ids` absent means "everything"; a present-but-wrong type is a client
    // error, not an excuse to silently mark the whole inbox read.
    const ids = body && Object.prototype.hasOwnProperty.call(body, 'ids') ? body.ids : null;
    const result = await ctx.services.notifications.markRead({ user: session.profile, ids });
    return ok({ ...result, message: result.updated > 0 ? 'Notifikasi ditandai sudah dibaca.' : 'Tidak ada notifikasi baru.' });
  });

  router.post('/api/notifications/read-all', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `notif:read:${session.user.id}`, 120, 60);
    const result = await ctx.services.notifications.markRead({ user: session.profile, ids: null });
    return ok({ ...result, message: result.updated > 0 ? `${result.updated} notifikasi ditandai sudah dibaca.` : 'Tidak ada notifikasi baru.' });
  });
}
