// ============================================================================
// ADMIN ROUTES — every handler re-checks the role on the server. The UI hiding
// a menu is never treated as authorisation.
// ============================================================================
import { randomUUID } from 'node:crypto';
import * as v from '../validation.js';
import { errors } from '../errors.js';
import { ValidationError } from '../validation.js';
import { parsePage, enforceLimit, ok, accepted, adminMeta } from './helpers.js';
import { fromDbAmount, resolvePrice, describePricing } from '../money.js';

const SETTING_VALIDATORS = {
  store_profile: (value) => ({
    name: v.string(value.name, { field: 'name', min: 2, max: 60 }),
    tagline: v.string(value.tagline ?? '', { field: 'tagline', max: 120, optional: true }) || '',
    support_email: value.support_email ? v.email(value.support_email, { field: 'support_email' }) : '',
    support_whatsapp: v.string(value.support_whatsapp ?? '', { field: 'support_whatsapp', max: 30, optional: true }) || '',
    support_telegram: v.string(value.support_telegram ?? '', { field: 'support_telegram', max: 60, optional: true }) || ''
  }),
  deposit_policy: (value) => {
    const min = v.money(value.min_amount, { field: 'min_amount', min: 1000, max: 100_000_000 });
    const max = v.money(value.max_amount, { field: 'max_amount', min: min, max: 1_000_000_000 });
    const accounts = v.arrayOf(value.bank_accounts ?? [], { field: 'bank_accounts', max: 5 });
    return {
      min_amount: min,
      max_amount: max,
      instructions: v.string(value.instructions ?? '', { field: 'instructions', max: 1000, optional: true }) || '',
      bank_accounts: accounts.map((acc, i) => ({
        bank_name: v.string(acc?.bank_name ?? '', { field: `bank_accounts[${i}].bank_name`, max: 40, optional: true }) || '',
        account_number: v.string(acc?.account_number ?? '', { field: `bank_accounts[${i}].account_number`, max: 40, optional: true }) || '',
        account_holder: v.string(acc?.account_holder ?? '', { field: `bank_accounts[${i}].account_holder`, max: 60, optional: true }) || ''
      })),
      expiry_hours: v.integer(value.expiry_hours ?? 24, { field: 'expiry_hours', min: 1, max: 168 })
    };
  },
  pricing_policy: (value) => {
    const rounding = value.rounding && typeof value.rounding === 'object' ? value.rounding : {};
    const categoryBps = {};
    if (value.category_bps && typeof value.category_bps === 'object' && !Array.isArray(value.category_bps)) {
      const entries = Object.entries(value.category_bps);
      if (entries.length > 50) {
        throw new ValidationError('category_bps', 'maksimal 50 kategori');
      }
      for (const [key, bps] of entries) {
        const clean = v.string(String(key), { field: 'category_bps', max: 40 });
        categoryBps[clean] = v.integer(bps, { field: `category_bps.${clean}`, min: 0, max: 10000 });
      }
    }
    return {
      default_markup_bps: v.integer(value.default_markup_bps, { field: 'default_markup_bps', min: 0, max: 10000 }),
      fixed_markup: v.integer(value.fixed_markup ?? 0, { field: 'fixed_markup', min: 0, max: 1_000_000_000 }),
      min_margin: v.integer(value.min_margin ?? 0, { field: 'min_margin', min: 0, max: 1_000_000_000 }),
      tax_bps: v.integer(value.tax_bps ?? 0, { field: 'tax_bps', min: 0, max: 10000 }),
      tax_label: v.string(value.tax_label ?? 'PPN', { field: 'tax_label', max: 20, optional: true }) || 'PPN',
      rounding: {
        mode: v.enumOf(rounding.mode ?? 'none', { field: 'rounding.mode', values: ['none', 'nearest', 'up', 'down'] }),
        step: v.integer(rounding.step ?? 1, { field: 'rounding.step', min: 1, max: 100000 })
      },
      category_bps: categoryBps
    };
  },
  operations: (value) => ({
    sales_open: v.boolean(value.sales_open, { field: 'sales_open', fallback: true }),
    maintenance_message: v.string(value.maintenance_message ?? '', { field: 'maintenance_message', max: 300, optional: true }) || '',
    order_poll_interval_ms: v.integer(value.order_poll_interval_ms ?? 4000, { field: 'order_poll_interval_ms', min: 2000, max: 60000 }),
    server_poll_interval_ms: v.integer(value.server_poll_interval_ms ?? 15000, { field: 'server_poll_interval_ms', min: 5000, max: 300000 }),
    order_expiry_seconds: v.integer(value.order_expiry_seconds ?? 1260, { field: 'order_expiry_seconds', min: 60, max: 7200 }),
    max_active_orders_per_user: v.integer(value.max_active_orders_per_user ?? 5, { field: 'max_active_orders_per_user', min: 1, max: 20 })
  }),
  refund_policy: (value) => ({
    summary: v.string(value.summary ?? '', { field: 'summary', max: 2000, optional: true }) || ''
  }),
  legal: (value) => ({
    terms_version: v.string(value.terms_version ?? '2026-10-01', { field: 'terms_version', max: 20 }),
    privacy_version: v.string(value.privacy_version ?? '2026-10-01', { field: 'privacy_version', max: 20 })
  }),
  supplier: (value) => ({
    provider: v.enumOf(value.provider ?? 'telekos', { field: 'provider', values: ['telekos'] }),
    server: v.string(value.server ?? 'server1', { field: 'server', max: 32, pattern: /^[a-z0-9_-]+$/ }),
    app_allowlist: v.arrayOf(value.app_allowlist ?? [], { field: 'app_allowlist', max: 40, optional: true })
      .map((id) => v.string(String(id), { field: 'app_allowlist', max: 16 })),
    sync_enabled: v.boolean(value.sync_enabled, { field: 'sync_enabled', fallback: true })
  })
};

export function registerAdminRoutes({ router }) {
  const admin = async (ctx) => ctx.requireAdmin();
  // Cache 60 detik untuk probe supplier (saldo jarang berubah, TeleKos punya rate limit).
  let supplierSnapshot = null;

  const audit = async (ctx, session, entry) =>
    ctx.db.audit.log({
      adminId: session.user.id,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    });

  // ---------------------------------------------------------------- overview
  router.get('/api/admin/dashboard', async (ctx) => {
    const session = await admin(ctx);
    const [dashboard, catalogStatus] = await Promise.all([
      ctx.db.dashboard(session.user.id),
      Promise.resolve(ctx.services.catalog.status)
    ]);
    return ok({
      ...dashboard,
      supplier: {
        ...ctx.services.supplier.status(),
        // Saldo tidak diambil di sini (bisa lambat). Ambil lewat
        // GET /api/admin/supplier yang punya cache dan diagnosa sendiri.
        balanceEndpoint: '/api/admin/supplier'
      },
      catalog: catalogStatus,
      jobs: ctx.services.jobs
        ? { poller: ctx.services.jobs.poller.stats, reconciliation: ctx.services.jobs.reconciliation.stats }
        : null,
      // Scheduled jobs run from an external scheduler (cron-job.org / Vercel
      // Cron) and coordinate through public.cron_locks. Without this the admin
      // has no way to tell "the schedule stopped firing" from "nothing to do".
      cron: await ctx.db.cron.status().catch(() => []),
      payment: ctx.services.payment.status()
    });
  });

  // ------------------------------------------------------- supplier (TeleKos)
  //
  // GET /api/admin/supplier — "apakah integrasi TeleKos benar-benar bekerja?"
  //
  // Ini satu-satunya tempat saldo supplier bisa dibaca. Sebelumnya adapter
  // punya getBalance() tetapi tidak pernah dipanggil dari mana pun, sehingga
  // saldo supplier tidak pernah muncul di dashboard.
  //
  // Aturan yang dipegang di sini:
  //   · kegagalan TIDAK pernah menjadi 500 dan tidak pernah dikarang angkanya;
  //   · kode error TeleKos diteruskan apa adanya (INVALID_API_KEY,
  //     INSUFFICIENT_BALANCE, MAINTENANCE, …) supaya env bisa didiagnosis;
  //   · hasil sukses di-cache 60 detik agar dashboard tidak membanjiri supplier;
  //   · `contractVerified` tetap false selama kontrak resmi belum dikonfirmasi.
  router.get('/api/admin/supplier', async (ctx) => {
    await admin(ctx);
    const supplier = ctx.services.supplier;

    if (!supplier.isConfigured) {
      return ok({
        available: false,
        mode: supplier.mode,
        contractVerified: false,
        reason: 'SUPPLIER_NOT_CONFIGURED',
        hint: 'SUPPLIER_MODE=live dan TELEKOS_API_KEY harus diset di environment.',
        balance: null,
        currency: null,
        servers: null,
        checkedAt: new Date().toISOString()
      });
    }

    const now = Date.now();
    const fresh = supplierSnapshot && now - supplierSnapshot.at < 60_000;
    if (fresh) return ok({ ...supplierSnapshot.value, cached: true });

    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ __timeout: true }), 8000);
      if (t.unref) t.unref();
    });

    const probe = async () => {
      const [balance, servers] = await Promise.allSettled([
        supplier.getBalance(),
        supplier.getServers()
      ]);
      return { balance, servers };
    };

    const result = await Promise.race([probe(), timeout]);

    if (result?.__timeout) {
      const value = {
        available: false,
        mode: supplier.mode,
        contractVerified: false,
        reason: 'SUPPLIER_TIMEOUT',
        hint: 'Supplier tidak menjawab dalam 8 detik. Coba lagi.',
        balance: null,
        currency: null,
        servers: null,
        checkedAt: new Date().toISOString()
      };
      return ok({ ...value, cached: false });
    }

    const balanceOk = result.balance.status === 'fulfilled';
    const serversOk = result.servers.status === 'fulfilled';
    const failure = !balanceOk ? result.balance.reason : (!serversOk ? result.servers.reason : null);

    const value = {
      available: balanceOk,
      mode: supplier.mode,
      contractVerified: false,
      // Saldo nyata — null kalau gagal, tidak pernah angka karangan.
      balance: balanceOk ? result.balance.value.balance : null,
      currency: balanceOk ? result.balance.value.currency : null,
      updatedAt: balanceOk ? result.balance.value.updatedAt : null,
      servers: serversOk
        ? {
            total: result.servers.value.length,
            available: result.servers.value.filter((s) => s.available).length,
            maintenance: result.servers.value.filter((s) => s.maintenance).length
          }
        : null,
      error: failure
        ? {
            code: failure.code || 'SUPPLIER_ERROR',
            message: failure.message || 'Supplier menolak permintaan.',
            httpStatus: failure.httpStatus ?? null,
            retryable: Boolean(failure.retryable),
            // Panduan langsung: kode ini yang membedakan kunci salah vs saldo habis.
            hint: failure.code === 'INVALID_API_KEY'
              ? 'TELEKOS_API_KEY ditolak supplier. Periksa nilainya di Vercel, lalu redeploy.'
              : failure.code === 'INSUFFICIENT_BALANCE'
                ? 'Saldo akun TeleKos habis. Isi saldo di dashboard TeleKos.'
                : failure.code === 'MAINTENANCE'
                  ? 'Supplier sedang maintenance. Pembelian baru diblokir sementara.'
                  : null
          }
        : null,
      checkedAt: new Date().toISOString()
    };

    if (balanceOk || serversOk) {
      supplierSnapshot = { at: now, value };
    }
    return ok({ ...value, cached: false });
  });

  router.get('/api/admin/catalog/status', async (ctx) => {
    await admin(ctx);
    return ok(ctx.services.catalog.status);
  });

  router.post('/api/admin/catalog/sync', async (ctx) => {
    const session = await admin(ctx);
    await enforceLimit(ctx, `admin:sync:${session.user.id}`, 4, 60, { critical: true });
    const startedAt = new Date().toISOString();
    ctx.services.catalog.sync({ trigger: 'admin' }).catch(() => {});
    await audit(ctx, session, {
      action: 'catalog.sync', targetType: 'catalog', targetId: null, reason: 'Manual catalogue refresh'
    });
    return accepted({ started: true, startedAt, message: 'Sinkronisasi katalog berjalan di latar belakang.' });
  });

  // ------------------------------------------------------------------- users
  router.get('/api/admin/users', async (ctx) => {
    await admin(ctx);
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 20 });
    const search = (ctx.query.get('search') || '').slice(0, 80);
    const role = ctx.query.get('role');
    const status = ctx.query.get('status');
    const { rows, total } = await ctx.db.profiles.list({
      search,
      role: role === 'admin' || role === 'user' ? role : null,
      status: ['active', 'suspended', 'banned'].includes(status) ? status : null,
      limit: perPage,
      offset: (page - 1) * perPage
    });
    const enriched = [];
    for (const profile of rows) {
      const wallet = await ctx.db.wallets.get(profile.id);
      enriched.push({
        id: profile.id,
        email: profile.email,
        username: profile.username,
        fullName: profile.full_name,
        role: profile.role,
        status: profile.status,
        balance: fromDbAmount(wallet?.balance ?? 0),
        createdAt: profile.created_at,
        lastSeenAt: profile.last_seen_at
      });
    }
    return ok({ users: enriched, pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) } });
  });

  router.patch('/api/admin/users/:id/role', async (ctx) => {
    const session = await admin(ctx);
    const userId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const role = v.enumOf(body.role, { field: 'role', values: ['user', 'admin'] });
    const result = await ctx.db.profiles.setRole(userId, session.user.id, role, adminMeta(ctx));
    await audit(ctx, session, {
      action: 'user.role_change', targetType: 'profile', targetId: userId,
      before: null, after: { role }
    });
    return ok({ message: `Role diubah menjadi ${role}.`, profile: { id: result.profile.id, role: result.profile.role } });
  });

  router.patch('/api/admin/users/:id/status', async (ctx) => {
    const session = await admin(ctx);
    const userId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const status = v.enumOf(body.status, { field: 'status', values: ['active', 'suspended', 'banned'] });
    const reason = v.string(body.reason ?? '', { field: 'reason', max: 300, optional: true });
    if (status !== 'active' && !reason) throw errors.badRequest('Alasan wajib diisi saat menonaktifkan akun.', 'REASON_REQUIRED');

    const result = await ctx.db.profiles.setStatus(userId, session.user.id, status, reason, adminMeta(ctx));
    if (status !== 'active') await ctx.db.sessions.revokeAllForUser(userId).catch(() => {});
    await audit(ctx, session, {
      action: 'user.status_change', targetType: 'profile', targetId: userId, reason, after: { status }
    });
    return ok({ message: `Status akun diubah menjadi ${status}.`, profile: { id: result.profile.id, status: result.profile.status } });
  });

  router.post('/api/admin/users/:id/wallet', async (ctx) => {
    const session = await admin(ctx);
    const userId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const direction = v.enumOf(body.direction, { field: 'direction', values: ['credit', 'debit'] });
    const amount = v.money(body.amount, { field: 'amount', min: 1 });
    const reason = v.string(body.reason, { field: 'reason', min: 5, max: 300 });
    const reference = body.reference ? v.uuid(body.reference, { field: 'reference' }) : randomUUID();

    const result = await ctx.db.wallets.adjust(userId, session.user.id, {
      direction, amount, reason, reference, ...adminMeta(ctx)
    });
    await audit(ctx, session, {
      action: 'wallet.adjustment', targetType: 'wallet', targetId: userId, reason,
      after: { direction, amount, reference }
    });
    return ok({ message: 'Saldo disesuaikan dan tercatat pada audit log.', ...result });
  });

  // ---------------------------------------------------------------- services
  router.get('/api/admin/services', async (ctx) => {
    await admin(ctx);
    const { rows, total } = await ctx.db.services.listAll({ limit: 300, offset: 0 });
    const lastSync = await ctx.db.services.lastSyncAt();
    return ok({
      services: rows.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        appName: s.app_name,
        countryName: s.country_name,
        server: s.provider_server,
        supplierPrice: fromDbAmount(s.supplier_price),
        price: fromDbAmount(s.price),
        markupBps: s.markup_bps,
        stock: s.stock,
        active: s.is_active,
        syncedAt: s.price_synced_at
      })),
      total,
      lastSync: lastSync
        ? { startedAt: lastSync.started_at, status: lastSync.status, upserted: lastSync.services_upserted, error: lastSync.error }
        : null
    });
  });

  router.patch('/api/admin/services/:id', async (ctx) => {
    const session = await admin(ctx);
    const serviceId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const before = await ctx.db.services.get(serviceId);
    if (!before) throw errors.notFound('Layanan');

    const patch = {};
    if (body.active !== undefined) patch.is_active = v.boolean(body.active, { field: 'active' });
    if (body.markup_bps !== undefined) patch.markup_bps = v.integer(body.markup_bps, { field: 'markup_bps', min: 0, max: 10000 });
    if (body.price !== undefined) patch.price = v.money(body.price, { field: 'price', min: 1 });
    if (body.sort_order !== undefined) patch.sort_order = v.integer(body.sort_order, { field: 'sort_order', min: 0, max: 10000 });
    if (body.name !== undefined) patch.name = v.string(body.name, { field: 'name', min: 2, max: 80 });
    if (Object.keys(patch).length === 0) throw errors.badRequest('Tidak ada perubahan.', 'EMPTY_PATCH');

    const updated = await ctx.db.services.update(serviceId, patch);
    await audit(ctx, session, {
      action: 'service.update', targetType: 'service', targetId: serviceId, reason: null,
      before: { price: fromDbAmount(before.price), active: before.is_active, markup: before.markup_bps },
      after: patch
    });
    return ok({ message: 'Layanan diperbarui.', service: { id: updated.id, price: fromDbAmount(updated.price), active: updated.is_active } });
  });

  // ---------------------------------------------------------------- deposits
  router.get('/api/admin/deposits', async (ctx) => {
    await admin(ctx);
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 20 });
    const status = ctx.query.get('status') || 'pending';
    const result = await ctx.services.deposits.listForAdmin({ status, page, perPage });
    return ok(result);
  });

  router.get('/api/admin/deposits/:id/proof', async (ctx) => {
    await admin(ctx);
    const depositId = v.uuid(ctx.params.id, { field: 'id' });
    const deposit = await ctx.services.deposits.getForAdmin(depositId);
    const proof = await ctx.services.deposits.readProof(deposit);
    ctx.res.writeHead(200, {
      'Content-Type': proof.mime,
      'Content-Length': proof.size,
      'Content-Disposition': `inline; filename="bukti-${depositId.slice(0, 8)}"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    });
    ctx.res.end(proof.buffer);
  });

  router.post('/api/admin/deposits/:id/approve', async (ctx) => {
    const session = await admin(ctx);
    const depositId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const amount = body.approved_amount === undefined || body.approved_amount === null || body.approved_amount === ''
      ? null
      : v.money(body.approved_amount, { field: 'approved_amount', min: 1 });
    const note = v.string(body.note ?? '', { field: 'note', max: 300, optional: true });

    const result = await ctx.services.deposits.approve({
      depositId, adminId: session.user.id, amount, note, ...adminMeta(ctx)
    });
    await audit(ctx, session, {
      action: 'deposit.approve', targetType: 'deposit', targetId: depositId, reason: note,
      after: { amount: result.deposit.approvedAmount, balance: result.balance }
    });
    return ok({ message: 'Deposit disetujui dan saldo dikreditkan.', ...result });
  });

  router.post('/api/admin/deposits/:id/reject', async (ctx) => {
    const session = await admin(ctx);
    const depositId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const reason = v.string(body.reason, { field: 'reason', min: 5, max: 300 });
    const result = await ctx.services.deposits.reject({
      depositId, adminId: session.user.id, reason, ...adminMeta(ctx)
    });
    await audit(ctx, session, {
      action: 'deposit.reject', targetType: 'deposit', targetId: depositId, reason
    });
    return ok({ message: 'Deposit ditolak.', ...result });
  });

  // ------------------------------------------------------------------ orders
  router.get('/api/admin/orders', async (ctx) => {
    await admin(ctx);
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 25 });
    const status = ctx.query.get('status');
    const search = (ctx.query.get('search') || '').slice(0, 80);
    const { rows, total } = await ctx.db.orders.adminList({
      status: status && status !== 'all' ? status : null,
      search,
      limit: perPage,
      offset: (page - 1) * perPage
    });
    const orders = [];
    for (const order of rows) {
      const profile = await ctx.db.profiles.get(order.user_id);
      orders.push({
        ...ctx.services.orders.toPublic(order, { includeOtp: false, includeSupplier: true }),
        user: profile ? { id: profile.id, email: profile.email } : null
      });
    }
    return ok({ orders, pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) } });
  });

  router.get('/api/admin/orders/:id', async (ctx) => {
    const session = await admin(ctx);
    const order = await ctx.db.orders.get(v.uuid(ctx.params.id, { field: 'id' }));
    if (!order) throw errors.notFound('Order');
    const profile = await ctx.db.profiles.get(order.user_id);
    const { rows } = (await ctx.db.orders.eventsFor(order.id, { limit: 40 })) ?? { rows: [] };
    return ok({
      order: ctx.services.orders.toPublic(order, { includeOtp: true, includeSupplier: true }),
      user: profile ? { id: profile.id, email: profile.email } : null,
      events: rows,
      requestedBy: session.profile.email
    });
  });

  router.post('/api/admin/orders/:id/refund', async (ctx) => {
    const session = await admin(ctx);
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const reason = v.string(body.reason, { field: 'reason', min: 5, max: 300 });
    const result = await ctx.db.orders.refund(orderId, reason, session.user.id);
    await audit(ctx, session, {
      action: 'order.refund', targetType: 'order', targetId: orderId, reason,
      after: { refunded: result.refunded, amount: result.amount ?? null }
    });
    return ok({ message: result.refunded ? 'Refund berhasil dicatat.' : 'Order ini sudah pernah di-refund.', ...result });
  });

  router.post('/api/admin/orders/:id/sync', async (ctx) => {
    const session = await admin(ctx);
    const orderId = v.uuid(ctx.params.id, { field: 'id' });
    await enforceLimit(ctx, `admin:ordersync:${session.user.id}`, 60, 60);
    const order = await ctx.db.orders.get(orderId);
    if (!order) throw errors.notFound('Order');
    await ctx.services.orders.syncOrder(order, { worker: `admin-${session.user.id.slice(0, 8)}` });
    const fresh = await ctx.db.orders.get(orderId);
    return ok({ order: ctx.services.orders.toPublic(fresh, { includeOtp: true, includeSupplier: true }) });
  });

  // ------------------------------------------------------------------- audit
  router.get('/api/admin/audit', async (ctx) => {
    await admin(ctx);
    const { page, perPage } = parsePage(ctx.query, { defaultPerPage: 30 });
    const { rows, total } = await ctx.db.audit.list({ limit: perPage, offset: (page - 1) * perPage });
    const entries = [];
    for (const row of rows) {
      const profile = await ctx.db.profiles.get(row.admin_id);
      entries.push({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        reason: row.reason,
        before: row.before,
        after: row.after,
        ip: row.ip,
        admin: profile ? { id: profile.id, email: profile.email } : null,
        createdAt: row.created_at
      });
    }
    return ok({ entries, pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) } });
  });

  // ---------------------------------------------------------------- settings
  router.get('/api/admin/settings', async (ctx) => {
    await admin(ctx);
    const all = await ctx.services.settings.getAll();
    return ok({ settings: all, payment: ctx.services.payment.status() });
  });

  router.patch('/api/admin/settings/:key', async (ctx) => {
    const session = await admin(ctx);
    const key = v.enumOf(ctx.params.key, { field: 'key', values: Object.keys(SETTING_VALIDATORS) });
    const body = await ctx.readJson({ limit: 32 * 1024 });
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
      throw errors.badRequest('Field value harus berupa objek.', 'INVALID_SETTING');
    }

    const current = await ctx.services.settings.get(key);
    const merged = { ...current, ...body.value };
    const validated = SETTING_VALIDATORS[key](merged);
    const saved = await ctx.services.settings.update(key, validated, session.user.id);

    await audit(ctx, session, {
      action: 'settings.update', targetType: 'settings', targetId: key, reason: null,
      before: current, after: validated
    });
    return ok({ message: 'Pengaturan disimpan.', key, value: saved.value });
  });

  // ---------------------------------------------------- pricing simulator
  // Lets an admin see exactly what a customer would pay for a given supplier
  // price before saving a policy. Read-only: it never writes anything.
  router.post('/api/admin/pricing/preview', async (ctx) => {
    await admin(ctx);
    const body = await ctx.readJson({ limit: 8 * 1024 });
    const supplierPrice = fromDbAmount(
      v.integer(body.supplier_price, { field: 'supplier_price', min: 0, max: 1_000_000_000 })
    );
    const category = body.category
      ? v.string(body.category, { field: 'category', max: 40, optional: true })
      : null;
    const serviceMarkupBps = body.service_markup_bps === undefined || body.service_markup_bps === null
      ? null
      : v.integer(body.service_markup_bps, { field: 'service_markup_bps', min: 0, max: 10000 });

    const policy = body.policy && typeof body.policy === 'object'
      ? SETTING_VALIDATORS.pricing_policy(body.policy)
      : await ctx.services.settings.get('pricing_policy');

    const result = resolvePrice({ supplierPrice, policy, serviceMarkupBps, category });
    return ok({
      input: { supplierPrice, category, serviceMarkupBps },
      result: {
        ...result,
        marginPercent: result.supplierPrice > 0
          ? Math.round((result.markupAmount / result.supplierPrice) * 10000) / 100
          : null
      },
      explanation: describePricing(policy)
    });
  });
}
