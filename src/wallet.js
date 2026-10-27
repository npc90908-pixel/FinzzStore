// ============================================================================
// WALLET SERVICE — read models for /wallet. All mutations happen inside
// PostgreSQL RPCs (see database/functions.sql); this module never writes
// balances itself.
// ============================================================================
import { fromDbAmount } from './money.js';
import { normalizeDepositPolicy } from './deposit-policy.js';

const TX_LABEL = {
  deposit: 'Deposit',
  purchase: 'Pembelian nokos',
  refund: 'Refund',
  adjustment: 'Penyesuaian'
};

export function createWalletService({ db, settings, orders }) {
  const toTransaction = (row) => ({
    id: row.id,
    type: row.type,
    label: TX_LABEL[row.type] || row.type,
    direction: row.direction,
    amount: fromDbAmount(row.amount),
    balanceAfter: fromDbAmount(row.balance_after),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    description: row.description,
    createdAt: row.created_at
  });

  return {
    toTransaction,

    async summary(user, { page = 1, perPage = 15 } = {}) {
      const [wallet, { rows, total }, depositPolicy, refundPolicy, activeOrders, deposits] = await Promise.all([
        db.wallets.get(user.id),
        db.transactions.listByUser(user.id, { limit: perPage, offset: (Math.max(1, page) - 1) * perPage }),
        settings.get('deposit_policy'),
        settings.get('refund_policy'),
        db.orders.listActive(user.id),
        db.deposits.listByUser(user.id, { limit: 5 })
      ]);

      const pendingDeposits = deposits.rows.filter((d) => d.status === 'pending');
      const effectiveDepositPolicy = normalizeDepositPolicy(depositPolicy);

      return {
        balance: fromDbAmount(wallet?.balance ?? 0),
        currency: wallet?.currency || 'IDR',
        updatedAt: wallet?.updated_at || null,
        transactions: rows.map(toTransaction),
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
        activeOrders: activeOrders.map((o) => orders.toPublic(o, { includeOtp: true })),
        deposits: deposits.rows.map((d) => ({
          id: d.id,
          amount: fromDbAmount(d.amount),
          approvedAmount: d.approved_amount ? fromDbAmount(d.approved_amount) : null,
          status: d.status,
          note: d.user_note,
          adminNote: d.admin_note,
          createdAt: d.created_at,
          reviewedAt: d.reviewed_at,
          hasProof: Boolean(d.proof_path)
        })),
        pendingDepositCount: pendingDeposits.length,
        depositPolicy: {
          minAmount: fromDbAmount(effectiveDepositPolicy.min_amount),
          maxAmount: fromDbAmount(effectiveDepositPolicy.max_amount),
          instructions: effectiveDepositPolicy.instructions,
          bankAccounts: Array.isArray(effectiveDepositPolicy.bank_accounts) ? effectiveDepositPolicy.bank_accounts : [],
          expiryHours: effectiveDepositPolicy.expiry_hours
        },
        refundPolicy: refundPolicy.summary,
        paymentGateway: { enabled: false, message: 'Pembayaran otomatis belum aktif. Gunakan deposit manual.' }
      };
    }
  };
}
