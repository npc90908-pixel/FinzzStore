// ============================================================================
// PAYMENT GATEWAY ADAPTER — intentionally DISABLED.
//
// No provider, documentation or credentials were supplied by the project owner,
// so this module contains no provider endpoints, no invoice creation and no
// activation logic. It defines the contract that a future provider must
// implement, plus the security rules the implementation must obey:
//
//   * verify a cryptographic signature over the RAW request body;
//   * deduplicate callbacks (provider event id) before crediting;
//   * credit the wallet only through rpc_approve_deposit / a future
//     rpc_credit_deposit RPC — never from redirect query parameters;
//   * enforce an expiry window on invoices;
//   * keep keys in the server environment only.
//
// `createPaymentAdapter()` always reports enabled=false and refuses to act.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const DISABLED_MESSAGE =
  'Payment gateway belum dikonfigurasi. Deposit otomatis tidak tersedia; gunakan deposit manual.';

export function createPaymentAdapter(config, { logger } = {}) {
  const configured = Boolean(config.payment.provider && config.payment.secret && config.payment.mode === 'live');

  const notEnabled = () => {
    throw new AppError('PAYMENT_GATEWAY_DISABLED', DISABLED_MESSAGE, 503);
  };

  return {
    enabled: false, // hard-coded: enabling requires an explicit code change + review
    configured,
    provider: config.payment.provider,
    mode: 'disabled',

    status() {
      return {
        enabled: false,
        configured,
        provider: config.payment.provider || null,
        mode: 'disabled',
        message: DISABLED_MESSAGE,
        capabilities: {
          createPayment: false,
          checkStatus: false,
          verifyCallback: false,
          expiration: false
        }
      };
    },

    async createPayment() {
      notEnabled();
    },

    async checkStatus() {
      notEnabled();
    },

    /**
     * Contract helper kept for review: constant-time HMAC verification of
     * `timestamp.rawBody`. Used by a future provider implementation; it never
     * credits anything by itself.
     */
    verifySignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300 }) {
      if (!secret) return false;
      const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(signatureHeader || ''));
      if (!match) return false;
      const [, timestamp, signature] = match;
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (age > toleranceSeconds) return false;
      const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
      const a = Buffer.from(signature, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    },

    async handleCallback() {
      logger?.warn?.('payment callback received while gateway is disabled');
      notEnabled();
    }
  };
}
