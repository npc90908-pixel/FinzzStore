// ============================================================================
// SUPPLIER ERROR MODEL
// `definitive: true`  → the supplier told us the request was rejected and no
//                        order exists, so a refund is safe.
// `definitive: false` → timeout / 5xx / maintenance: the outcome is unknown.
//                        Never refund, never create a new key: reconcile.
// ============================================================================

export class SupplierError extends Error {
  constructor(code, message, { httpStatus = null, definitive = false, retryable = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'SupplierError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.definitive = definitive;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.expose = false;
  }
}

/** Codes documented by TELEKOS.ID that mean "no order was created". */
const DEFINITIVE_CODES = new Set([
  'INVALID_OFFER',
  'INVALID_API_KEY',
  'INSUFFICIENT_BALANCE',
  'OUT_OF_STOCK',
  'OFFER_EXPIRED'
]);

export function classifyHttpStatus(status, code) {
  if (DEFINITIVE_CODES.has(code)) return { definitive: true, retryable: false };
  if (status === 401 || status === 403) return { definitive: true, retryable: false };
  if (status === 402) return { definitive: true, retryable: false };
  if (status === 400) return { definitive: true, retryable: false };
  if (status === 404) return { definitive: true, retryable: false };
  if (status === 409) {
    // 409 CANCEL_NOT_AVAILABLE is a state conflict, not a purchase failure.
    if (code === 'CANCEL_NOT_AVAILABLE') return { definitive: false, retryable: false };
    return { definitive: true, retryable: false };
  }
  if (status === 429) return { definitive: false, retryable: true };
  // 5xx including MAINTENANCE / SERVICE_UNAVAILABLE: unknown state.
  return { definitive: false, retryable: true };
}

/** Map a supplier status string onto our internal order status. */
export function mapSupplierStatus(status) {
  switch (String(status || '').toLowerCase()) {
    // In-flight states: the supplier has not answered yet. They are NOT final
    // and NOT a manual-review case — keep polling.
    case 'processing':
    case 'purchase_confirmation_pending':
      return 'pending';
    case 'waiting':
      return 'waiting';
    case 'received':
      return 'received';
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      return null;
  }
}

/** True only when the supplier confirmed that no order exists. */
export function isDefinitive(err) {
  if (!err) return false;
  if (err instanceof SupplierError) return Boolean(err.definitive);
  return err.definitive === true;
}

/**
 * User-facing text. Supplier messages can contain internal hints (offer ids,
 * balance figures, endpoints), so they are never forwarded verbatim.
 */
const PUBLIC_MESSAGES = {
  INVALID_OFFER: 'Nomor yang dipilih sudah tidak tersedia',
  OFFER_EXPIRED: 'Harga nomor sudah berubah, silakan pilih ulang',
  OUT_OF_STOCK: 'Stok nomor sedang kosong',
  INSUFFICIENT_BALANCE: 'Stok supplier sedang tidak mencukupi',
  INVALID_API_KEY: 'Layanan sedang tidak tersedia',
  RATE_LIMITED: 'Permintaan terlalu sering, coba lagi sebentar',
  MAINTENANCE: 'Supplier sedang dalam pemeliharaan',
  SERVICE_UNAVAILABLE: 'Supplier sedang tidak tersedia',
  TIMEOUT: 'Supplier tidak merespons tepat waktu',
  NETWORK_ERROR: 'Gagal menghubungi supplier',
  UNREACHABLE: 'Supplier tidak dapat dihubungi',
  INVALID_RESPONSE: 'Supplier mengirim data yang tidak valid',
  CANCEL_NOT_AVAILABLE: 'Order sudah tidak dapat dibatalkan',
  CANCELLED_BY_USER: 'Dibatalkan oleh pengguna',
  SUPPLIER_ORDER_LOST: 'Order tidak ditemukan di supplier',
  STATUS_CONFLICT: 'Status order perlu ditinjau admin'
};

export function publicSupplierMessage(code, fallback = null) {
  return PUBLIC_MESSAGES[code] || fallback || 'Terjadi kendala pada penyedia nomor';
}
