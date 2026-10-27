// ============================================================================
// DEPOSITS — manual transfer flow (payment gateway stays disabled).
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
import { normalizeDepositPolicy } from './deposit-policy.js';

export function createDepositService({ db, settings, config, logger }) {
  const storageRoot = path.resolve(config.storageDir);
  const depositDir = path.join(storageRoot, 'deposits');

  async function ensureDirs() {
    await mkdir(depositDir, { recursive: true, mode: 0o700 });
  }

  const toPublic = (row) => ({
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
    reviewedAt: row.reviewed_at
  });

  return {
    toPublic,

    async policy() {
      const policy = normalizeDepositPolicy(await settings.get('deposit_policy'));
      return {
        minAmount: fromDbAmount(policy.min_amount),
        maxAmount: fromDbAmount(policy.max_amount),
        instructions: policy.instructions,
        bankAccounts: Array.isArray(policy.bank_accounts) ? policy.bank_accounts : [],
        expiryHours: policy.expiry_hours,
        gatewayEnabled: false
      };
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
        return { deposit: toPublic(result.deposit), policy };
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
        deposits: rows.map(toPublic),
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
        enriched.push({ ...toPublic(row), user: profile ? { id: profile.id, email: profile.email, username: profile.username } : null });
      }
      return {
        deposits: enriched,
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) }
      };
    },

    async approve({ depositId, adminId, amount = null, note = null, ip, userAgent }) {
      const result = await db.deposits.approve(depositId, adminId, amount, note, { ip, userAgent });
      logger.info('deposit approved', { depositId, adminId, amount: result.deposit.approved_amount });
      return { deposit: toPublic(result.deposit), balance: fromDbAmount(result.balance) };
    },

    async reject({ depositId, adminId, reason, ip, userAgent }) {
      const result = await db.deposits.reject(depositId, adminId, reason, { ip, userAgent });
      logger.info('deposit rejected', { depositId, adminId });
      return { deposit: toPublic(result.deposit) };
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
