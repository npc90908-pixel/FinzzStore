// ============================================================================
// DATABASE — in-memory driver.
//
// Purpose: (1) run the whole application without Supabase credentials for local
// demo/preview, (2) exercise API and UI flows in automated tests.
//
// It deliberately mirrors the semantics of database/functions.sql — wallet
// locking, single-shot refunds, idempotency, transition matrix, deposit
// approval — because those rules must not live only in JavaScript in
// production. PostgreSQL remains the source of truth; this driver is never
// selected when NODE_ENV=production (see config.js).
// ============================================================================
import { randomUUID, createHash } from 'node:crypto';
import { AppError, appErrorFromCode } from './errors.js';
import { MINIMUM_TOPUP_AMOUNT } from './deposit-policy.js';

const nowIso = () => new Date().toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const DEFAULT_SETTINGS = {
  store_profile: {
    name: 'FINZZ Store',
    tagline: 'Nomor virtual instan untuk verifikasi akun',
    support_email: 'support@finzz.store',
    support_whatsapp: '',
    support_telegram: '',
    is_public: true
  },
  deposit_policy: {
    min_amount: MINIMUM_TOPUP_AMOUNT,
    max_amount: 5000000,
    instructions:
      'Transfer ke rekening resmi yang tertera, lalu unggah bukti transfer. Deposit diproses manual oleh admin maksimal 1x24 jam pada hari kerja.',
    bank_accounts: [],
    expiry_hours: 24,
    is_public: true
  },
  pricing_policy: { default_markup_bps: 1500, tax_bps: 0, tax_label: 'PPN', is_public: false },
  operations: {
    sales_open: true,
    maintenance_message: '',
    order_poll_interval_ms: 4000,
    server_poll_interval_ms: 15000,
    order_expiry_seconds: 1260,
    max_active_orders_per_user: 5,
    is_public: true
  },
  refund_policy: {
    summary:
      'Refund otomatis hanya jika nomor tidak pernah menerima OTP dan supplier mengonfirmasi order selesai tanpa OTP. Refund dicatat pada ledger dan hanya terjadi satu kali.',
    is_public: true
  },
  legal: { terms_version: '2026-10-01', privacy_version: '2026-10-01', is_public: true },
  supplier: { provider: 'telekos', server: 'server1', app_allowlist: [], sync_enabled: true, is_public: false }
};

export function createMemoryDatabase({ logger } = {}) {
  const store = {
  verifyContexts: new Map(),
    profiles: new Map(),
    oauthIdentities: new Map(),
    wallets: new Map(),
    transactions: [],
    deposits: new Map(),
    services: new Map(),
    orders: new Map(),
    orderEvents: [],
    settings: new Map(),
    auditLogs: [],
    sessions: new Map(),
    idempotency: new Map(),
    rateLimits: new Map(),
    leases: new Map(),
    cronLocks: new Map(),
    webhooks: new Map(),
    paymentWebhookEvents: new Map(),
    catalogRuns: [],
    notifications: [],
    // custom-auth one-time tokens (email verification / password reset)
    authTokens: [],
    // dev auth storage (see src/auth-dev.js) — legacy demo seeding only
    devUsers: new Map()
  };

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const { is_public, ...rest } = value;
    store.settings.set(key, { key, value: rest, is_public: Boolean(is_public), updated_at: nowIso() });
  }

  // ---------------------------------------------------------------- locking
  const locks = new Map();
  const withLock = async (key, fn) => {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(key, previous.then(() => current));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  };

  const auditRecord = (entry) => {
    const row = {
      id: store.auditLogs.length + 1,
      admin_id: entry.adminId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId || null,
      reason: entry.reason || null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: entry.ip || null,
      user_agent: entry.userAgent || null,
      created_at: nowIso()
    };
    store.auditLogs.unshift(row);
    return row;
  };

  const assertAdmin = (adminId) => {
    const p = store.profiles.get(adminId);
    if (!p || p.role !== 'admin' || p.status !== 'active') throw appErrorFromCode('FORBIDDEN');
  };

  const walletOf = (userId) => {
    let w = store.wallets.get(userId);
    if (!w) {
      w = { user_id: userId, balance: 0, currency: 'IDR', version: 0, created_at: nowIso(), updated_at: nowIso() };
      store.wallets.set(userId, w);
    }
    return w;
  };

  const ledgerApply = (userId, type, direction, amount, referenceType, referenceId, description, createdBy = null, metadata = {}) => {
    if (!Number.isFinite(amount) || amount <= 0) throw appErrorFromCode('INVALID_AMOUNT');
    if (Math.abs(amount - round2(amount)) > 0.000001) throw appErrorFromCode('INVALID_AMOUNT');
    const duplicate = store.transactions.some(
      (t) => t.reference_type === referenceType && t.reference_id === referenceId && t.type === type
    );
    if (duplicate) throw appErrorFromCode('DUPLICATE_LEDGER_ENTRY');

    const wallet = walletOf(userId);
    const before = round2(wallet.balance);
    const after = round2(direction === 'credit' ? before + amount : before - amount);
    if (after < 0) throw appErrorFromCode('INSUFFICIENT_BALANCE');

    wallet.balance = after;
    wallet.version += 1;
    wallet.updated_at = nowIso();
    const tx = {
      id: randomUUID(),
      user_id: userId,
      type,
      direction,
      amount: round2(amount),
      balance_before: before,
      balance_after: after,
      reference_type: referenceType,
      reference_id: referenceId,
      idempotency_key: null,
      description: description || null,
      created_by: createdBy,
      metadata: metadata || {},
      created_at: nowIso()
    };
    store.transactions.unshift(tx);
    return tx;
  };

  const addEvent = (orderId, eventType, fromStatus, toStatus, source, message, metadata = {}, actorId = null) => {
    const row = {
      id: store.orderEvents.length + 1,
      order_id: orderId,
      event_type: eventType,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      source,
      actor_id: actorId,
      message: message || null,
      metadata,
      created_at: nowIso()
    };
    store.orderEvents.push(row);
    // Notifikasi hanya lahir dari perubahan status yang benar-benar tercatat.
    if (toStatus && fromStatus !== toStatus) {
      notifyOrderStatus(store.orders.get(orderId), fromStatus, toStatus);
    }
    return row;
  };


  // ---------------------------------------------------------------------------
  // NOTIFIKASI (paritas dengan trigger database di migration 008)
  // Di Postgres, baris notifikasi dibuat oleh trigger pada public.orders dan
  // public.deposits. Driver in-memory tidak punya trigger, jadi pemetaan yang
  // sama diterapkan di sini — di satu tempat, di fungsi addEvent() yang sudah
  // menjadi satu-satunya jalur perubahan status order. Dengan begitu demo lokal
  // dan tes API berperilaku seperti produksi, bukan seperti versi yang lebih
  // ramah dari produksi.
  // ---------------------------------------------------------------------------
  const ORDER_NOTIFICATION_MAP = {
    waiting: ['order.waiting', 'info', 'Nomor sudah terbit'],
    received: ['order.received', 'success', 'Kode OTP diterima'],
    completed: ['order.completed', 'success', 'Order selesai'],
    cancelled: ['order.cancelled', 'warning', 'Order dibatalkan'],
    expired: ['order.expired', 'warning', 'Order kedaluwarsa'],
    failed: ['order.failed', 'warning', 'Pesanan gagal di supplier'],
    needs_review: ['order.needs_review', 'danger', 'Order perlu ditinjau']
  };

  const pushNotification = ({ userId, type, severity = 'info', title, body = null, orderId = null, depositId = null, meta = {} }) => {
    if (!userId || !type || !title) return null;
    const limit = 500;
    const row = {
      id: (store.notifications.at(-1)?.id ?? 0) + 1,
      user_id: userId,
      type,
      severity,
      title: String(title).slice(0, 120),
      body: body ? String(body).slice(0, 600) : null,
      order_id: orderId,
      deposit_id: depositId,
      meta,
      read_at: null,
      created_at: nowIso()
    };
    store.notifications.push(row);
    // The demo store should not grow without bound during long test runs.
    if (store.notifications.length > limit * 20) store.notifications.splice(0, store.notifications.length - limit * 20);
    return row;
  };

  const notifyOrderStatus = (order, fromStatus, toStatus) => {
    if (!order || !toStatus || fromStatus === toStatus) return;
    if (fromStatus === null && toStatus === 'pending') {
      pushNotification({
        userId: order.user_id,
        type: 'order.created',
        severity: 'info',
        title: 'Order dibuat',
        body: `Order ${order.provider_app_name} ${order.provider_country_name} sedang diproses. Nomor dan OTP muncul otomatis di halaman Order & OTP.`,
        orderId: order.id,
        meta: { status: order.status, totalPrice: Number(order.total_price) }
      });
      return;
    }
    const mapped = ORDER_NOTIFICATION_MAP[toStatus];
    if (!mapped) return;
    const [type, severity, title] = mapped;
    pushNotification({
      userId: order.user_id,
      type,
      severity,
      title,
      body: `Order ${order.provider_app_name} ${order.provider_country_name} berpindah status ke ${toStatus}.`,
      orderId: order.id,
      meta: { from: fromStatus, to: toStatus }
    });
  };

  const transitionAllowed = (from, to) => {
    if (from === to) return true;
    const map = {
      pending: ['waiting', 'received', 'completed', 'failed', 'cancelled', 'expired', 'needs_review'],
      waiting: ['received', 'completed', 'failed', 'cancelled', 'expired', 'needs_review'],
      received: ['completed', 'cancelled', 'expired', 'needs_review'],
      needs_review: ['completed', 'cancelled', 'expired', 'failed', 'waiting', 'received']
    };
    return (map[from] || []).includes(to);
  };

  const isTerminal = (status) => ['completed', 'cancelled', 'expired', 'failed'].includes(status);

  const refundOrderOnce = (order, reason, source = 'system', adminId = null) => {
    if (order.refunded_at) return false;
    ledgerApply(order.user_id, 'refund', 'credit', Number(order.total_price), 'order', order.id,
      `Refund order ${order.id.slice(0, 8)} (${reason})`, adminId, { reason });
    order.refunded_at = nowIso();
    addEvent(order.id, 'order_refunded', order.status, order.status, source, 'Saldo dikembalikan penuh',
      { amount: Number(order.total_price) });
    pushNotification({
      userId: order.user_id,
      type: 'wallet.refund',
      severity: 'success',
      title: 'Saldo dikembalikan',
      body: `Saldo untuk order ${order.provider_app_name} ${order.provider_country_name} sudah kembali ke dompet Anda.`,
      orderId: order.id,
      meta: { status: order.status, amount: Number(order.total_price) }
    });
    return true;
  };

  const paginate = (rows, { limit = 20, offset = 0 }) => {
    const total = rows.length;
    return { rows: rows.slice(offset, offset + limit), total };
  };

  const db = {
    kind: 'memory',
    store,

    /**
     * Minimal SQL surface used by the auth service. The in-memory driver has no
     * SQL engine, so only the two statements the auth layer issues are
     * supported; anything else throws loudly instead of silently succeeding.
     */
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('select expires_at, consumed_at from public.auth_tokens')) {
        const row = store.authTokens
          .filter((t) => t.token_hash === params[0] && t.kind === 'password_reset')
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
        return { rows: row ? [{ expires_at: row.expires_at, consumed_at: row.consumed_at }] : [] };
      }
      if (sql.startsWith('update public.profiles set password_hash')) {
        const profile = store.profiles.get(params[0]);
        if (!profile) return { rows: [] };
        profile.password_hash = params[1];
        profile.password_auth_enabled = true;
        profile.password_updated_at = nowIso();
        profile.updated_at = nowIso();
        return { rows: [structuredClone(profile)] };
      }
      throw new Error(`memory driver: unsupported SQL — ${sql.slice(0, 80)}`);
    },

    /** RPC dispatcher for the custom-auth functions. */
    async call(name, params = {}) {
      const fail = (message) => { const e = new Error(message); e.code = message; throw e; };

      switch (name) {
        case 'rpc_register_user': {
          const email = String(params.p_email || '').toLowerCase();
          if (!email.includes('@')) fail('EMAIL_INVALID');
          if ([...store.profiles.values()].some((p) => p.email.toLowerCase() === email)) fail('EMAIL_TAKEN');
          const id = randomUUID();
          const profile = {
            id,
            email,
            username: params.p_username || null,
            full_name: null,
            phone: null,
            role: 'user',
            status: 'active',
            email_verified_at: null,
            password_hash: params.p_password_hash,
            password_auth_enabled: true,
            password_updated_at: nowIso(),
            failed_login_count: 0,
            locked_until: null,
            last_login_at: null,
            last_seen_at: null,
            created_at: nowIso(),
            updated_at: nowIso()
          };
          store.profiles.set(id, profile);
          const wallet = { user_id: id, balance: 0, currency: 'IDR', created_at: nowIso(), updated_at: nowIso() };
          store.wallets.set(id, wallet);
          return { profile: structuredClone(profile), wallet: structuredClone(wallet) };
        }

        case 'rpc_issue_auth_token': {
          if (!/^[a-f0-9]{64}$/.test(String(params.p_token_hash || ''))) fail('TOKEN_HASH_INVALID');
          // A new token supersedes pending tokens of the same kind.
          for (const t of store.authTokens) {
            if (t.user_id === params.p_user_id && t.kind === params.p_kind && !t.consumed_at) t.consumed_at = nowIso();
          }
          const expiresAt = new Date(Date.now() + Number(params.p_ttl_seconds) * 1000).toISOString();
          store.authTokens.push({
            user_id: params.p_user_id,
            kind: params.p_kind,
            token_hash: params.p_token_hash,
            expires_at: expiresAt,
            consumed_at: null,
            attempts: 0,
            max_attempts: params.p_max_attempts ?? 5,
            created_at: nowIso()
          });
          return { expires_at: expiresAt };
        }

        case 'rpc_consume_email_token': {
          const token = store.authTokens
            .filter((t) => t.token_hash === params.p_token_hash
              && t.kind === params.p_kind
              && !t.consumed_at
              && (!params.p_user_id || t.user_id === params.p_user_id))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
          if (!token) {
            // Mirror migration 004: a wrong guess against a known account is
            // charged to that account's live token, then the token is burned
            // once max_attempts is reached. Result objects, not exceptions, so
            // the counter survives.
            let remaining = 0;
            if (params.p_user_id) {
              for (const t of store.authTokens) {
                if (t.user_id === params.p_user_id && t.kind === params.p_kind && !t.consumed_at) {
                  t.attempts += 1;
                  if (t.attempts >= t.max_attempts) t.consumed_at = nowIso();
                  remaining = Math.max(0, t.max_attempts - t.attempts);
                }
              }
            }
            return { ok: false, reason: 'TOKEN_INVALID', attempts_remaining: remaining };
          }
          if (new Date(token.expires_at).getTime() < Date.now()) {
            token.consumed_at = nowIso();
            return { ok: false, reason: 'TOKEN_EXPIRED', attempts_remaining: 0 };
          }
          if (token.attempts >= token.max_attempts) {
            token.consumed_at = nowIso();
            return { ok: false, reason: 'TOKEN_ATTEMPTS_EXCEEDED', attempts_remaining: 0 };
          }
          token.consumed_at = nowIso();
          token.attempts += 1;
          const profile = store.profiles.get(token.user_id);
          if (params.p_kind === 'email_verification' && profile && !profile.email_verified_at) {
            profile.email_verified_at = nowIso();
          }
          return { ok: true, user_id: token.user_id, email: profile?.email || null, email_verified_at: profile?.email_verified_at || null };
        }

        case 'rpc_complete_password_reset': {
          const token = store.authTokens
            .filter((t) => t.token_hash === params.p_token_hash
              && t.kind === 'password_reset'
              && !t.consumed_at)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
          if (!token) fail('TOKEN_INVALID');
          if (new Date(token.expires_at).getTime() < Date.now()) {
            token.consumed_at = nowIso();
            fail('TOKEN_EXPIRED');
          }
          token.consumed_at = nowIso();
          const profile = store.profiles.get(token.user_id);
          if (profile) {
            profile.password_hash = params.p_password_hash;
            profile.password_auth_enabled = true;
            profile.password_updated_at = nowIso();
            profile.failed_login_count = 0;
            profile.locked_until = null;
          }
          // Every existing session dies with the password.
          for (const session of store.sessions.values()) {
            if (session.user_id === token.user_id && !session.revoked_at) session.revoked_at = nowIso();
          }
          return { user_id: token.user_id };
        }

        case 'rpc_note_login': {
          const profile = store.profiles.get(params.p_user_id);
          if (!profile) return null;
          if (params.p_success) {
            profile.failed_login_count = 0;
            profile.locked_until = null;
            profile.last_login_at = nowIso();
          } else {
            profile.failed_login_count += 1;
            if (profile.failed_login_count >= (params.p_max_failures ?? 10)) {
              profile.locked_until = new Date(Date.now() + (params.p_lock_seconds ?? 900) * 1000).toISOString();
            }
          }
          return { failed_login_count: profile.failed_login_count, locked_until: profile.locked_until };
        }

        case 'rpc_cleanup_auth': {
          const before = store.authTokens.length;
          store.authTokens = store.authTokens.filter((t) => new Date(t.expires_at).getTime() > Date.now() - 86400000);
          return { tokens_deleted: before - store.authTokens.length, sessions_deleted: 0 };
        }

        default:
          throw new Error(`memory driver: unsupported RPC — ${name}`);
      }
    },

    async ping() {
      return { ok: true, latencyMs: 1 };
    },

    settings: {
      async get(key) {
        const row = store.settings.get(key);
        return row ? structuredClone(row.value) : null;
      },
      async getAll() {
        return Object.fromEntries([...store.settings.values()].map((r) => [r.key, structuredClone(r.value)]));
      },
      async getPublic() {
        return Object.fromEntries(
          [...store.settings.values()].filter((r) => r.is_public).map((r) => [r.key, structuredClone(r.value)])
        );
      },
      async update(key, value, adminId) {
        const row = store.settings.get(key);
        if (!row) throw new AppError('NOT_FOUND', 'Pengaturan tidak ditemukan.', 404);
        row.value = value;
        row.updated_by = adminId;
        row.updated_at = nowIso();
        return structuredClone(row);
      }
    },

    profiles: {
      async get(id) {
        const p = store.profiles.get(id);
        return p ? structuredClone(p) : null;
      },
      async byEmail(email) {
        const found = [...store.profiles.values()].find((p) => p.email.toLowerCase() === String(email).toLowerCase());
        if (!found) return null;
        const clone = structuredClone(found);
        delete clone.password_hash;
        return clone;
      },
      /** Full row including password_hash — auth layer only. */
      /** Demo/local seeding only (see pg driver). */
      async seedDemo({ email, passwordHash, role = 'user', verified = true }) {
        const normalised = String(email).toLowerCase();
        const id = randomUUID();
        const profile = {
          id, email: normalised, username: null, full_name: null, phone: null,
          role, status: 'active',
          email_verified_at: verified ? nowIso() : null,
          password_hash: passwordHash,
          password_auth_enabled: true,
          password_updated_at: nowIso(),
          failed_login_count: 0, locked_until: null, last_login_at: null, last_seen_at: null,
          created_at: nowIso(), updated_at: nowIso()
        };
        store.profiles.set(id, profile);
        const wallet = { user_id: id, balance: 0, currency: 'IDR', created_at: nowIso(), updated_at: nowIso() };
        store.wallets.set(id, wallet);
        const clone = structuredClone(profile);
        delete clone.password_hash;
        return { profile: clone, wallet: structuredClone(wallet) };
      },
      /** Full row including password_hash — auth layer only. */
      async byEmailWithSecret(email) {
        const found = [...store.profiles.values()].find((p) => p.email.toLowerCase() === String(email).toLowerCase());
        return found ? structuredClone(found) : null;
      },
      async ensure({ userId, email, username }) {
        let profile = store.profiles.get(userId);
        if (!profile) {
          profile = {
            id: userId,
            email: String(email).toLowerCase(),
            username: username || null,
            full_name: null,
            phone: null,
            role: 'user',
            status: 'active',
            email_verified_at: null,
            password_auth_enabled: false,
            last_seen_at: null,
            created_at: nowIso(),
            updated_at: nowIso()
          };
          store.profiles.set(userId, profile);
        }
        walletOf(userId);
        return { profile: structuredClone(profile), wallet: structuredClone(walletOf(userId)) };
      },
      async update(id, patch) {
        const p = store.profiles.get(id);
        if (!p) return null;
        const allowed = ['full_name', 'username', 'phone'];
        for (const key of allowed) {
          if (key in patch) p[key] = patch[key];
        }
        p.updated_at = nowIso();
        return structuredClone(p);
      },
      async touch(id) {
        const p = store.profiles.get(id);
        if (p) p.last_seen_at = nowIso();
      },
      async markEmailVerified(id) {
        const p = store.profiles.get(id);
        if (p && !p.email_verified_at) p.email_verified_at = nowIso();
        return { ok: Boolean(p) };
      },
      async list({ search = '', role = null, status = null, limit = 25, offset = 0 } = {}) {
        let rows = [...store.profiles.values()];
        if (search) {
          const needle = search.toLowerCase();
          rows = rows.filter((p) => p.email.toLowerCase().includes(needle) || (p.username || '').includes(needle));
        }
        if (role) rows = rows.filter((p) => p.role === role);
        if (status) rows = rows.filter((p) => p.status === status);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const page = paginate(rows.map((r) => structuredClone(r)), { limit, offset });
        return page;
      },
      async setRole(userId, adminId, role) {
        assertAdmin(adminId);
        const p = store.profiles.get(userId);
        if (!p) throw appErrorFromCode('USER_NOT_FOUND');
        if (p.role === 'admin' && role === 'user') {
          const admins = [...store.profiles.values()].filter((x) => x.role === 'admin' && x.status === 'active');
          if (admins.length <= 1) throw appErrorFromCode('LAST_ADMIN');
        }
        const before = p.role;
        p.role = role;
        p.updated_at = nowIso();
        auditRecord({ adminId, action: 'user.role_change', targetType: 'profile', targetId: userId, before: { role: before }, after: { role } });
        return { profile: structuredClone(p) };
      },
      async setStatus(userId, adminId, status, reason) {
        assertAdmin(adminId);
        const p = store.profiles.get(userId);
        if (!p) throw appErrorFromCode('USER_NOT_FOUND');
        if (userId === adminId && status !== 'active') throw appErrorFromCode('FORBIDDEN');
        const before = p.status;
        p.status = status;
        p.updated_at = nowIso();
        auditRecord({ adminId, action: 'user.status_change', targetType: 'profile', targetId: userId, reason, before: { status: before }, after: { status } });
        return { profile: structuredClone(p) };
      },
      async count() {
        return store.profiles.size;
      }
    },

    oauthIdentities: {
      async listForUser(userId) {
        return [...store.oauthIdentities.values()]
          .filter((identity) => identity.user_id === userId)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .map(({ provider, provider_email, provider_name, created_at }) => ({
            provider, provider_email, provider_name, linked_at: created_at
          }));
      },
      async findBySubject(provider, subject) {
        const identity = store.oauthIdentities.get(`${provider}:${subject}`);
        return identity ? structuredClone(identity) : null;
      },
      async link({ userId, providerSubject, email, name, ip, userAgent }) {
        return withLock(`oauth-user:${userId}`, () => withLock(`oauth-sub:${providerSubject}`, async () => {
          const profile = store.profiles.get(userId);
          if (!profile) return { linked: false, reason: 'USER_NOT_FOUND' };
          const bySubject = store.oauthIdentities.get(`google:${providerSubject}`);
          if (bySubject && bySubject.user_id !== userId) {
            auditRecord({
              adminId: null, action: 'oauth.google.link_conflict', targetType: 'user', targetId: userId,
              reason: 'Google subject is already linked to another account',
              after: { provider: 'google', email, conflictingUserId: bySubject.user_id }, ip, userAgent
            });
            return { linked: false, conflict: true };
          }
          const byUser = [...store.oauthIdentities.values()].find((item) => item.user_id === userId && item.provider === 'google');
          if (byUser && byUser.provider_subject !== providerSubject) {
            auditRecord({
              adminId: null, action: 'oauth.google.link_conflict', targetType: 'user', targetId: userId,
              reason: 'A different Google subject is already linked to this account',
              after: { provider: 'google', email }, ip, userAgent
            });
            return { linked: false, conflict: true };
          }
          if (bySubject) {
            bySubject.provider_email = email;
            bySubject.provider_name = name || null;
            bySubject.updated_at = nowIso();
            return { linked: true, alreadyLinked: true };
          }
          const row = {
            id: randomUUID(), user_id: userId, provider: 'google', provider_subject: providerSubject,
            provider_email: email, provider_name: name || null, created_at: nowIso(), updated_at: nowIso()
          };
          store.oauthIdentities.set(`google:${providerSubject}`, row);
          auditRecord({
            adminId: null, action: 'oauth.google.link', targetType: 'user', targetId: userId,
            reason: 'Google identity linked by authenticated user',
            after: { provider: 'google', email }, ip, userAgent
          });
          return { linked: true, alreadyLinked: false };
        }));
      },
      async createAccount({ email, passwordHash, username, providerSubject, name, ip, userAgent }) {
        const normalised = String(email).toLowerCase();
        return withLock(`oauth-sub:${providerSubject}`, () => withLock(`email:${normalised}`, async () => {
          const existingIdentity = store.oauthIdentities.get(`google:${providerSubject}`);
          if (existingIdentity) return { created: false, identity: structuredClone(existingIdentity) };
          if ([...store.profiles.values()].some((profile) => profile.email.toLowerCase() === normalised)) {
            return { created: false, emailConflict: true };
          }
          const id = randomUUID();
          const profile = {
            id, email: normalised, username: username || null, full_name: name || null, phone: null,
            role: 'user', status: 'active', email_verified_at: nowIso(),
            password_hash: passwordHash, password_auth_enabled: false, password_updated_at: nowIso(),
            failed_login_count: 0, locked_until: null, last_login_at: null, last_seen_at: null,
            created_at: nowIso(), updated_at: nowIso()
          };
          store.profiles.set(id, profile);
          const wallet = walletOf(id);
          const identity = {
            id: randomUUID(), user_id: id, provider: 'google', provider_subject: providerSubject,
            provider_email: normalised, provider_name: name || null, created_at: nowIso(), updated_at: nowIso()
          };
          store.oauthIdentities.set(`google:${providerSubject}`, identity);
          auditRecord({
            adminId: null, action: 'auth.google_register', targetType: 'user', targetId: id,
            reason: 'New account created with verified Google OIDC identity',
            after: { provider: 'google', email: normalised }, ip, userAgent
          });
          return { created: true, profile: structuredClone(profile), wallet: structuredClone(wallet) };
        }));
      },
      async unlink({ userId, ip, userAgent }) {
        return withLock(`oauth-user:${userId}`, async () => {
          const identity = [...store.oauthIdentities.values()].find((item) => item.user_id === userId && item.provider === 'google');
          if (!identity) return { unlinked: false, reason: 'NOT_LINKED' };
          const profile = store.profiles.get(userId);
          const otherIdentity = [...store.oauthIdentities.values()].some((item) => item.user_id === userId && item.provider !== 'google');
          if (!profile?.password_auth_enabled && !otherIdentity) return { unlinked: false, reason: 'LAST_LOGIN_METHOD' };
          store.oauthIdentities.delete(`google:${identity.provider_subject}`);
          auditRecord({
            adminId: null, action: 'oauth.google.unlink', targetType: 'user', targetId: userId,
            reason: 'Google identity unlinked by authenticated user',
            before: { provider: 'google', email: identity.provider_email }, ip, userAgent
          });
          return { unlinked: true };
        });
      }
    },

    wallets: {
      async get(userId) {
        return structuredClone(walletOf(userId));
      },
      async adjust(userId, adminId, { direction, amount, reason, reference }) {
        assertAdmin(adminId);
        if (!reason || reason.length < 5) throw appErrorFromCode('INVALID_INPUT');
        if (!reference) throw appErrorFromCode('INVALID_INPUT');
        if (!['credit', 'debit'].includes(direction)) throw appErrorFromCode('INVALID_INPUT');
        return withLock(`wallet:${userId}`, () => {
          try {
            const tx = ledgerApply(userId, 'adjustment', direction, amount, 'adjustment', reference,
              `Penyesuaian admin: ${reason}`, adminId, { reason });
            auditRecord({ adminId, action: 'wallet.adjustment', targetType: 'wallet', targetId: userId, reason, after: { direction, amount, reference } });
            return { balance: tx.balance_after, transaction_id: tx.id };
          } catch (err) {
            if (err.code === 'DUPLICATE_LEDGER_ENTRY') throw appErrorFromCode('DUPLICATE_ADJUSTMENT');
            throw err;
          }
        });
      }
    },

    transactions: {
      async listByUser(userId, { limit = 25, offset = 0 } = {}) {
        const rows = store.transactions.filter((t) => t.user_id === userId);
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },
      async listAll({ limit = 50, offset = 0, type = null } = {}) {
        let rows = store.transactions;
        if (type) rows = rows.filter((t) => t.type === type);
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      }
    },

    services: {
      async listPublic() {
        return [...store.services.values()]
          .filter((s) => s.is_active)
          .sort((a, b) => a.sort_order - b.sort_order || Number(a.price) - Number(b.price))
          .map((s) => structuredClone(s));
      },
      async listAll({ limit = 200, offset = 0 } = {}) {
        const rows = [...store.services.values()].sort((a, b) => a.sort_order - b.sort_order);
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },
      async get(id) {
        const s = store.services.get(id);
        return s ? structuredClone(s) : null;
      },
      async sync(provider, server, items) {
        let upserted = 0;
        const seen = new Set();
        for (const item of items) {
          seen.add(item.code);
          const existing = [...store.services.values()].find((s) => s.code === item.code);
          const row = {
            id: existing?.id || randomUUID(),
            code: item.code,
            name: item.name,
            provider,
            provider_server: server,
            provider_app_id: item.provider_app_id,
            app_name: item.app_name,
            country_id: item.country_id,
            country_name: item.country_name,
            country_iso: item.country_iso || null,
            country_calling_code: item.country_calling_code || null,
            supplier_price: item.supplier_price,
            markup_bps: existing?.markup_bps ?? 1500,
            price: item.price,
            stock: item.stock ?? 0,
            currency: 'IDR',
            is_active: item.is_active !== false,
            sort_order: existing?.sort_order ?? 100,
            price_synced_at: nowIso(),
            created_at: existing?.created_at || nowIso(),
            updated_at: nowIso()
          };
          store.services.set(row.id, row);
          upserted += 1;
        }
        let deactivated = 0;
        for (const svc of store.services.values()) {
          if (svc.provider === provider && svc.provider_server === server && !seen.has(svc.code) && svc.is_active) {
            svc.is_active = false;
            deactivated += 1;
          }
        }
        return { upserted, deactivated };
      },
      async update(id, patch) {
        const svc = store.services.get(id);
        if (!svc) return null;
        for (const key of ['is_active', 'markup_bps', 'price', 'sort_order', 'stock', 'name']) {
          if (key in patch) svc[key] = patch[key];
        }
        svc.updated_at = nowIso();
        return structuredClone(svc);
      },
      async lastSyncAt() {
        return store.catalogRuns[0] ? structuredClone(store.catalogRuns[0]) : null;
      },
      async recordSyncRun(entry) {
        const row = { id: store.catalogRuns.length + 1, started_at: nowIso(), ...entry };
        store.catalogRuns.unshift(row);
        return structuredClone(row);
      }
    },

    orders: {
      async create(params) {
        const {
          userId, serviceId, idempotencyKey, requestHash, supplierPrice, markupAmount, taxAmount, totalPrice,
          provider, providerServer, providerAppId, providerAppName, countryId, countryName, countryIso,
          providerOfferId, maxActiveOrders = 5
        } = params;

        return withLock(`idem:${userId}:${idempotencyKey}`, async () => {
          const existingKey = store.idempotency.get(`${userId}:${idempotencyKey}`);
          if (existingKey) {
            if (existingKey.payload_hash !== requestHash) throw appErrorFromCode('IDEMPOTENCY_CONFLICT');
            const existingOrder = store.orders.get(existingKey.resource_id);
            return {
              replayed: true,
              order: structuredClone(existingOrder),
              balance: walletOf(userId).balance
            };
          }

          const active = [...store.orders.values()].filter(
            (o) => o.user_id === userId && ['pending', 'waiting', 'received'].includes(o.status)
          );
          if (active.length >= maxActiveOrders) throw appErrorFromCode('TOO_MANY_ACTIVE_ORDERS');

          if (!Number.isFinite(totalPrice) || totalPrice <= 0) throw appErrorFromCode('INVALID_AMOUNT');
          if (round2(totalPrice) !== round2(supplierPrice + markupAmount + taxAmount)) {
            throw appErrorFromCode('INVALID_AMOUNT');
          }

          return withLock(`wallet:${userId}`, () => {
            const orderId = randomUUID();
            const tx = ledgerApply(userId, 'purchase', 'debit', totalPrice, 'order', orderId, 'Pembelian layanan nokos');
            const order = {
              id: orderId,
              user_id: userId,
              service_id: serviceId,
              idempotency_key: idempotencyKey,
              request_hash: requestHash,
              status: 'pending',
              provider,
              provider_server: providerServer,
              provider_app_id: providerAppId,
              provider_app_name: providerAppName,
              provider_country_id: countryId,
              provider_country_name: countryName,
              provider_country_iso: countryIso || null,
              provider_offer_id: providerOfferId,
              supplier_order_id: null,
              phone_number: null,
              otp_code: null,
              otp_message: null,
              otp_sender: null,
              otp_received_at: null,
              otp_count: 0,
              supplier_price: round2(supplierPrice),
              markup_amount: round2(markupAmount),
              tax_amount: round2(taxAmount),
              total_price: round2(totalPrice),
              currency: 'IDR',
              can_cancel: false,
              cancel_available_at: null,
              cancel_requested_at: null,
              expires_at: null,
              completed_at: null,
              closed_at: null,
              refunded_at: null,
              last_synced_at: null,
              next_sync_at: new Date(Date.now() + 30000).toISOString(),
              sync_lease_until: null,
              sync_owner: null,
              sync_attempts: 0,
              last_error_code: null,
              last_error_message: null,
              created_at: nowIso(),
              updated_at: nowIso()
            };
            store.orders.set(orderId, order);
            store.idempotency.set(`${userId}:${idempotencyKey}`, {
              user_id: userId,
              scope: 'order_create',
              key: idempotencyKey,
              payload_hash: requestHash,
              resource_id: orderId,
              created_at: nowIso()
            });
            addEvent(orderId, 'order_created', null, 'pending', 'user', 'Order dibuat dan saldo didebit',
              { total_price: totalPrice, supplier_price: supplierPrice }, userId);
            return { replayed: false, order: structuredClone(order), balance: tx.balance_after };
          });
        });
      },

      async get(id) {
        const o = store.orders.get(id);
        return o ? structuredClone(o) : null;
      },
      async setPricingSnapshot(orderId, snapshot) {
        const row = store.orders.get(orderId);
        if (!row) return false;
        row.pricing_snapshot = snapshot ?? null;
        return true;
      },
      async findBySupplierId(supplierOrderId) {
        const found = [...store.orders.values()].find((o) => o.supplier_order_id === supplierOrderId);
        return found ? structuredClone(found) : null;
      },
      async getForUser(id, userId) {
        const o = store.orders.get(id);
        return o && o.user_id === userId ? structuredClone(o) : null;
      },
      async listByUser(userId, { status = null, limit = 20, offset = 0 } = {}) {
        let rows = [...store.orders.values()].filter((o) => o.user_id === userId);
        if (status) rows = rows.filter((o) => o.status === status);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },
      async listActive(userId) {
        return [...store.orders.values()]
          .filter((o) => o.user_id === userId && ['pending', 'waiting', 'received', 'needs_review'].includes(o.status))
          .map((o) => structuredClone(o));
      },
      async adminList({ status = null, search = '', limit = 30, offset = 0 } = {}) {
        let rows = [...store.orders.values()];
        if (status) rows = rows.filter((o) => o.status === status);
        if (search) {
          const needle = search.toLowerCase();
          rows = rows.filter((o) => (o.supplier_order_id || '').toLowerCase().includes(needle) || (o.phone_number || '').includes(needle));
        }
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },

      async attach({ orderId, supplierOrderId, status, phoneNumber, expiresAt, canCancel, cancelAvailableAt }) {
        return withLock(`order:${orderId}`, () => {
          const order = store.orders.get(orderId);
          if (!order) throw appErrorFromCode('ORDER_NOT_FOUND');
          if (order.supplier_order_id) {
            if (order.supplier_order_id !== supplierOrderId) throw appErrorFromCode('SUPPLIER_ORDER_MISMATCH');
            return { order: structuredClone(order), changed: false };
          }
          if (order.status !== 'pending') throw appErrorFromCode('INVALID_TRANSITION');
          order.supplier_order_id = supplierOrderId;
          order.status = ['waiting', 'received', 'completed'].includes(status) ? status : 'waiting';
          if (phoneNumber) order.phone_number = phoneNumber;
          if (expiresAt) order.expires_at = expiresAt;
          order.can_cancel = Boolean(canCancel);
          if (cancelAvailableAt) order.cancel_available_at = cancelAvailableAt;
          order.next_sync_at = new Date(Date.now() + 5000).toISOString();
          order.sync_lease_until = null;
          order.sync_owner = null;
          order.last_synced_at = nowIso();
          order.last_error_code = null;
          order.updated_at = nowIso();
          addEvent(orderId, 'supplier_order_attached', 'pending', order.status, 'system', 'Nomor virtual diterbitkan supplier');
          return { order: structuredClone(order), changed: true };
        });
      },

      async applyState({ orderId, status, phoneNumber, otps, canCancel, cancelAvailableAt, expiresAt, source, errorCode, message }) {
        return withLock(`order:${orderId}`, () => {
          const order = store.orders.get(orderId);
          if (!order) throw appErrorFromCode('ORDER_NOT_FOUND');
          if (isTerminal(order.status)) {
            return { order: structuredClone(order), changed: false, refunded: false, reason: 'terminal' };
          }
          if (!transitionAllowed(order.status, status)) throw appErrorFromCode('INVALID_TRANSITION');

          const prev = order.status;
          const list = Array.isArray(otps) ? otps : [];
          if (list.length > 0) {
            const newest = list[list.length - 1];
            if (newest?.code) order.otp_code = String(newest.code).slice(0, 32);
            if (newest?.message) order.otp_message = String(newest.message).slice(0, 500);
            if (newest?.sender) order.otp_sender = String(newest.sender).slice(0, 80);
            order.otp_received_at = order.otp_received_at || nowIso();
            order.otp_count = Math.max(order.otp_count, list.length);
          }
          if (phoneNumber) order.phone_number = phoneNumber;
          if (typeof canCancel === 'boolean') order.can_cancel = canCancel;
          if (cancelAvailableAt) order.cancel_available_at = cancelAvailableAt;
          if (expiresAt) order.expires_at = expiresAt;

          order.status = status;
          order.last_synced_at = nowIso();
          order.sync_lease_until = null;
          order.sync_owner = null;
          order.last_error_code = errorCode || null;
          order.last_error_message = message ? String(message).slice(0, 500) : null;
          order.updated_at = nowIso();
          if (status === 'completed') order.completed_at = order.completed_at || nowIso();
          if (isTerminal(status)) {
            order.closed_at = order.closed_at || nowIso();
            // Fulfil or abandon the pending cancel request with the order.
            order.cancel_requested_at = null;
          }

          addEvent(orderId, 'supplier_state', prev, status, source || 'system',
            message || 'Sinkronisasi status supplier', { error_code: errorCode, otp_count: order.otp_count });

          let refunded = false;
          if (['cancelled', 'expired', 'failed'].includes(status) && order.otp_count === 0 && !order.refunded_at) {
            refunded = refundOrderOnce(order, status, 'system');
          }
          return { order: structuredClone(order), changed: true, refunded, previous_status: prev };
        });
      },

      async fail({ orderId, errorCode, message, refund = true, source = 'system' }) {
        return withLock(`order:${orderId}`, () => {
          const order = store.orders.get(orderId);
          if (!order) throw appErrorFromCode('ORDER_NOT_FOUND');
          if (order.status !== 'pending') {
            return { order: structuredClone(order), changed: false, refunded: false, reason: 'not_pending' };
          }
          if (order.supplier_order_id) throw appErrorFromCode('ORDER_HAS_SUPPLIER_REFERENCE');
          const prev = order.status;
          order.status = 'failed';
          order.closed_at = nowIso();
          order.last_error_code = errorCode || null;
          order.last_error_message = message ? String(message).slice(0, 500) : null;
          order.last_synced_at = nowIso();
          order.updated_at = nowIso();
          addEvent(orderId, 'supplier_rejected', prev, 'failed', source, message || 'Pembelian ditolak supplier', { error_code: errorCode });
          const refunded = refund ? refundOrderOnce(order, errorCode || 'failed') : false;
          return { order: structuredClone(order), changed: true, refunded };
        });
      },

      async beginCancel(orderId, userId) {
        return withLock(`order:${orderId}`, () => {
          const order = store.orders.get(orderId);
          if (!order) throw appErrorFromCode('ORDER_NOT_FOUND');
          if (order.user_id !== userId) throw appErrorFromCode('FORBIDDEN');
          if (order.cancel_requested_at) return { order: structuredClone(order), already_requested: true };
          if (!['waiting', 'received'].includes(order.status)) throw appErrorFromCode('CANCEL_NOT_AVAILABLE');
          if (order.otp_count > 0) throw appErrorFromCode('CANCEL_NOT_AVAILABLE');
          if (!order.can_cancel) throw appErrorFromCode('CANCEL_NOT_AVAILABLE');
          order.cancel_requested_at = nowIso();
          order.updated_at = nowIso();
          addEvent(orderId, 'cancel_requested', order.status, order.status, 'user', 'Pengguna meminta pembatalan', {}, userId);
          return { order: structuredClone(order), already_requested: false };
        });
      },

      async releaseCancel(orderId, message) {
        const order = store.orders.get(orderId);
        if (!order || !['waiting', 'received'].includes(order.status)) return { released: false };
        order.cancel_requested_at = null;
        if (message) order.last_error_message = String(message).slice(0, 500);
        order.next_sync_at = new Date(Date.now() + 20000).toISOString();
        order.updated_at = nowIso();
        return { released: true, order: structuredClone(order) };
      },

      async refund(orderId, reason, adminId = null) {
        if (adminId) assertAdmin(adminId);
        return withLock(`order:${orderId}`, () => {
          const order = store.orders.get(orderId);
          if (!order) throw appErrorFromCode('ORDER_NOT_FOUND');
          if (order.refunded_at) return { refunded: false, reason: 'already_refunded', order: structuredClone(order) };
          if (!['cancelled', 'expired', 'failed', 'completed', 'needs_review'].includes(order.status)) {
            throw appErrorFromCode('REFUND_NOT_ALLOWED');
          }
          if (order.otp_count > 0 && order.status === 'completed') throw appErrorFromCode('REFUND_NOT_ALLOWED');
          if (!reason) throw appErrorFromCode('INVALID_INPUT');
          const refunded = refundOrderOnce(order, reason, adminId ? 'admin' : 'system', adminId);
          order.updated_at = nowIso();
          if (adminId) {
            auditRecord({ adminId, action: 'order.refund', targetType: 'order', targetId: orderId, reason, after: { amount: Number(order.total_price) } });
          }
          return { refunded, amount: Number(order.total_price), order: structuredClone(order) };
        });
      },

      async claimForSync(limit, leaseSeconds, worker) {
        const now = Date.now();
        const candidates = [...store.orders.values()]
          .filter((o) => ['pending', 'waiting', 'received', 'needs_review'].includes(o.status))
          .filter((o) => o.supplier_order_id)
          .filter((o) => new Date(o.next_sync_at || 0).getTime() <= now)
          .filter((o) => !o.sync_lease_until || new Date(o.sync_lease_until).getTime() < now)
          .sort((a, b) => String(a.next_sync_at).localeCompare(String(b.next_sync_at)))
          .slice(0, limit);
        for (const o of candidates) {
          o.sync_lease_until = new Date(now + leaseSeconds * 1000).toISOString();
          o.sync_owner = worker;
          o.sync_attempts += 1;
        }
        return candidates.map((o) => structuredClone(o));
      },

      async releaseLease(orderId, nextSyncAt, errorCode, errorMessage) {
        const o = store.orders.get(orderId);
        if (!o) return;
        o.sync_lease_until = null;
        o.next_sync_at = nextSyncAt || new Date(Date.now() + 30000).toISOString();
        if (errorCode) o.last_error_code = errorCode;
        if (errorMessage) o.last_error_message = String(errorMessage).slice(0, 500);
      },

      async flagOrphans(ageSeconds = 180) {
        const cutoff = Date.now() - ageSeconds * 1000;
        let count = 0;
        for (const o of store.orders.values()) {
          if (
            o.status === 'pending' && !o.supplier_order_id &&
            new Date(o.created_at).getTime() < cutoff &&
            (!o.sync_lease_until || new Date(o.sync_lease_until).getTime() < Date.now())
          ) {
            o.status = 'needs_review';
            o.last_error_code = 'ORPHAN_PENDING';
            o.last_error_message = 'Order tanpa referensi supplier; menunggu rekonsiliasi';
            o.next_sync_at = nowIso();
            o.updated_at = nowIso();
            addEvent(o.id, 'order_orphaned', 'pending', 'needs_review', 'system', 'Order pending tanpa referensi supplier ditandai needs_review');
            count += 1;
          }
        }
        return count;
      },

      async eventsFor(orderId, { limit = 30 } = {}) {
        const rows = store.orderEvents
          .filter((e) => e.order_id === orderId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((e) => structuredClone(e));
        return { rows };
      },
      async countActive(userId) {
        return [...store.orders.values()].filter(
          (o) => o.user_id === userId && ['pending', 'waiting', 'received'].includes(o.status)
        ).length;
      }
    },

    deposits: {
      async create(params) {
        const { userId, amount, proofPath, proofMime, proofSize, proofSha256, note, minAmount, maxAmount, maxPending = 3 } = params;
        if (!Number.isFinite(amount) || amount <= 0) throw appErrorFromCode('INVALID_AMOUNT');
        const effectiveMinimum = Math.max(MINIMUM_TOPUP_AMOUNT, Number(minAmount) || MINIMUM_TOPUP_AMOUNT);
        if (amount < effectiveMinimum) throw appErrorFromCode('DEPOSIT_BELOW_MINIMUM');
        if (amount > maxAmount) throw appErrorFromCode('DEPOSIT_ABOVE_MAXIMUM');
        if (!proofPath || !proofMime || !proofSize) throw appErrorFromCode('PROOF_REQUIRED');
        if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(proofMime)) {
          throw appErrorFromCode('PROOF_INVALID_TYPE');
        }
        if (proofSize <= 0 || proofSize > 5 * 1024 * 1024) throw appErrorFromCode('PROOF_TOO_LARGE');
        const pending = [...store.deposits.values()].filter((d) => d.user_id === userId && d.status === 'pending');
        if (pending.length >= maxPending) throw appErrorFromCode('TOO_MANY_PENDING_DEPOSITS');

        const row = {
          id: randomUUID(),
          user_id: userId,
          amount: round2(amount),
          approved_amount: null,
          status: 'pending',
          method: 'manual_transfer',
          unique_code: null,
          provider_reference: null,
          provider_order_id: null,
          checkout_url: null,
          qris_payload: null,
          pay_amount: null,
          fee_amount: 0,
          provider_status: null,
          expires_at: null,
          paid_at: null,
          proof_path: proofPath,
          proof_mime: proofMime,
          proof_size: proofSize,
          proof_sha256: proofSha256,
          user_note: note || null,
          admin_note: null,
          reviewed_by: null,
          reviewed_at: null,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        store.deposits.set(row.id, row);
        return { deposit: structuredClone(row) };
      },
      async createGateway(params) {
        const { userId, amount, reference, minAmount, maxAmount, maxPending = 3, expiresIn = 600 } = params;
        if (!Number.isSafeInteger(amount) || amount <= 0) throw appErrorFromCode('INVALID_AMOUNT');
        const effectiveMinimum = Math.max(MINIMUM_TOPUP_AMOUNT, Number(minAmount) || MINIMUM_TOPUP_AMOUNT);
        if (amount < effectiveMinimum) throw appErrorFromCode('DEPOSIT_BELOW_MINIMUM');
        if (amount > maxAmount || amount > 100_000_000) throw appErrorFromCode('DEPOSIT_ABOVE_MAXIMUM');
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(reference || ''))) throw appErrorFromCode('INVALID_INPUT');
        if (!Number.isInteger(expiresIn) || expiresIn < 300 || expiresIn > 600) throw appErrorFromCode('INVALID_INPUT');
        return withLock(`gateway-deposit-user:${userId}`, async () => {
          if ([...store.deposits.values()].some((d) => d.provider_reference === reference)) throw appErrorFromCode('PAYMENT_ORDER_MISMATCH');
          const pending = [...store.deposits.values()].filter((d) => d.user_id === userId && d.status === 'pending');
          if (pending.length >= maxPending) throw appErrorFromCode('TOO_MANY_PENDING_DEPOSITS');
          const createdAt = nowIso();
          const row = {
            id: randomUUID(), user_id: userId, amount, approved_amount: null,
            status: 'pending', method: 'gateway', unique_code: null,
            provider_reference: reference, provider_order_id: null, checkout_url: null,
            qris_payload: null, pay_amount: null, fee_amount: 0,
            provider_status: 'creating',
            expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(), paid_at: null,
            proof_path: null, proof_mime: null, proof_size: null, proof_sha256: null,
            user_note: null, admin_note: null, reviewed_by: null, reviewed_at: null,
            created_at: createdAt, updated_at: createdAt
          };
          store.deposits.set(row.id, row);
          return { deposit: structuredClone(row) };
        });
      },
      async storeGatewayInvoice(params) {
        const deposit = store.deposits.get(params.depositId);
        if (!deposit || deposit.method !== 'gateway' || deposit.provider_reference !== params.reference) {
          throw appErrorFromCode('PAYMENT_ORDER_MISMATCH');
        }
        return withLock(`gateway-deposit:${deposit.id}`, async () => {
          const current = store.deposits.get(deposit.id);
          if (!['pending', 'approved'].includes(current.status)) throw appErrorFromCode('DEPOSIT_ALREADY_REVIEWED');
          if (current.provider_order_id && current.provider_order_id !== params.providerOrderId) throw appErrorFromCode('PAYMENT_ORDER_MISMATCH');
          const conflict = [...store.deposits.values()].some((d) => d.id !== current.id && d.provider_order_id === params.providerOrderId);
          if (conflict || params.feeAmount !== 0 || !Number.isSafeInteger(params.payAmount)
              || params.payAmount < Number(current.amount)) {
            throw appErrorFromCode('PAYMENT_AMOUNT_MISMATCH');
          }
          Object.assign(current, {
            provider_order_id: params.providerOrderId,
            checkout_url: params.checkoutUrl,
            qris_payload: params.qris,
            pay_amount: params.payAmount,
            fee_amount: params.feeAmount,
            provider_status: 'pending',
            expires_at: params.expiresAt,
            updated_at: nowIso()
          });
          return { deposit: structuredClone(current) };
        });
      },
      async findGatewayByReference(reference) {
        const deposit = [...store.deposits.values()].find((d) => d.provider_reference === reference && d.method === 'gateway');
        return deposit ? structuredClone(deposit) : null;
      },
      async listPendingGateway({ limit = 10 } = {}) {
        const rows = [...store.deposits.values()]
          .filter((d) => d.method === 'gateway' && d.status === 'pending')
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .slice(0, limit)
          .map((d) => structuredClone(d));
        return { rows };
      },
      async confirmGatewayPayment(params) {
        if (!/^[a-f0-9]{64}$/.test(String(params.eventId || ''))
            || !['order.paid', 'reconciliation.paid'].includes(params.eventType)) throw appErrorFromCode('INVALID_INPUT');
        const existing = [...store.deposits.values()].find((d) => d.provider_reference === params.reference && d.method === 'gateway');
        if (!existing) throw appErrorFromCode('DEPOSIT_NOT_FOUND');
        return withLock(`gateway-deposit:${existing.id}`, async () => withLock(`wallet:${existing.user_id}`, async () => {
          const deposit = store.deposits.get(existing.id);
          if (store.paymentWebhookEvents.has(params.eventId)) return { duplicate: true, credited: false, deposit: structuredClone(deposit) };
          if (deposit.status === 'approved') {
            if (deposit.provider_order_id !== params.providerOrderId || Number(deposit.approved_amount) !== params.baseAmount) {
              throw appErrorFromCode('PAYMENT_ORDER_MISMATCH');
            }
            store.paymentWebhookEvents.set(params.eventId, { event_id: params.eventId, event_type: params.eventType, processed_at: nowIso() });
            return { duplicate: true, credited: false, deposit: structuredClone(deposit) };
          }
          if (deposit.status !== 'pending') throw appErrorFromCode('DEPOSIT_ALREADY_REVIEWED');
          const paidAtMs = Date.parse(params.paidAt);
          const expiresAtMs = Date.parse(deposit.expires_at || '');
          if (deposit.provider_order_id && deposit.provider_order_id !== params.providerOrderId
              || Number(deposit.amount) !== params.baseAmount
              || params.feeAmount !== 0
              || !Number.isSafeInteger(params.payAmount)
              || params.payAmount < params.baseAmount
              || (deposit.pay_amount !== null && Number(deposit.pay_amount) !== params.payAmount)
              || !Number.isFinite(paidAtMs)
              || (Number.isFinite(expiresAtMs) && paidAtMs > expiresAtMs)
              || paidAtMs > Date.now() + 5 * 60 * 1000) {
            throw appErrorFromCode('PAYMENT_AMOUNT_MISMATCH');
          }
          const ledger = ledgerApply(
            deposit.user_id, 'deposit', 'credit', params.baseAmount, 'deposit', deposit.id,
            'Deposit AstraPay terverifikasi', null,
            { provider: 'astrapay', provider_order_id: params.providerOrderId, reference: params.reference,
              base_amount: params.baseAmount, fee_amount: params.feeAmount, pay_amount: params.payAmount, paid_at: params.paidAt }
          );
          Object.assign(deposit, {
            status: 'approved', approved_amount: params.baseAmount, reviewed_by: null,
            reviewed_at: nowIso(), paid_at: params.paidAt, provider_order_id: params.providerOrderId,
            pay_amount: params.payAmount, fee_amount: params.feeAmount, provider_status: 'paid', updated_at: nowIso()
          });
          store.paymentWebhookEvents.set(params.eventId, {
            event_id: params.eventId, event_type: params.eventType,
            provider_order_id: params.providerOrderId, provider_reference: params.reference, processed_at: nowIso()
          });
          pushNotification({
            userId: deposit.user_id, type: 'deposit.approved', severity: 'success',
            title: 'Deposit disetujui',
            body: `Deposit Rp${new Intl.NumberFormat('id-ID').format(params.baseAmount)} sudah masuk ke saldo Anda.`,
            depositId: deposit.id, meta: { amount: params.baseAmount }
          });
          return { duplicate: false, credited: true, deposit: structuredClone(deposit), balance: ledger.balance_after };
        }));
      },
      async closeGatewayDeposit(depositId, providerStatus) {
        const deposit = store.deposits.get(depositId);
        if (!deposit || deposit.method !== 'gateway') throw appErrorFromCode('DEPOSIT_NOT_FOUND');
        if (!['expired', 'cancelled', 'canceled'].includes(providerStatus)) throw appErrorFromCode('INVALID_INPUT');
        return withLock(`gateway-deposit:${depositId}`, async () => {
          const current = store.deposits.get(depositId);
          if (current.status === 'pending') {
            Object.assign(current, { status: 'cancelled', provider_status: providerStatus, checkout_url: null, qris_payload: null, updated_at: nowIso() });
          }
          return { deposit: structuredClone(current) };
        });
      },
      async get(id) {
        const d = store.deposits.get(id);
        return d ? structuredClone(d) : null;
      },
      async listByUser(userId, { limit = 20, offset = 0 } = {}) {
        const rows = [...store.deposits.values()]
          .filter((d) => d.user_id === userId)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },
      async listPendingByUser(userId, { limit = 10 } = {}) {
        const rows = [...store.deposits.values()]
          .filter((d) => d.user_id === userId && d.status === 'pending')
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, limit)
          .map((d) => structuredClone(d));
        return { rows };
      },
      async adminList({ status = 'pending', limit = 30, offset = 0 } = {}) {
        let rows = [...store.deposits.values()];
        if (status) rows = rows.filter((d) => d.status === status);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return paginate(rows.map((r) => structuredClone(r)), { limit, offset });
      },
      async approve(id, adminId, amount, note) {
        assertAdmin(adminId);
        const deposit = store.deposits.get(id);
        if (!deposit) throw appErrorFromCode('DEPOSIT_NOT_FOUND');
        if (deposit.method === 'gateway') throw appErrorFromCode('PAYMENT_AUTO_REVIEW');
        if (deposit.status !== 'pending') throw appErrorFromCode('DEPOSIT_ALREADY_REVIEWED');
        const approved = amount ?? Number(deposit.amount);
        if (!Number.isFinite(approved) || approved <= 0 || approved > Number(deposit.amount)) {
          throw appErrorFromCode('INVALID_AMOUNT');
        }
        return withLock(`wallet:${deposit.user_id}`, () => {
          ledgerApply(deposit.user_id, 'deposit', 'credit', approved, 'deposit', deposit.id,
            'Deposit disetujui admin', adminId, { requested_amount: Number(deposit.amount) });
          deposit.status = 'approved';
          deposit.approved_amount = round2(approved);
          deposit.reviewed_by = adminId;
          deposit.reviewed_at = nowIso();
          deposit.admin_note = note || null;
          deposit.updated_at = nowIso();
          auditRecord({
            adminId, action: 'deposit.approve', targetType: 'deposit', targetId: id, reason: note,
            before: { status: 'pending' }, after: { status: 'approved', amount: approved }
          });
          pushNotification({
            userId: deposit.user_id,
            type: 'deposit.approved',
            severity: 'success',
            title: 'Deposit disetujui',
            body: `Deposit Rp${new Intl.NumberFormat('id-ID').format(deposit.approved_amount)} sudah masuk ke saldo Anda.`,
            depositId: deposit.id,
            meta: { amount: deposit.approved_amount }
          });
          return { deposit: structuredClone(deposit), balance: walletOf(deposit.user_id).balance };
        });
      },
      async reject(id, adminId, reason) {
        assertAdmin(adminId);
        if (!reason) throw appErrorFromCode('INVALID_INPUT');
        const deposit = store.deposits.get(id);
        if (!deposit) throw appErrorFromCode('DEPOSIT_NOT_FOUND');
        if (deposit.method === 'gateway') throw appErrorFromCode('PAYMENT_AUTO_REVIEW');
        if (deposit.status !== 'pending') throw appErrorFromCode('DEPOSIT_ALREADY_REVIEWED');
        deposit.status = 'rejected';
        deposit.reviewed_by = adminId;
        deposit.reviewed_at = nowIso();
        deposit.admin_note = reason;
        deposit.updated_at = nowIso();
        auditRecord({ adminId, action: 'deposit.reject', targetType: 'deposit', targetId: id, reason, before: { status: 'pending' }, after: { status: 'rejected' } });
        pushNotification({
          userId: deposit.user_id,
          type: 'deposit.rejected',
          severity: 'danger',
          title: 'Deposit ditolak',
          body: `Alasan: ${reason}. Ajukan deposit ulang dengan bukti transfer yang jelas.`,
          depositId: deposit.id,
          meta: { amount: Number(deposit.amount) }
        });
        return { deposit: structuredClone(deposit), balance: null };
      }
    },

    audit: {
      async log(entry) {
        return auditRecord(entry);
      },
      async list({ limit = 50, offset = 0 } = {}) {
        return paginate(store.auditLogs.map((r) => structuredClone(r)), { limit, offset });
      }
    },

    /**
     * Email verification contexts (in-memory mirror of migration 007).
     * The cooldown logic must be identical to the SQL function, otherwise the
     * demo path and the production path would disagree about resend behaviour.
     */
    verifyContexts: {
      async issue({ userId, tokenHash, email, ttlSeconds = 1800, ip = null, userAgent = null }) {
        for (const [key, row] of store.verifyContexts) {
          if (row.user_id === userId && !row.consumed_at) {
            store.verifyContexts.set(key, { ...row, consumed_at: nowIso() });
          }
        }
        const row = {
          token_hash: tokenHash,
          user_id: userId,
          email: String(email).toLowerCase(),
          issued_at: nowIso(),
          expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          last_sent_at: null,
          resend_count: 0,
          resend_window: nowIso(),
          email_sent: false,
          email_error: null,
          consumed_at: null,
          created_ip: ip,
          user_agent: userAgent ? String(userAgent).slice(0, 400) : null
        };
        store.verifyContexts.set(tokenHash, row);
        return { ok: true, user_id: userId, email: row.email, expires_at: row.expires_at, issued_at: row.issued_at };
      },
      async read(tokenHash) {
        const row = store.verifyContexts.get(tokenHash);
        if (!row) return { ok: false, reason: 'NOT_FOUND' };
        const profile = store.profiles.get(row.user_id);
        const expired = new Date(row.expires_at).getTime() <= Date.now();
        return {
          ok: true,
          user_id: row.user_id,
          email: row.email,
          active: !row.consumed_at && !expired,
          expired,
          consumed: Boolean(row.consumed_at),
          expires_at: row.expires_at,
          last_sent_at: row.last_sent_at,
          email_sent: row.email_sent,
          email_error: row.email_error,
          resend_count: row.resend_count,
          already_verified: Boolean(profile?.email_verified_at)
        };
      },
      async markDelivery(tokenHash, sent, error = null) {
        const row = store.verifyContexts.get(tokenHash);
        if (!row) return { ok: false };
        store.verifyContexts.set(tokenHash, {
          ...row, last_sent_at: nowIso(), email_sent: Boolean(sent), email_error: error
        });
        return { ok: true };
      },
      async claimResend(tokenHash, { cooldownSeconds = 60, maxPerHour = 5 } = {}) {
        const row = store.verifyContexts.get(tokenHash);
        if (!row) return { ok: false, reason: 'NOT_FOUND' };
        if (row.consumed_at) return { ok: false, reason: 'CONTEXT_EXPIRED' };
        if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'CONTEXT_EXPIRED' };
        const now = Date.now();
        const windowStart = new Date(row.resend_window).getTime();
        if (row.resend_count >= maxPerHour && windowStart > now - 3600_000) {
          return { ok: false, reason: 'RESEND_LIMIT', retry_after: Math.max(1, Math.ceil((windowStart + 3600_000 - now) / 1000)) };
        }
        if (row.last_sent_at) {
          const elapsed = (now - new Date(row.last_sent_at).getTime()) / 1000;
          if (elapsed < cooldownSeconds) {
            return { ok: false, reason: 'COOLDOWN', retry_after: Math.max(1, Math.ceil(cooldownSeconds - elapsed)) };
          }
        }
        const withinWindow = windowStart > now - 3600_000;
        store.verifyContexts.set(tokenHash, {
          ...row,
          last_sent_at: nowIso(),
          resend_count: withinWindow ? row.resend_count + 1 : 1,
          resend_window: withinWindow ? row.resend_window : nowIso()
        });
        return { ok: true, resend_count: withinWindow ? row.resend_count + 1 : 1 };
      },
      async consume(tokenHash) {
        const row = store.verifyContexts.get(tokenHash);
        if (!row || row.consumed_at) return { ok: false };
        store.verifyContexts.set(tokenHash, { ...row, consumed_at: nowIso() });
        return { ok: true };
      }
    },

    sessions: {
      async create(row) {
        const session = {
          id: randomUUID(),
          user_id: row.user_id,
          token_hash: row.token_hash,
          csrf_hash: row.csrf_hash,
          refresh_token_enc: row.refresh_token_enc,
          access_token_enc: row.access_token_enc || null,
          access_expires_at: row.access_expires_at || null,
          ip: row.ip || null,
          user_agent: row.user_agent || null,
          created_at: nowIso(),
          last_used_at: nowIso(),
          expires_at: row.expires_at,
          revoked_at: null
        };
        store.sessions.set(session.id, session);
        return structuredClone(session);
      },
      async byTokenHash(hash) {
        const found = [...store.sessions.values()].find((s) => s.token_hash === hash);
        return found ? structuredClone(found) : null;
      },
      async update(id, patch) {
        const session = store.sessions.get(id);
        if (!session) return null;
        Object.assign(session, patch);
        return structuredClone(session);
      },
      async revoke(id) {
        const session = store.sessions.get(id);
        if (session) session.revoked_at = nowIso();
      },
      async revokeAllForUser(userId) {
        for (const s of store.sessions.values()) {
          if (s.user_id === userId) s.revoked_at = nowIso();
        }
      },
      async listForUser(userId, { limit = 50 } = {}) {
        const rows = [...store.sessions.values()]
          .filter((s) => s.user_id === userId && !s.revoked_at)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, limit);
        return { rows: rows.map((r) => structuredClone(r)) };
      },
      async deleteExpired() {
        for (const [id, s] of store.sessions) {
          if (new Date(s.expires_at).getTime() < Date.now()) store.sessions.delete(id);
        }
      }
    },

    rateLimit: {
      async hit(key, limit, windowSeconds) {
        const now = Date.now();
        let bucket = store.rateLimits.get(key);
        if (!bucket || now - bucket.start >= windowSeconds * 1000) {
          bucket = { start: now, count: 0 };
          store.rateLimits.set(key, bucket);
        }
        bucket.count += 1;
        return {
          allowed: bucket.count <= limit,
          limit,
          remaining: Math.max(0, limit - bucket.count),
          count: bucket.count,
          resetAt: bucket.start + windowSeconds * 1000
        };
      }
    },

    notifications: {
      async listByUser(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
        const mine = store.notifications
          .filter((n) => n.user_id === userId)
          .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1));
        const filtered = unreadOnly ? mine.filter((n) => !n.read_at) : mine;
        return {
          rows: structuredClone(filtered.slice(offset, offset + limit)),
          total: mine.length,
          unread: mine.filter((n) => !n.read_at).length,
          offset,
          limit
        };
      },

      async unreadCount(userId) {
        return store.notifications.filter((n) => n.user_id === userId && !n.read_at).length;
      },

      async markRead(userId, ids = null) {
        const now = nowIso();
        let changed = 0;
        for (const row of store.notifications) {
          if (row.user_id !== userId || row.read_at) continue;
          if (Array.isArray(ids) && !ids.includes(row.id)) continue;
          row.read_at = now;
          changed += 1;
        }
        return changed;
      },

      async create(params) {
        return structuredClone(pushNotification(params));
      }
    },

    jobs: {
      async acquire(name, owner, leaseSeconds) {
        const existing = store.leases.get(name);
        const now = Date.now();
        if (existing && new Date(existing.locked_until).getTime() > now && existing.owner !== owner) return false;
        store.leases.set(name, {
          name,
          owner,
          locked_until: new Date(now + leaseSeconds * 1000).toISOString(),
          heartbeat_at: nowIso()
        });
        return true;
      },
      async release(name, owner) {
        const existing = store.leases.get(name);
        if (existing && existing.owner === owner) {
          existing.locked_until = new Date(0).toISOString();
        }
      }
    },

    // Same contract as the pg driver (public.cron_locks, migration 003).
    cron: {
      async claim(name, owner, ttlSeconds) {
        const row = store.cronLocks.get(name) || {
          name, owner: null, locked_until: null, last_run_at: null,
          last_owner: null, last_status: null, last_result: null, run_count: 0
        };
        const now = Date.now();
        const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
        if (lockedUntil > now && row.owner !== owner) {
          return { claimed: false, reason: 'LOCKED', owner: row.owner, locked_until: row.locked_until, run_count: row.run_count };
        }
        row.owner = owner;
        row.locked_until = new Date(now + ttlSeconds * 1000).toISOString();
        store.cronLocks.set(name, row);
        return { claimed: true, reason: 'ACQUIRED', owner, locked_until: row.locked_until, run_count: row.run_count };
      },
      async release(name, owner, status = 'success', result = null) {
        const row = store.cronLocks.get(name);
        if (!row) return { released: false, reason: 'NOT_FOUND' };
        if (row.owner !== owner) return { released: false, reason: 'NOT_OWNER', last_run_at: row.last_run_at };
        row.owner = null;
        row.locked_until = null;
        row.last_run_at = nowIso();
        row.last_owner = owner;
        row.last_status = status;
        row.last_result = result;
        row.run_count += 1;
        return { released: true, last_run_at: row.last_run_at, run_count: row.run_count };
      },
      async heartbeat(name, owner, ttlSeconds) {
        const row = store.cronLocks.get(name);
        if (!row || row.owner !== owner) return false;
        row.locked_until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        return true;
      },
      async status() {
        return [...store.cronLocks.values()].map((row) => ({ ...row }));
      }
    },

    webhooks: {
      async record(deliveryId, eventType, payload) {
        if (store.webhooks.has(deliveryId)) return { inserted: false };
        const row = { id: store.webhooks.size + 1, delivery_id: deliveryId, event_type: eventType, payload, received_at: nowIso(), processed_at: null };
        store.webhooks.set(deliveryId, row);
        return { inserted: true, id: row.id };
      },
      async markProcessed(deliveryId, error = null) {
        const row = store.webhooks.get(deliveryId);
        if (row) {
          row.processed_at = nowIso();
          row.error = error;
        }
      }
    },

    async publicSummary() {
      const active = [...store.services.values()].filter((s) => s.is_active);
      const countries = new Set(active.map((s) => s.country_id));
      const apps = new Set(active.map((s) => s.provider_app_id));
      const lastSync = active.reduce((acc, s) => {
        const t = s.price_synced_at ? new Date(s.price_synced_at).getTime() : 0;
        return t > acc ? t : acc;
      }, 0);
      return {
        active_services: active.length,
        countries: countries.size,
        apps: apps.size,
        last_catalog_sync: lastSync ? new Date(lastSync).toISOString() : null,
        generated_at: nowIso()
      };
    },

    async dashboard(adminId) {
      assertAdmin(adminId);
      const orders = [...store.orders.values()];
      const completed = orders.filter((o) => o.status === 'completed');
      const profiles = [...store.profiles.values()];
      const pendingDeposits = [...store.deposits.values()].filter((d) => d.status === 'pending');
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      return {
        generated_at: nowIso(),
        users: {
          total: profiles.length,
          active: profiles.filter((p) => p.status === 'active').length,
          suspended: profiles.filter((p) => p.status !== 'active').length,
          admins: profiles.filter((p) => p.role === 'admin').length
        },
        orders: {
          total: orders.length,
          today: orders.filter((o) => new Date(o.created_at) >= todayStart).length,
          active: orders.filter((o) => ['pending', 'waiting', 'received'].includes(o.status)).length,
          completed: completed.length,
          refunded: orders.filter((o) => o.refunded_at).length,
          needs_review: orders.filter((o) => o.status === 'needs_review').length
        },
        finance: {
          gross_revenue: completed.reduce((s, o) => s + Number(o.total_price), 0),
          supplier_cost: completed.reduce((s, o) => s + Number(o.supplier_price), 0),
          net_profit: completed.reduce((s, o) => s + Number(o.total_price) - Number(o.supplier_price), 0),
          refunded_total: store.transactions.filter((t) => t.type === 'refund').reduce((s, t) => s + Number(t.amount), 0),
          deposits_approved: [...store.deposits.values()].filter((d) => d.status === 'approved').reduce((s, d) => s + Number(d.approved_amount || 0), 0),
          deposits_pending_count: pendingDeposits.length,
          deposits_pending_amount: pendingDeposits.reduce((s, d) => s + Number(d.amount), 0),
          wallet_liability: [...store.wallets.values()].reduce((s, w) => s + Number(w.balance), 0)
        },
        recent_orders: orders
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 10)
          .map((o) => ({
            id: o.id,
            status: o.status,
            total_price: Number(o.total_price),
            created_at: o.created_at,
            email: store.profiles.get(o.user_id)?.email || ''
          }))
      };
    },

    async close() {
      logger?.debug?.('memory database released');
    }
  };

  /** Test/preview helper: create a user directly (bypasses the auth provider). */
  db._insertUser = ({ id = randomUUID(), email, username = null, role = 'user', balance = 0 }) => {
    const profile = {
      id,
      email: String(email).toLowerCase(),
      username,
      full_name: null,
      phone: null,
      role,
      status: 'active',
      email_verified_at: nowIso(),
      password_auth_enabled: false,
      last_seen_at: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    store.profiles.set(id, profile);
    const wallet = walletOf(id);
    if (balance > 0) {
      const reference = randomUUID();
      ledgerApply(id, 'adjustment', 'credit', balance, 'adjustment', reference, 'Saldo awal demo');
    }
    return { profile, wallet: structuredClone(wallet) };
  };

  db._hash = (value) => createHash('sha256').update(value).digest('hex');

  return db;
}
