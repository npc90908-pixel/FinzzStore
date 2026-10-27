// ============================================================================
// ORDER SERVICE
//
// The only place where money and supplier purchases meet. Invariants:
//   * the wallet is debited BEFORE the supplier is called, by a single atomic
//     RPC that also stores the idempotency key;
//   * the supplier idempotency key is the internal order id, so every retry
//     (poller, reconciliation, manual sync, process restart) is provably the
//     same purchase and can never create a second one;
//   * a failed purchase is refunded exactly once, only when the supplier gave a
//     definitive answer — a timeout or an unknown status never refunds;
//   * OTPs are attached to the order row and only serialised for the owner or
//     an admin; nothing is cached in memory.
// ============================================================================
import { createHash } from 'node:crypto';
import { fromDbAmount, formatRupiah } from './money.js';
import { AppError, errors } from './errors.js';
import { mapSupplierStatus, isDefinitive, publicSupplierMessage } from './supplier-error.js';

const ACTIVE = ['pending', 'waiting', 'received'];
const TERMINAL = ['completed', 'cancelled', 'expired', 'failed'];

const ZERO = 0;

export function createOrderService({ db, supplier, settings, catalog, logger, config }) {
  const log = logger.child ? logger.child({ module: 'orders' }) : logger;

  // --------------------------------------------------------------- helpers --
  const operations = () => settings.get('operations');
  const refundPolicy = () => settings.get('refund_policy');

  const requestHashFor = (payload) =>
    createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  /** Deterministic retry delay for ambiguous outcomes (timeout, 5xx, pending). */
  const backoffSeconds = (attempts) => Math.min(300, 20 * Math.max(1, attempts));

  const assertSalesOpen = (ops) => {
    if (ops && ops.sales_open === false) {
      throw new AppError({
        code: 'SALES_CLOSED',
        status: 503,
        message: ops.maintenance_message || 'Penjualan sedang ditutup sementara.',
        expose: true
      });
    }
  };

  const requireSupplier = () => {
    if (!supplier.isConfigured) {
      throw new AppError({
        code: 'SUPPLIER_NOT_CONFIGURED',
        status: 503,
        expose: true,
        message: 'Sumber nomor belum dikonfigurasi. Hubungi admin.'
      });
    }
  };

  /** Supplier DTO -> columns understood by both database drivers. */
  const supplierFields = (so) => ({
    status: mapSupplierStatus(so.status) || 'waiting',
    phoneNumber: so.number || null,
    otps: Array.isArray(so.otps) ? so.otps : [],
    canCancel: Boolean(so.canCancel),
    cancelAvailableAt: so.cancelAvailableAt || null,
    expiresAt: so.expiresAt || null
  });

  // ------------------------------------------------------------------- DTOs --
  function toPublic(order, { includeOtp = false, includeSupplier = false } = {}) {
    if (!order) return null;
    const otps = includeOtp && order.otp_code
      ? [{
          code: order.otp_code,
          message: order.otp_message,
          sender: order.otp_sender,
          receivedAt: order.otp_received_at
        }]
      : [];

    return {
      id: order.id,
      status: order.status,
      serviceId: order.service_id,
      app: order.provider_app_id
        ? { id: order.provider_app_id, name: order.provider_app_name || order.provider_app_id }
        : null,
      country: order.provider_country_id || order.provider_country_name
        ? {
            id: order.provider_country_id,
            name: order.provider_country_name,
            iso: order.provider_country_iso
          }
        : null,
      server: order.provider_server || null,
      number: includeOtp ? order.phone_number : maskNumber(order.phone_number),
      numberAvailable: Boolean(order.phone_number),
      otpCount: order.otp_count || ZERO,
      otps,
      // Convenience mirror of the newest OTP; null until one arrives.
      otp: otps[0] || null,
      canCancel: Boolean(order.can_cancel) && !order.cancel_requested_at && ACTIVE.includes(order.status) && (order.otp_count || 0) === 0,
      cancelRequestedAt: order.cancel_requested_at,
      cancelAvailableAt: order.cancel_available_at,
      expiresAt: order.expires_at,
      completedAt: order.completed_at,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      lastSyncedAt: order.last_synced_at,
      nextSyncAt: order.next_sync_at,
      refundedAt: order.refunded_at,
      /**
       * Freshness contract (TeleKos integration is NOT yet contract-verified):
       *   verified  — the last status came from a confirmed supplier response
       *               (successful create/get/cancel or a signature-valid webhook)
       *   stale     — no supplier confirmation yet, or the last sync failed
       *   lastSyncedAt is the ONLY claim the UI may make; never "real-time".
       */
      /**
       * `providerPending` — money is committed and the supplier has not
       * confirmed yet. This is the state the master contract calls
       * `provider_pending`: never shown as success, never refunded on a timer.
       */
      providerPending: order.status === 'pending' && (Boolean(order.supplier_order_id) || (order.sync_attempts || 0) > 0),
      statusFreshness: {
        verified: Boolean(order.last_synced_at) && !order.last_error_code,
        stale: !order.last_synced_at || Boolean(order.last_error_code),
        lastSyncedAt: order.last_synced_at,
        lastSyncError: order.last_error_code || null,
        polling: order.status === 'pending' || order.status === 'waiting'
      },
      error: order.last_error_code
        ? { code: order.last_error_code, message: publicSupplierMessage(order.last_error_code, order.last_error_message) }
        : null,
      // Supplier references stay admin-only: they are credentials-adjacent and
      // never useful to a buyer.
      supplier: includeSupplier
        ? {
            mode: order.provider,
            orderId: order.supplier_order_id,
            offerId: order.provider_offer_id,
            attempts: order.sync_attempts,
            lastError: order.last_error_code
          }
        : undefined,
      pricing: {
        supplierPrice: fromDbAmount(order.supplier_price),
        markup: fromDbAmount(order.markup_amount),
        tax: fromDbAmount(order.tax_amount),
        total: fromDbAmount(order.total_price),
        currency: order.currency || 'IDR',
        totalFormatted: formatRupiah(fromDbAmount(order.total_price))
      }
    };
  }

  function maskNumber(number) {
    if (!number) return null;
    const str = String(number);
    if (str.length <= 4) return str;
    // Keep the shape readable but hide most digits: +6281•••••432
    return `${str.slice(0, 4)}${'•'.repeat(Math.max(3, str.length - 7))}${str.slice(-3)}`;
  }

  function toEvent(row) {
    return {
      id: row.id,
      status: row.status,
      previousStatus: row.previous_status,
      source: row.source,
      message: row.message,
      createdAt: row.created_at,
      actorId: row.actor_id || null
    };
  }

  // ------------------------------------------------------------------- read --
  async function getRow({ user, orderId }) {
    const order = user.role === 'admin'
      ? await db.orders.get(orderId)
      : await db.orders.getForUser(orderId, user.id);
    if (!order) throw errors.notFound('Order');
    return order;
  }

  /** Route-facing read: always returns the public DTO of an owned order. */
  async function get({ user, orderId }) {
    const order = await getRow({ user, orderId });
    return toPublic(order, { includeOtp: true });
  }

  async function detail({ user, orderId }) {
    const order = await getRow({ user, orderId });
    const events = await db.orders.eventsFor(order.id, { limit: 30 });
    return {
      order: toPublic(order, { includeOtp: true }),
      events: events.map(toEvent),
      pollHintMs: 0
    };
  }

  async function list({ user, status = null, page = 1, perPage = 12 }) {
    const { rows, total } = await db.orders.listByUser(user.id, {
      status,
      limit: perPage,
      offset: (Math.max(1, page) - 1) * perPage
    });
    return {
      orders: rows.map((o) => toPublic(o, { includeOtp: true })),
      pagination: {
        page,
        perPage,
        total,
        pages: Math.max(1, Math.ceil(total / perPage))
      }
    };
  }

  async function active({ user }) {
    const rows = await db.orders.listActive(user.id);
    return rows.map((o) => toPublic(o, { includeOtp: true }));
  }

  // ----------------------------------------------------------------- create --
  /**
   * Place an order. Idempotent: the client must send a stable key.
   * Returns { order, balance, replayed, notice }.
   */
  async function create({ user, serviceId = null, offer = null, expectedPrice = null, idempotencyKey, ip = null, userAgent = null }) {
    const ops = await operations();
    assertSalesOpen(ops);
    requireSupplier();

    const service = serviceId ? await db.services.get(serviceId) : null;
    if (serviceId && (!service || !service.is_active)) throw errors.notFound('Layanan');
    if (!serviceId && !offer) throw new AppError('INVALID_OFFER', 'Konteks penawaran tidak valid.', 422);

    // Prices are always recomputed server-side; the client never sends money.
    // Dynamic offers are refreshed from the documented TeleKos /prices route.
    const quote = offer
      ? await catalog.quoteOffer(offer)
      : await catalog.quote({ serviceId: service.id, refresh: true });
    if (!quote.live) {
      // Mock/offline pricing is fine for the demo, but a live deployment must
      // never charge a stale price when the supplier cannot confirm stock.
      if (!supplier.isMock && !config.demoMode) {
        throw new AppError(
          'QUOTE_UNAVAILABLE',
          'Harga tidak dapat diverifikasi saat ini. Coba lagi sebentar.',
          503
        );
      }
    }
    if (!quote.offerId && !supplier.isMock) {
      throw new AppError('OFFER_UNAVAILABLE', 'Nomor sedang tidak tersedia.', 503);
    }

    // The quote is the authoritative snapshot: it was produced server-side by
    // the pricing engine moments ago. Re-verify its arithmetic here so a stale
    // or tampered quote object can never change the amount charged, and mirror
    // the same invariant the database enforces on insert.
    const supplierPrice = fromDbAmount(quote.supplierPrice);
    const markupAmount = fromDbAmount(quote.price?.markupAmount ?? 0);
    const taxAmount = fromDbAmount(quote.price?.taxAmount ?? 0);
    const totalPrice = fromDbAmount(quote.price?.totalPrice ?? supplierPrice + markupAmount + taxAmount);
    if (totalPrice !== supplierPrice + markupAmount + taxAmount || totalPrice <= 0) {
      throw new AppError(
        'PRICE_MISMATCH',
        'Harga tidak konsisten. Silakan ulangi pemesanan.',
        503
      );
    }
    if (expectedPrice !== null && totalPrice !== expectedPrice) {
      throw new AppError('PRICE_CHANGED', 'Harga berubah sejak penawaran ditampilkan. Muat ulang harga dan tinjau sebelum membeli.', 409);
    }

    const requestHash = requestHashFor({
      serviceId: service?.id || null,
      offer: offer ? {
        server: offer.server,
        app: offer.app,
        country: offer.country,
        offerId: offer.offerId
      } : null,
      supplierPrice,
      markupAmount,
      taxAmount,
      totalPrice,
      offerId: quote.offerId || null
    });

    const created = await db.orders.create({
      userId: user.id,
      serviceId: service?.id || null,
      idempotencyKey,
      requestHash,
      supplierPrice,
      markupAmount,
      taxAmount,
      totalPrice,
      provider: supplier.mode,
      providerServer: quote.server || service?.provider_server || null,
      providerAppId: quote.appId || service?.provider_app_id,
      providerAppName: quote.appName || service?.app_name || service?.provider_app_name || service?.provider_app_id,
      countryId: quote.countryId ?? service?.country_id,
      countryName: quote.countryName || service?.country_name,
      countryIso: quote.countryIso || service?.country_iso || null,
      providerOfferId: quote.offerId || null,
      maxActiveOrders: Number(ops.max_active_orders ?? 5),
      actor: { ip, userAgent }
    });

    if (!created.replayed && created.order?.id) {
      // Audit trail: remember *why* this price was chosen, not just the amount.
      await db.orders.setPricingSnapshot(created.order.id, {
        markupBps: quote.markupBps,
        rule: quote.price?.rule ?? null,
        adjustments: quote.price?.adjustments ?? [],
        taxLabel: quote.price?.taxLabel ?? null,
        quotedAt: quote.quotedAt ?? null,
        offerKey: quote.offerKey ?? null,
        live: Boolean(quote.live),
        engine: 'resolvePrice/v1',
        snapshotAt: new Date().toISOString()
      }).catch(() => {});
    }

    if (created.replayed) {
      log.info('order create replayed', { orderId: created.order.id });
      return {
        order: toPublic(created.order, { includeOtp: true }),
        balance: fromDbAmount(created.balance),
        replayed: true,
        pending: ACTIVE.includes(created.order.status) && created.order.status !== 'waiting',
        notice: null
      };
    }

    return purchase({ order: created.order, balance: created.balance });
  }

  /**
   * Talk to the supplier for an order that is still `pending` (no supplier id
   * yet). Shared by create(), the poller and the reconciliation job.
   */
  async function purchase({ order, balance = null }) {
    const idempotencyKey = order.id;

    let result;
    try {
      result = await supplier.createOrder({
        offerId: order.provider_offer_id,
        idempotencyKey
      });
    } catch (err) {
      return handlePurchaseError({ order, err });
    }

    const so = result.order;
    const fields = supplierFields(so);
    const attached = await db.orders.attach({
      orderId: order.id,
      supplierOrderId: so.id,
      status: fields.status === 'pending' ? 'waiting' : fields.status,
      phoneNumber: fields.phoneNumber,
      expiresAt: fields.expiresAt,
      canCancel: fields.canCancel,
      cancelAvailableAt: fields.cancelAvailableAt
    });

    let finalOrder = attached.order;
    if (fields.otps.length || fields.status === 'completed') {
      finalOrder = await applySupplierState({ orderId: order.id, so, source: 'supplier' });
    }

    log.info('order purchased', {
      orderId: order.id,
      supplierOrderId: so.id,
      status: finalOrder.status
    });

    return {
      order: toPublic(finalOrder, { includeOtp: true }),
      balance: balance === null ? null : fromDbAmount(balance),
      replayed: false,
      pending: finalOrder.status === 'pending',
      notice: null
    };
  }

  async function handlePurchaseError({ order, err }) {
    const definitive = isDefinitive(err);
    const code = err.code || 'SUPPLIER_ERROR';
    const message = publicSupplierMessage(code, err.message);

    if (definitive) {
      // The supplier refused the purchase: give the money back exactly once.
      const failed = await db.orders.fail({
        orderId: order.id,
        errorCode: code,
        message: err.message || message,
        refund: true,
        source: 'supplier'
      });
      log.warn('purchase rejected by supplier, refunded', {
        orderId: order.id,
        code,
        refunded: failed.refunded
      });
      return {
        order: toPublic(failed.order, { includeOtp: true }),
        balance: failed.order ? fromDbAmount((await db.wallets.get(order.user_id))?.balance ?? 0) : null,
        replayed: false,
        pending: false,
        notice: {
          code,
          message: failed.refunded
            ? `Pembelian gagal: ${message}. Saldo sudah dikembalikan.`
            : `Pembelian gagal: ${message}.`,
          // OFFER_EXPIRED / INVALID_OFFER / OUT_OF_STOCK are definitive: no
          // order exists at the supplier, so the UI must fetch a fresh offer
          // (new price and offer id) instead of retrying with the old one.
          refetchOffer: ['OFFER_EXPIRED', 'INVALID_OFFER', 'OUT_OF_STOCK'].includes(code),
          retryable: ['OFFER_EXPIRED', 'INVALID_OFFER', 'OUT_OF_STOCK', 'RATE_LIMITED'].includes(code)
        }
      };
    }

    // Unknown outcome: keep the order pending and retry with the same key.
    const delay = backoffSeconds(order.sync_attempts + 1);
    await db.orders.releaseLease(order.id, new Date(Date.now() + delay * 1000).toISOString(), code, err.message || message);
    log.warn('purchase outcome unknown, will retry', { orderId: order.id, code, retryInSeconds: delay });

    const refreshed = await db.orders.get(order.id);
    return {
      order: toPublic(refreshed, { includeOtp: true }),
      balance: null,
      replayed: false,
      pending: true,
      notice: {
        type: 'pending_confirmation',
        code: 'PENDING_CONFIRMATION',
        message: 'Pembelian sedang dikonfirmasi supplier. Saldo sudah terpotong dan status akan diperbarui otomatis.'
      }
    };
  }

  // ------------------------------------------------------------------- sync --
  /** Apply a supplier order document to the local row. */
  async function applySupplierState({ orderId, so, source = 'poll' }) {
    const fields = supplierFields(so);
    let status = fields.status;
    // `pending` only exists before the supplier id is attached.
    if (!status || status === 'pending') status = 'waiting';

    const result = await db.orders.applyState({
      orderId,
      status,
      phoneNumber: fields.phoneNumber,
      otps: fields.otps,
      canCancel: fields.canCancel,
      cancelAvailableAt: fields.cancelAvailableAt,
      expiresAt: fields.expiresAt,
      source,
      errorCode: null,
      message: null
    });

    if (result.refunded) {
      log.info('order refunded after supplier status', { orderId, status });
    }
    return result.order;
  }

  /**
   * Poll one order. Safe to call from the browser (rate-limited) and from the
   * background job; the database lease prevents two workers syncing at once.
   */
  async function syncOrder(orderOrId, { worker = 'api' } = {}) {
    const order = typeof orderOrId === 'string' ? await db.orders.get(orderOrId) : orderOrId;
    if (!order) throw errors.notFound('Order');
    const source = String(worker).startsWith('user') ? 'user' : 'poll';
    if (TERMINAL.includes(order.status)) {
      return { order: toPublic(order, { includeOtp: true }), changed: false, terminal: true };
    }

    if (!order.supplier_order_id) {
      // Never got a supplier reference: retry the exact same purchase.
      const resumed = await purchase({ order });
      return { order: resumed.order, changed: true, terminal: TERMINAL.includes(resumed.order.status), notice: resumed.notice };
    }

    let so;
    try {
      so = await supplier.getOrder(order.supplier_order_id);
    } catch (err) {
      if (err.code === 'ORDER_NOT_FOUND') {
        // The supplier lost the order. Do NOT refund blindly: a human decides.
        await db.orders.applyState({
          orderId: order.id,
          status: 'needs_review',
          source: 'poll',
          errorCode: 'SUPPLIER_ORDER_LOST',
          message: 'Order tidak ditemukan di supplier'
        }).catch(() => {});
        throw new AppError({
          code: 'ORDER_NEEDS_REVIEW',
          status: 409,
          expose: true,
          message: 'Status order perlu ditinjau admin.'
        });
      }
      const delay = backoffSeconds(order.sync_attempts + 1);
      await db.orders.releaseLease(order.id, new Date(Date.now() + delay * 1000).toISOString(), err.code || 'SYNC_FAILED', err.message);
      log.warn('order sync failed', { orderId: order.id, code: err.code, retryInSeconds: delay });
      throw new AppError({
        code: 'SYNC_UNAVAILABLE',
        status: 503,
        expose: true,
        message: 'Status supplier belum dapat diperiksa. Coba lagi sebentar.'
      });
    }

    let updated;
    try {
      updated = await applySupplierState({ orderId: order.id, so, source });
    } catch (err) {
      if (err.code === 'INVALID_TRANSITION') {
        log.warn('supplier reported an unexpected transition', {
          orderId: order.id,
          local: order.status,
          supplier: so.status
        });
        await db.orders.applyState({
          orderId: order.id,
          status: 'needs_review',
          source: 'poll',
          errorCode: 'STATUS_CONFLICT',
          message: `Supplier melaporkan ${so.status} saat order lokal ${order.status}`
        }).catch(() => {});
      } else {
        throw err;
      }
    }

    // Close the session as soon as the OTP arrived so it stops expiring.
    if (updated?.status === 'received' && (await operations()).auto_finish !== false) {
      updated = await finish({ orderId: order.id, so }) || updated;
    }

    return {
      order: toPublic(updated || (await db.orders.get(order.id)), { includeOtp: true }),
      changed: Boolean(updated),
      terminal: TERMINAL.includes(updated?.status)
    };
  }

  async function finish({ orderId, so = null }) {
    const order = await db.orders.get(orderId);
    if (!order?.supplier_order_id) return null;
    try {
      await supplier.finishOrder(order.supplier_order_id);
    } catch (err) {
      // Finishing is best effort; the OTP is already stored locally.
      log.warn('supplier finish failed', { orderId, code: err.code });
      return null;
    }
    const result = await db.orders.applyState({
      orderId,
      status: 'completed',
      otps: so?.otps || [],
      source: 'system',
      message: 'Masa aktif nomor ditutup setelah OTP diterima'
    }).catch((err) => {
      if (err.code === 'INVALID_TRANSITION') return null;
      throw err;
    });
    return result?.order || null;
  }

  // ----------------------------------------------------------------- cancel --
  async function cancel({ user, orderId }) {
    const policy = await refundPolicy().catch(() => ({}));
    if (policy.allow_user_cancel === false) {
      throw new AppError({ code: 'CANCEL_NOT_AVAILABLE', status: 409, expose: true, message: 'Pembatalan oleh pengguna sedang dinonaktifkan.' });
    }

    const begun = await db.orders.beginCancel(orderId, user.id);
    if (begun.already_requested) {
      return { order: toPublic(begun.order, { includeOtp: true }), pending: true, notice: null };
    }

    if (!begun.order.supplier_order_id) {
      // Supplier was never reached: cancel locally and refund.
      const failed = await db.orders.fail({
        orderId,
        errorCode: 'CANCELLED_BY_USER',
        message: 'Dibatalkan oleh pengguna',
        refund: true,
        source: 'user'
      });
      return { order: toPublic(failed.order, { includeOtp: true }), pending: false, notice: null };
    }

    let result;
    try {
      result = await supplier.cancelOrder(begun.order.supplier_order_id);
    } catch (err) {
      if (err.code === 'CANCEL_NOT_AVAILABLE') {
        await db.orders.releaseCancel(orderId, err.message);
        throw new AppError({
          code: 'CANCEL_NOT_AVAILABLE',
          status: 409,
          expose: true,
          message: 'Order sudah tidak dapat dibatalkan.'
        });
      }
      if (isDefinitive(err) && ['ORDER_NOT_FOUND', 'ALREADY_TERMINAL'].includes(err.code)) {
        // Ask the poller to refresh instead of guessing an outcome.
        await db.orders.releaseCancel(orderId, err.message);
        throw new AppError({ code: 'CANCEL_NOT_AVAILABLE', status: 409, expose: true, message: 'Order tidak dapat dibatalkan.' });
      }
      const delay = backoffSeconds(begun.order.sync_attempts + 1);
      await db.orders.releaseLease(orderId, new Date(Date.now() + delay * 1000).toISOString(), err.code || 'CANCEL_FAILED', err.message);
      log.warn('cancel outcome unknown', { orderId, code: err.code });
      return {
        order: toPublic(begun.order, { includeOtp: true }),
        pending: true,
        notice: { code: 'PENDING_CONFIRMATION', message: 'Permintaan pembatalan sedang diproses supplier.' }
      };
    }

    const fields = supplierFields(result.order);
    const updated = await db.orders.applyState({
      orderId,
      status: fields.status === 'cancelled' ? 'cancelled' : fields.status,
      otps: fields.otps,
      canCancel: false,
      source: 'user',
      message: 'Dibatalkan oleh pengguna'
    }).catch(async (err) => {
      if (err.code === 'INVALID_TRANSITION') {
        // Supplier says cancelled but we already moved on: refresh next tick.
        await db.orders.releaseLease(orderId, new Date(Date.now() + 15000).toISOString(), 'CANCEL_CONFLICT', err.message);
        return { order: await db.orders.get(orderId) };
      }
      throw err;
    });
    return {
      order: toPublic(updated.order, { includeOtp: true }),
      pending: false,
      refunded: Boolean(updated.refunded),
      notice: null
    };
  }

  /**
   * Reconciliation entry point: bring an order that was left mid-flight back to
   * a known state. Ambiguous `pending` rows are retried with the SAME supplier
   * idempotency key; rows that already carry a supplier id are re-synced.
   */
  async function resumePending(orderOrId, { worker = 'reconciliation' } = {}) {
    const order = typeof orderOrId === 'string' ? await db.orders.get(orderOrId) : orderOrId;
    if (!order) throw errors.notFound('Order');
    if (TERMINAL.includes(order.status)) return { reconciled: false, terminal: true, order: toPublic(order, { includeOtp: true }) };

    if (order.supplier_order_id) {
      const result = await syncOrder(order, { worker });
      return { reconciled: true, resumed: 'sync', ...result };
    }
    const resumed = await purchase({ order });
    return { reconciled: true, resumed: 'purchase', order: resumed.order, pending: resumed.pending, notice: resumed.notice };
  }

  // ------------------------------------------------------------- admin side --
  async function adminRefund({ order, admin, reason, ip, userAgent }) {
    const result = await db.orders.refund(order.id, reason, admin.id);
    await db.audit.log({
      admin_id: admin.id,
      action: 'order.refund',
      target_type: 'order',
      target_id: order.id,
      reason,
      ip: ip || null,
      user_agent: userAgent || null,
      after: { refunded: result.refunded, amount: fromDbAmount(order.total_price) }
    });
    return {
      order: toPublic(result.order, { includeOtp: true }),
      refunded: result.refunded,
      reason: result.reason || null
    };
  }

  async function adminList({ status = null, search = '', page = 1, perPage = 20 }) {
    const { rows, total } = await db.orders.adminList({
      status,
      search,
      limit: perPage,
      offset: (Math.max(1, page) - 1) * perPage
    });
    return {
      orders: rows.map((o) => ({ ...toPublic(o, { includeOtp: true }), userId: o.user_id })),
      pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) }
    };
  }

  async function countActive(userId) {
    return db.orders.countActive(userId);
  }

  return {
    toPublic,
    toEvent,
    detail,
    get,
    getRow,
    list,
    active,
    create,
    purchase,
    syncOrder,
    resumePending,
    cancel,
    adminList,
    adminRefund,
    countActive,
    ACTIVE,
    TERMINAL
  };
}
