// ============================================================================
// NOTIFICATIONS SERVICE
//
// The inbox itself is written by the database (migration 008 triggers on
// public.orders / public.deposits). This module only reads it, marks rows as
// read, and exposes one guarded helper (`announce`) for the rare application
// event that is not a row change — currently "email verified".
//
// Rules baked in here:
//   · a user can only ever read or touch their own rows (user_id is taken from
//     the session, never from the request body);
//   · marking read is idempotent — the second call returns 0, not an error;
//   · the list is paginated server-side so a long-lived inbox cannot be dumped
//     to the browser in one response.
// ============================================================================
import { AppError } from './errors.js';

const MAX_MARK = 100;

const toPublic = (row) => ({
  id: Number(row.id),
  type: row.type,
  severity: row.severity,
  title: row.title,
  body: row.body,
  orderId: row.order_id ?? null,
  depositId: row.deposit_id ?? null,
  meta: row.meta ?? {},
  readAt: row.read_at ?? null,
  createdAt: row.created_at
});

export function createNotificationService({ db, logger }) {
  const repo = () => {
    if (!db.notifications) {
      throw new AppError({
        code: 'NOTIFICATIONS_UNAVAILABLE',
        status: 503,
        expose: true,
        message: 'Kotak notifikasi belum tersedia di database ini.'
      });
    }
    return db.notifications;
  };

  return {
    /** Paginated inbox for the signed-in user. */
    async list({ user, page = 1, perPage = 20, unreadOnly = false }) {
      const limit = Math.min(Math.max(Number(perPage) || 20, 1), 50);
      const safePage = Math.max(Number(page) || 1, 1);
      const result = await repo().listByUser(user.id, {
        limit,
        offset: (safePage - 1) * limit,
        unreadOnly: Boolean(unreadOnly)
      });
      return {
        notifications: (result.rows || []).map(toPublic),
        unreadCount: result.unread ?? 0,
        total: result.total ?? 0,
        pagination: {
          page: safePage,
          perPage: limit,
          total: result.total ?? 0,
          pages: Math.max(1, Math.ceil((result.total ?? 0) / limit))
        }
      };
    },

    async unreadCount(user) {
      const rows = await repo().unreadCount(user.id);
      return Number(rows) || 0;
    },

    /**
     * Mark specific rows read. Ids are scoped to the caller inside the query, so
     * passing somebody else's id updates nothing instead of leaking existence.
     */
    async markRead({ user, ids = null }) {
      let list = null;
      if (ids !== null && ids !== undefined) {
        if (!Array.isArray(ids)) {
          throw new AppError({
            code: 'INVALID_INPUT',
            status: 400,
            expose: true,
            message: 'ids harus berupa array.'
          });
        }
        list = ids
          .map((value) => Number(value))
          .filter((value) => Number.isSafeInteger(value) && value > 0);
        if (list.length === 0) {
          throw new AppError({
            code: 'INVALID_INPUT',
            status: 400,
            expose: true,
            message: 'Tidak ada id notifikasi yang valid.'
          });
        }
        if (list.length > MAX_MARK) {
          throw new AppError({
            code: 'INVALID_INPUT',
            status: 400,
            expose: true,
            message: `Maksimal ${MAX_MARK} notifikasi sekali tandai.`
          });
        }
      }
      const updated = await repo().markRead(user.id, list);
      const unreadCount = await repo().unreadCount(user.id);
      return { updated, unreadCount };
    },

    /**
     * Application-level announcement for a verified event that is not a database
     * row change. Failures never break the caller: a missing notification is a
     * smaller problem than a failed login or a half-finished order.
     */
    async announce({ userId, type, title, body = null, severity = 'info', meta = {} }) {
      if (!userId || !type || !title) return null;
      try {
        return await repo().create({ userId, type, severity, title, body, meta });
      } catch (err) {
        logger?.warn?.('notification not written', { type, error: err.message });
        return null;
      }
    }
  };
}
