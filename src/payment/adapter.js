// ============================================================================
// ASTRAPAY PAYMENT ADAPTER
//
// API key and webhook secret stay server-side. A browser return URL is only a
// navigation aid: wallet credit requires a signed webhook (or scheduled
// server-side reconciliation) plus a fresh authenticated order lookup.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const API_BASE = 'https://gateway.astrapay.biz.id/api';
const CHECKOUT_ORIGIN = 'https://gateway.astrapay.biz.id';
const DISABLED_MESSAGE = 'Pembayaran otomatis belum aktif. Gunakan deposit manual.';

const providerError = (message = 'AstraPay sedang tidak dapat dihubungi. Coba lagi.') =>
  new AppError('PAYMENT_PROVIDER_UNAVAILABLE', message, 503);

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', `Respons AstraPay tidak valid (${field}).`, 502);
  }
  return number;
}

function isoDate(value, field) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', `Respons AstraPay tidak valid (${field}).`, 502);
  }
  return date.toISOString();
}

function requireData(payload) {
  if (!payload || payload.ok !== true || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'Format respons AstraPay tidak sesuai dokumentasi.', 502);
  }
  return payload.data;
}

function validateCheckoutUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'URL pembayaran AstraPay tidak valid.', 502);
  }
  if (url.origin !== CHECKOUT_ORIGIN || !url.pathname.startsWith('/pay/') || url.username || url.password) {
    throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'URL pembayaran AstraPay tidak valid.', 502);
  }
  return url.toString();
}

export function createPaymentAdapter(config, { logger, fetchImpl = globalThis.fetch } = {}) {
  const credentials = config.payment?.astraPay || {};
  const configured = Boolean(credentials.projectSlug && credentials.apiKey && credentials.webhookSecret);
  const enabled = Boolean(credentials.enabled && configured);
  const expiresIn = Number(credentials.expiresIn) || 600;
  const timeoutMs = Number(credentials.timeoutMs) || 10000;
  const toleranceSeconds = Number(credentials.webhookToleranceSeconds) || 300;

  const requireConfigured = () => {
    if (!configured) throw new AppError('PAYMENT_GATEWAY_DISABLED', DISABLED_MESSAGE, 503);
    if (typeof fetchImpl !== 'function') throw providerError();
  };
  const requireEnabled = () => {
    if (!enabled) throw new AppError('PAYMENT_GATEWAY_DISABLED', DISABLED_MESSAGE, 503);
    requireConfigured();
  };

  async function request(path, { method = 'GET', body } = {}) {
    requireConfigured();
    let response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': credentials.apiKey
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      logger?.warn?.('AstraPay request failed', { code: error?.name || 'NETWORK_ERROR' });
      throw providerError();
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw providerError();
    }
    if (Buffer.byteLength(text) > 256 * 1024) {
      logger?.warn?.('AstraPay response exceeded size limit', { status: response.status });
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'Respons AstraPay melebihi batas ukuran.', 502);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      logger?.warn?.('AstraPay returned invalid JSON', { status: response.status });
      throw providerError();
    }
    if (!response.ok) {
      // Do not forward provider bodies; they may contain diagnostics or data
      // outside our public error contract. Status alone is safe to log.
      logger?.warn?.('AstraPay rejected request', { status: response.status });
      throw new AppError('PAYMENT_PROVIDER_REJECTED', 'AstraPay menolak permintaan pembayaran.', 502);
    }
    return { status: response.status, data: requireData(payload) };
  }

  function verifyWebhook({ rawBody, timestamp, signature }) {
    if (!configured || !credentials.webhookSecret || !Buffer.isBuffer(rawBody)) return false;
    const timestampText = String(timestamp || '');
    const signatureText = String(signature || '');
    if (!/^\d{10}$/.test(timestampText) || !/^v1=[a-fA-F0-9]{64}$/.test(signatureText)) return false;
    const seconds = Number(timestampText);
    if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > toleranceSeconds) return false;
    const suppliedHex = signatureText.slice(3);
    const expectedHex = createHmac('sha256', credentials.webhookSecret)
      .update(Buffer.from(`${timestampText}.`, 'utf8'))
      .update(rawBody)
      .digest('hex');
    const supplied = Buffer.from(suppliedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function validateCreatedOrder(data, { amount, reference }) {
    if (data.status !== 'pending' || String(data.reference || '') !== reference) {
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'AstraPay mengembalikan transaksi dengan status atau referensi tidak sesuai.', 502);
    }
    const baseAmount = positiveInteger(data.base_amount, 'base_amount');
    const feeQris = positiveInteger(data.fee_qris, 'fee_qris');
    const serviceFee = data.service_fee === undefined ? 0 : positiveInteger(data.service_fee, 'service_fee');
    const creditAmount = positiveInteger(data.credit_amount, 'credit_amount');
    const payAmount = positiveInteger(data.pay_amount, 'pay_amount');
    if (baseAmount !== amount || creditAmount !== amount || payAmount < baseAmount + feeQris + serviceFee) {
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'Nominal atau rincian biaya AstraPay tidak konsisten.', 502);
    }
    const orderId = String(data.id || '');
    if (!orderId || orderId.length > 120 || /[\u0000-\u001f\u007f]/.test(orderId)) {
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'ID transaksi AstraPay tidak valid.', 502);
    }
    const qris = String(data.qris || '');
    if (!qris || qris.length > 10000) {
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'QRIS AstraPay tidak valid.', 502);
    }
    const checkoutUrl = validateCheckoutUrl(data.checkout_url);
    const expiresAt = isoDate(data.expires_at, 'expires_at');
    const expiryMs = Date.parse(expiresAt);
    const now = Date.now();
    if (expiryMs <= now || expiryMs > now + (expiresIn + 45) * 1000) {
      throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'Waktu kedaluwarsa transaksi AstraPay tidak valid.', 502);
    }
    return {
      providerOrderId: orderId,
      reference,
      baseAmount,
      feeAmount: feeQris + serviceFee,
      feeQris,
      serviceFee,
      payAmount,
      creditAmount,
      qris,
      checkoutUrl,
      expiresAt,
      status: 'pending'
    };
  }

  function validatePaidOrder(data, expected) {
    const orderId = String(data.id || '');
    const reference = String(data.reference || '');
    const status = String(data.status || '').toLowerCase();
    const baseAmount = positiveInteger(data.base_amount, 'base_amount');
    const feeQris = positiveInteger(data.fee_qris, 'fee_qris');
    const serviceFee = data.service_fee === undefined ? 0 : positiveInteger(data.service_fee, 'service_fee');
    const payAmount = positiveInteger(data.pay_amount, 'pay_amount');
    const creditAmount = data.credit_amount === undefined
      ? baseAmount
      : positiveInteger(data.credit_amount, 'credit_amount');
    const paidAt = isoDate(data.paid_at, 'paid_at');
    const expiresAt = isoDate(data.expires_at, 'expires_at');

    if (orderId !== expected.providerOrderId || reference !== expected.reference || status !== 'paid') {
      throw new AppError('PAYMENT_ORDER_NOT_PAID', 'Status pembayaran AstraPay belum dapat diverifikasi.', 409);
    }
    if (baseAmount !== expected.amount || creditAmount !== expected.amount || payAmount < baseAmount + feeQris + serviceFee) {
      throw new AppError('PAYMENT_AMOUNT_MISMATCH', 'Nominal atau rincian biaya AstraPay tidak sesuai deposit.', 409);
    }
    if (expected.payAmount !== null && expected.payAmount !== undefined && payAmount !== expected.payAmount) {
      throw new AppError('PAYMENT_AMOUNT_MISMATCH', 'Nominal bayar AstraPay berbeda dari invoice yang dibuat.', 409);
    }
    if (Date.parse(paidAt) > Date.parse(expiresAt)) {
      throw new AppError('PAYMENT_EXPIRED', 'Pembayaran AstraPay tercatat setelah invoice kedaluwarsa.', 409);
    }
    return {
      providerOrderId: orderId,
      reference,
      baseAmount,
      feeAmount: feeQris + serviceFee,
      feeQris,
      serviceFee,
      creditAmount,
      payAmount,
      paidAt,
      expiresAt,
      status
    };
  }

  return {
    enabled,
    configured,
    provider: enabled ? 'astrapay' : null,
    mode: enabled ? 'live' : 'disabled',

    status() {
      return {
        enabled,
        configured,
        provider: enabled ? 'astrapay' : null,
        mode: enabled ? 'live' : 'disabled',
        message: enabled ? 'Pembayaran otomatis via AstraPay tersedia.' : DISABLED_MESSAGE,
        capabilities: {
          createPayment: enabled,
          checkStatus: configured,
          verifyCallback: configured,
          expiration: enabled
        }
      };
    },

    async createPayment({ amount, reference, webhookUrl, redirectUrl }) {
      requireEnabled();
      if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100_000_000) {
        throw new AppError('INVALID_AMOUNT', 'Nominal deposit tidak valid.', 400);
      }
      if (typeof reference !== 'string' || reference.length < 8 || reference.length > 100 || !/^[A-Za-z0-9_-]+$/.test(reference)) {
        throw new AppError('INVALID_INPUT', 'Referensi deposit tidak valid.', 400);
      }
      if (typeof webhookUrl !== 'string' || typeof redirectUrl !== 'string') {
        throw new AppError('INVALID_INPUT', 'URL callback AstraPay tidak valid.', 400);
      }
      const { status, data } = await request(`/orders/${encodeURIComponent(credentials.projectSlug)}`, {
        method: 'POST',
        body: {
          amount,
          reference,
          webhook_url: webhookUrl,
          redirect_url: redirectUrl,
          expires_in: expiresIn
        }
      });
      if (status !== 201) {
        throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'AstraPay tidak mengembalikan status pembuatan invoice yang diharapkan.', 502);
      }
      return validateCreatedOrder(data, { amount, reference });
    },

    async checkStatus(orderIdentifier) {
      requireConfigured();
      const id = String(orderIdentifier || '');
      if (!id || id.length > 120 || /[\u0000-\u001f\u007f]/.test(id)) {
        throw new AppError('INVALID_INPUT', 'ID transaksi AstraPay tidak valid.', 400);
      }
      const { status, data } = await request(
        `/orders/${encodeURIComponent(credentials.projectSlug)}/${encodeURIComponent(id)}`
      );
      if (status !== 200) {
        throw new AppError('PAYMENT_PROVIDER_CONTRACT_INVALID', 'AstraPay tidak mengembalikan status transaksi yang diharapkan.', 502);
      }
      return data;
    },

    verifyWebhook,
    validatePaidOrder,
    disabledMessage: DISABLED_MESSAGE
  };
}
