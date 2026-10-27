// ============================================================================
// ASTRAPAY WEBHOOK
//
// A callback is only a signal to verify. Signature, timestamp, merchant
// reference, and a fresh server-to-server GET must all agree before the atomic
// database RPC can credit the wallet. Redirects and browser status checks are
// never accepted here.
// ============================================================================
import { createHash } from 'node:crypto';
import { readRaw } from '../http.js';
import { AppError } from '../errors.js';
import { fromDbAmount } from '../money.js';
import { ok } from './helpers.js';

function safeString(value, max = 120) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

export function registerPaymentWebhookRoutes({ router, services, logger }) {
  router.post('/api/webhooks/astrapay', async (ctx) => {
    const payment = services.payment;
    if (!payment.configured) {
      throw new AppError('PAYMENT_GATEWAY_DISABLED', payment.disabledMessage || 'Pembayaran otomatis belum aktif.', 503);
    }

    const rawBody = await readRaw(ctx.req, { limit: 256 * 1024 });
    const timestamp = String(ctx.req.headers['x-pg2-timestamp'] || '');
    const signature = String(ctx.req.headers['x-pg2-signature'] || '');
    if (!payment.verifyWebhook({ rawBody, timestamp, signature })) {
      logger.warn('AstraPay webhook signature rejected', { ip: ctx.ip });
      throw new AppError('INVALID_SIGNATURE', 'Signature webhook AstraPay tidak valid.', 401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError('INVALID_JSON', 'Body webhook AstraPay tidak valid.', 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('INVALID_JSON', 'Body webhook AstraPay tidak valid.', 400);
    }

    if (payload.event !== 'order.paid') {
      return ok({ received: true, ignored: true });
    }
    const event = payload.data;
    const providerOrderId = safeString(event?.id);
    const reference = safeString(event?.reference, 100);
    if (!providerOrderId || !reference || String(event?.status || '').toLowerCase() !== 'paid') {
      throw new AppError('INVALID_PAYMENT_EVENT', 'Data event pembayaran AstraPay tidak lengkap.', 400);
    }

    const deposit = await ctx.db.deposits.findGatewayByReference(reference);
    if (!deposit) {
      logger.warn('AstraPay webhook reference not found', { reference });
      return ok({ received: true, matched: false });
    }

    // Never trust the webhook's paid status alone. Fetch the provider's final
    // order representation with the server-only API key before considering a
    // wallet mutation.
    const remote = await payment.checkStatus(providerOrderId);
    let verified;
    try {
      verified = payment.validatePaidOrder(remote, {
        providerOrderId,
        reference,
        amount: fromDbAmount(deposit.amount),
        payAmount: deposit.pay_amount === null || deposit.pay_amount === undefined
          ? null
          : fromDbAmount(deposit.pay_amount)
      });
      const webhookBaseAmount = Number(event.base_amount);
      const webhookFee = Number(event.fee_qris);
      const webhookPayAmount = Number(event.pay_amount);
      if (String(event.reference) !== verified.reference
          || webhookBaseAmount !== verified.baseAmount
          || webhookFee !== verified.feeAmount
          || webhookPayAmount !== verified.payAmount) {
        throw new AppError('PAYMENT_AMOUNT_MISMATCH', 'Nominal webhook tidak cocok dengan status AstraPay yang diverifikasi.', 409);
      }
    } catch (error) {
      if (['PAYMENT_ORDER_NOT_PAID', 'PAYMENT_AMOUNT_MISMATCH', 'PAYMENT_EXPIRED', 'PAYMENT_ORDER_MISMATCH'].includes(error?.code)) {
        logger.warn('AstraPay webhook did not match verified order', { reference, code: error.code });
        return ok({ received: true, matched: true, credited: false });
      }
      throw error;
    }

    const eventId = createHash('sha256')
      .update(Buffer.from(`${timestamp}.`, 'utf8'))
      .update(rawBody)
      .digest('hex');
    try {
      const result = await ctx.db.deposits.confirmGatewayPayment({
        ...verified,
        eventId,
        eventType: 'order.paid'
      });
      logger.info('AstraPay payment confirmed', {
        reference,
        depositId: deposit.id,
        credited: Boolean(result.credited),
        duplicate: Boolean(result.duplicate)
      });
      return ok({
        received: true,
        matched: true,
        credited: Boolean(result.credited),
        duplicate: Boolean(result.duplicate)
      });
    } catch (error) {
      if (['DEPOSIT_ALREADY_REVIEWED', 'PAYMENT_ORDER_MISMATCH', 'PAYMENT_AMOUNT_MISMATCH'].includes(error?.code)) {
        logger.warn('AstraPay payment was not credited', { reference, code: error.code });
        return ok({ received: true, matched: true, credited: false });
      }
      throw error;
    }
  }, { public: true });
}
