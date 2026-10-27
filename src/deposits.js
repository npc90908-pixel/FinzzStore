// ============================================================================
// DEPOSITS — manual review and optional AstraPay gateway flows.
//
// Proof of transfer is validated by magic bytes (not the declared MIME type),
// stored outside the public directory with a random name and mode 0600, and is
// readable only by admins through an authenticated route.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, errors } from './errors.js';
import { decodeUpload } from './validation.js';
import { fromDbAmount } from './money.js';
import { MAXIMUM_GATEWAY_TOPUP_AMOUNT, normalizeDepositPolicy } from './deposit-policy.js';
import QRCode from 'qrcode';

export function createDepositService({ db, settings, config, payment, logger }) {
  const storageRoot = path.resolve(config.storageDir);
  const depositDir = path.join(storageRoot, 'deposits');

  async function ensureDirs() {
    await mkdir(depositDir, { recursive: true, mode: 0o700 });
  }

  const toPublic = async (row, { includeQrImage = true } = {}) => ({
    id: row.id,
    amount: fromDbAmount(row.amount),
    approvedAmount: row.approved_amount ? fromDbAmount(row.approved_amount) : null,
    status: row.status,
    method: row.method,
    userNote: row.user_note,
    adminNote: row.admin_note,
    hasProof: Boolean(row.proof_path),
    proofMime: row.proof_mime,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    payment: row.method === 'gateway' ? {
      provider: 'astrapay',
      reference: row.provider_reference,
      payAmount: row.pay_amount === null || row.pay_amount === undefined ? null : fromDbAmount(row.pay_amount),
      feeAmount: fromDbAmount(row.fee_amount),
      checkoutUrl: row.status === 'pending' ? row.checkout_url : null,
      qris: row.status === 'pending' ? row.qris_payload : null,
      qrisImage: includeQrImage && row.status === 'pending' && row.qris_payload
        ? await QRCode.toDataURL(row.qris_payload, { errorCorrectionLevel: 'M', margin: 2, width: 280 }).catch((error) => {
            logger.warn('QRIS payload could not be rendered locally', { depositId: row.id, code: error?.name || 'QR_RENDER_ERROR' });
            return null;
          })
        : null,
      providerStatus: row.provider_status,
      expiresAt: row.expires_at,
      paidAt: row.paid_at
    } : null
  });

  return {
    toPublic,

    async policy() {
      const policy = normalizeDepositPolicy(await settings.get('deposit_policy'));
      return {
        minAmount: fromDbAmount(policy.min_amount),
        maxAmount: fromDbAmount(policy.max_amount),
        gatewayMaxAmount: Math.min(fromDbAmount(policy.max_amount), MAXIMUM_GATEWAY_TOPUP_AMOUNT),
        instructions: policy.instructions,
        bankAccounts: Array.isArray(policy.bank_accounts) ? policy.bank_accounts : [],
        expiryHours: policy.expiry_hours,
        gatewayEnabled: Boolean(payment?.enabled)
      };
    },

    async createGateway({ user, amount }) {
      if (user.status !== 'active') throw errors.accountSuspended();
      if (!payment?.enabled) throw new AppError('PAYMENT_GATEWAY_DISABLED', payment?.disabledMessage || 'Pembayaran otomatis belum aktif.', 503);
      const policy = await this.policy();
      if (!Number.isSafeInteger(amount) || amount < policy.minAmount || amount > policy.gatewayMaxAmount) {
        throw amount < policy.minAmount ? errors.badRequest('Nominal deposit di bawah minimum.', 'DEPOSIT_BELOW_MINIMUM')
          : amount > policy.gatewayMaxAmount ? errors.badRequest('Nominal deposit melebihi batas maksimum.', 'DEPOSIT_ABOVE_MAXIMUM')
            : errors.badRequest('Nominal deposit tidak valid.', 'INVALID_AMOUNT');
      }

      const reference = `FZ-${randomUUID().replaceAll('-', '')}`;
      const expiresIn = config.payment.astraPay.expiresIn;
      const intent = await db.deposits.createGateway({
        userId: user.id,
        amount,
        reference,
        minAmount: policy.minAmount,
        maxAmount: policy.gatewayMaxAmount,
        maxPending: 3,
        expiresIn
      });

      const webhookUrl = `${config.appUrl}/api/webhooks/astrapay`;
      const redirectUrl = `${config.appUrl}/wallet?payment=${encodeURIComponent(reference)}`;
      try {
        const invoice = await payment.createPayment({ amount, reference, webhookUrl, redirectUrl });
        const saved = await db.deposits.storeGatewayInvoice({
          depositId: intent.deposit.id,
          providerOrderId: invoice.providerOrderId,
          reference,
          payAmount: invoice.payAmount,
          feeAmount: invoice.feeAmount,
          checkoutUrl: invoice.checkoutUrl,
          qris: invoice.qris,
          expiresAt: invoice.expiresAt,
          providerStatus: invoice.status
        });
        logger.info('AstraPay invoice created', { depositId: intent.deposit.id, reference, amount });
        return {
          deposit: await toPublic(saved.deposit),
          payment: {
            provider: 'astrapay',
            checkoutUrl: invoice.checkoutUrl,
            qris: invoice.qris,
            baseAmount: invoice.baseAmount,
            payAmount: invoice.payAmount,
            feeAmount: invoice.feeAmount,
            expiresAt: invoice.expiresAt
          }
        };
      } catch (error) {
        logger.warn('AstraPay invoice creation did not complete; retaining the intent until expiry', {
          depositId: intent.deposit.id,
          code: error?.code || 'PAYMENT_CREATE_ERROR'
        });
        throw error;
      }
    },

    async reconcileGatewayPending({ limit = 10 } = {}) {
      if (!payment?.configured) return { checked: 0, credited: 0, expired: 0, skipped: 'unconfigured' };
      const { rows } = await db.deposits.listPendingGateway({ limit });
      let checked = 0;
      let credited = 0;
      let expired = 0;
      for (const deposit of rows) {
        try {
          if (!deposit.provider_order_id) {
            const expiresAt = Date.parse(deposit.expires_at || '');
            if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
              await db.deposits.closeGatewayDeposit(deposit.id, 'expired');
              expired += 1;
            }
            continue;
          }
          const remote = await payment.checkStatus(deposit.provider_order_id);
          checked += 1;
          const status = String(remote.status || '').toLowerCase();
          if (status === 'paid') {
            const paid = payment.validatePaidOrder(remote, {
              providerOrderId: deposit.provider_order_id,
              reference: deposit.provider_reference,
              amount: fromDbAmount(deposit.amount),
              payAmount: deposit.pay_amount === null ? null : fromDbAmount(deposit.pay_amount)
            });
            const eventId = createHash('sha256')
              .update(`reconciliation:${paid.providerOrderId}:${paid.paidAt}`)
              .digest('hex');
            const result = await db.deposits.confirmGatewayPayment({ ...paid, eventId, eventType: 'reconciliation.paid' });
            if (result.credited) credited += 1;
          } else if (['expired', 'cancelled', 'canceled'].includes(status)) {
            await db.deposits.closeGatewayDeposit(deposit.id, status);
            expired += 1;
          }
        } catch (error) {
          logger.warn('AstraPay reconciliation deferred', {
            depositId: deposit.id,
            code: error?.code || 'PAYMENT_RECONCILE_ERROR'
          });
        }
      }
      return { checked, credited, expired };
    },

    async create({ user, amount, proofBase64, note }) {
      if (user.status !== 'active') throw errors.accountSuspended();
      const policy = await this.policy();

      // 1. validate the upload (type by magic bytes, size, base64 shape)
      const upload = decodeUpload(proofBase64, {
        maxBytes: Math.min(config.limits.maxUploadBytes, 5 * 1024 * 1024),
        field: 'proof'
      });

      // 2. persist outside the web root with a random name
      await ensureDirs();
      const filename = `${randomUUID()}.${upload.ext}`;
      const absolute = path.join(depositDir, filename);
      await writeFile(absolute, upload.buffer, { mode: 0o600, flag: 'wx' });
      const digest = createHash('sha256').update(upload.buffer).digest('hex');

      // 3. create the pending deposit through the RPC (validation duplicated in SQL)
      try {
        const result = await db.deposits.create({
          userId: user.id,
          amount,
          proofPath: `deposits/${filename}`,
          proofMime: upload.mime,
          proofSize: upload.size,
          proofSha256: digest,
          note,
          minAmount: policy.minAmount,
          maxAmount: policy.maxAmount,
          maxPending: 3
        });
        logger.info('deposit created', { depositId: result.deposit.id, userId: user.id, amount });
        return { deposit: await toPublic(result.deposit), policy };
      } catch (err) {
        // Never leave an orphan file behind when the row is rejected.
        await writeFile(absolute, '').catch(() => {});
        throw err;
      }
    },

    async listMine({ user, page = 1, perPage = 10 }) {
      const { rows, total } = await db.deposits.listByUser(user.id, {
        limit: perPage,
        offset: (Math.max(1, page) - 1) * perPage
      });
      return {
        deposits: await Promise.all(rows.map((row) => toPublic(row))),
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) }
      };
    },

    async listForAdmin({ status = 'pending', page = 1, perPage = 20 }) {
      const { rows, total } = await db.deposits.adminList({
        status: status === 'all' ? null : status,
        limit: perPage,
        offset: (Math.max(1, page) - 1) * perPage
      });
      const enriched = [];
      for (const row of rows) {
        const profile = await db.profiles.get(row.user_id);
        enriched.push({ ...await toPublic(row, { includeQrImage: false }), user: profile ? { id: profile.id, email: profile.email, username: profile.username } : null });
      }
      return {
        deposits: enriched,
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) }
      };
    },

    async approve({ depositId, adminId, amount = null, note = null, ip, userAgent }) {
      const result = await db.deposits.approve(depositId, adminId, amount, note, { ip, userAgent });
      logger.info('deposit approved', { depositId, adminId, amount: result.deposit.approved_amount });
      return { deposit: await toPublic(result.deposit), balance: fromDbAmount(result.balance) };
    },

    async reject({ depositId, adminId, reason, ip, userAgent }) {
      const result = await db.deposits.reject(depositId, adminId, reason, { ip, userAgent });
      logger.info('deposit rejected', { depositId, adminId });
      return { deposit: await toPublic(result.deposit) };
    },

    /** Admin-only proof download. Rejects any path escaping the deposit dir. */
    async readProof(deposit) {
      if (!deposit?.proof_path || !deposit.proof_path.startsWith('deposits/')) {
        throw errors.notFound('Bukti transfer');
      }
      const absolute = path.resolve(storageRoot, deposit.proof_path);
      if (!absolute.startsWith(depositDir + path.sep)) throw errors.forbidden();
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) throw errors.notFound('Bukti transfer');
      const buffer = await readFile(absolute);
      return { buffer, mime: deposit.proof_mime || 'application/octet-stream', size: info.size };
    },

    async getForAdmin(depositId) {
      const deposit = await db.deposits.get(depositId);
      if (!deposit) throw new AppError('DEPOSIT_NOT_FOUND', 'Deposit tidak ditemukan.', 404);
      return deposit;
    }
  };
}
