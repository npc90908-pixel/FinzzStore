// ============================================================================
// SUPPLIER WEBHOOK — TELEKOS.ID signs `timestamp.raw_body` with HMAC-SHA256.
// Header: X-Telekos-Signature: t=unix,v1=hex   Delivery: X-Telekos-Delivery
//
// Rules enforced here:
//   * the signature is verified over the UNMODIFIED raw body, constant time;
//   * a delivery id is stored once (supplier_webhook_events) so replays are no-ops;
//   * state transitions still go through rpc_apply_supplier_state (refund rules).
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readRaw } from '../http.js';
import { AppError } from '../errors.js';
import { mapSupplierStatus } from '../supplier-error.js';
import { ok } from './helpers.js';

const TOLERANCE_SECONDS = 300;

function verifySignature({ secret, header, rawBody }) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(header || ''));
  if (!match) return false;
  const [, timestamp, signature] = match;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerWebhookRoutes({ router, config, logger }) {
  router.post(
    '/api/webhooks/telekos',
    async (ctx) => {
      const secret = config.supplier.webhookSecret;
      if (!secret) {
        throw new AppError('WEBHOOK_NOT_CONFIGURED', 'Webhook belum dikonfigurasi.', 503);
      }

      const raw = await readRaw(ctx.req, { limit: 256 * 1024 });
      const rawText = raw.toString('utf8');

      if (!verifySignature({ secret, header: ctx.req.headers['x-telekos-signature'], rawBody: rawText })) {
        logger.warn('webhook signature rejected', { ip: ctx.ip });
        throw new AppError('INVALID_SIGNATURE', 'Signature webhook tidak valid.', 401);
      }

      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new AppError('INVALID_JSON', 'Body webhook tidak valid.', 400);
      }

      const deliveryId = String(ctx.req.headers['x-telekos-delivery'] || payload.id || '').slice(0, 120);
      if (!deliveryId) throw new AppError('MISSING_DELIVERY_ID', 'Delivery id wajib ada.', 400);

      const recorded = await ctx.db.webhooks.record(deliveryId, String(payload.type || 'unknown'), payload);
      if (!recorded.inserted) {
        return ok({ received: true, duplicate: true });
      }

      try {
        const remote = payload?.data?.order;
        const order = remote?.id ? await ctx.db.orders.findBySupplierId(String(remote.id)) : null;
        if (!order) {
          logger.warn('webhook for unknown order', { deliveryId, supplierOrderId: remote?.id });
          await ctx.db.webhooks.markProcessed(deliveryId, 'ORDER_NOT_FOUND');
          // The order row may not have committed yet when the provider webhook
          // races the checkout transaction. Return non-2xx so TeleKos retries;
          // record() can reclaim this failed delivery on that retry.
          throw new AppError('WEBHOOK_ORDER_PENDING', 'Order belum tersinkronisasi; webhook perlu dicoba ulang.', 503);
        }

        const mapped = mapSupplierStatus(remote.status);
        if (mapped) {
          await ctx.db.orders.applyState({
            orderId: order.id,
            status: mapped,
            phoneNumber: remote.number || null,
            otps: Array.isArray(remote.otps) ? remote.otps : [],
            canCancel: Boolean(remote.can_cancel),
            cancelAvailableAt: remote.cancel_available_at || null,
            expiresAt: remote.expires_at || null,
            source: 'webhook',
            message: `Webhook ${payload.type}`
          });
        }
        await ctx.db.webhooks.markProcessed(deliveryId, null);
        logger.info('webhook processed', { deliveryId, type: payload.type, orderId: order.id });
        return ok({ received: true, matched: true });
      } catch (err) {
        // Keep failed deliveries retryable. markProcessed(error) stores the
        // diagnostic without setting processed_at; record() may reclaim that
        // failed delivery on a later signed retry. Marking it processed here
        // would make every provider retry a no-op and permanently lose the OTP.
        await ctx.db.webhooks.markProcessed(deliveryId, String(err.message).slice(0, 300)).catch(() => {});
        logger.error('webhook processing failed', { deliveryId, error: err.message });
        throw new AppError('WEBHOOK_PROCESSING_FAILED', 'Webhook gagal diproses.', 500);
      }
    },
    { public: true }
  );
}
