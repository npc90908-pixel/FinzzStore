// ============================================================================
// WALLET SERVICE — read models for /wallet. All mutations happen inside
// PostgreSQL RPCs (see database/functions.sql); this module never writes
// balances itself.
// ============================================================================
import { fromDbAmount } from './money.js';
import { MAXIMUM_GATEWAY_TOPUP_AMOUNT, normalizeDepositPolicy } from './deposit-policy.js';
import QRCode from 'qrcode';

const TX_LABEL = {
  deposit: 'Deposit',
  purchase: 'Pembelian nokos',
  refund: 'Refund',
  adjustment: 'Penyesuaian'
};

export function createWalletService({ db, settings, orders, payment }) {
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
      const [wallet, { rows, total }, depositPolicy, refundPolicy, activeOrders, deposits, pendingDeposits] = await Promise.all([
        db.wallets.get(user.id),
        db.transactions.listByUser(user.id, { limit: perPage, offset: (Math.max(1, page) - 1) * perPage }),
        settings.get('deposit_policy'),
        settings.get('refund_policy'),
        db.orders.listActive(user.id),
        db.deposits.listByUser(user.id, { limit: 5 }),
        db.deposits.listPendingByUser(user.id, { limit: 10 })
      ]);

      const pendingManualDeposits = pendingDeposits.rows.filter((d) => d.method === 'manual_transfer');
      const pendingGatewayDeposits = pendingDeposits.rows.filter((d) => d.method === 'gateway');
      const effectiveDepositPolicy = normalizeDepositPolicy(depositPolicy);
      const toDepositSummary = async (d, { includeQrImage = true } = {}) => ({
        id: d.id,
        amount: fromDbAmount(d.amount),
        approvedAmount: d.approved_amount ? fromDbAmount(d.approved_amount) : null,
        status: d.status,
        method: d.method,
        note: d.user_note,
        adminNote: d.admin_note,
        createdAt: d.created_at,
        reviewedAt: d.reviewed_at,
        hasProof: Boolean(d.proof_path),
        payment: d.method === 'gateway' ? {
          provider: 'astrapay',
          reference: d.provider_reference,
          payAmount: d.pay_amount === null || d.pay_amount === undefined ? null : fromDbAmount(d.pay_amount),
          feeAmount: fromDbAmount(d.fee_amount),
          checkoutUrl: d.status === 'pending' ? d.checkout_url : null,
          qris: d.status === 'pending' ? d.qris_payload : null,
          qrisImage: includeQrImage && d.status === 'pending' && d.qris_payload
            ? await QRCode.toDataURL(d.qris_payload, { errorCorrectionLevel: 'M', margin: 2, width: 280 }).catch(() => {
                // Keep wallet summary available even if a malformed provider payload cannot render.
                return null;
              })
            : null,
          providerStatus: d.provider_status,
          expiresAt: d.expires_at,
          paidAt: d.paid_at
        } : null
      });

      return {
        balance: fromDbAmount(wallet?.balance ?? 0),
        currency: wallet?.currency || 'IDR',
        updatedAt: wallet?.updated_at || null,
        transactions: rows.map(toTransaction),
        pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
        activeOrders: activeOrders.map((o) => orders.toPublic(o, { includeOtp: true })),
        deposits: await Promise.all(deposits.rows.map((row) => toDepositSummary(row, { includeQrImage: false }))),
        pendingDeposits: await Promise.all(pendingDeposits.rows.map((row) => toDepositSummary(row))),
        pendingDepositCount: pendingManualDeposits.length,
        pendingGatewayCount: pendingGatewayDeposits.length,
        depositPolicy: {
          minAmount: fromDbAmount(effectiveDepositPolicy.min_amount),
          maxAmount: fromDbAmount(effectiveDepositPolicy.max_amount),
          gatewayMaxAmount: Math.min(fromDbAmount(effectiveDepositPolicy.max_amount), MAXIMUM_GATEWAY_TOPUP_AMOUNT),
          instructions: effectiveDepositPolicy.instructions,
          bankAccounts: Array.isArray(effectiveDepositPolicy.bank_accounts) ? effectiveDepositPolicy.bank_accounts : [],
          expiryHours: effectiveDepositPolicy.expiry_hours
        },
        refundPolicy: refundPolicy.summary,
        paymentGateway: payment?.status?.() || {
          enabled: false,
          message: 'Pembayaran otomatis belum aktif. Gunakan deposit manual.'
        }
      };
    }
  };
}
