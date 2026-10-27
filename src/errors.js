// ============================================================================
// ERROR CATALOG — one place that maps internal/database error codes to HTTP
// status codes and safe, user-facing messages. Stack traces never leave the
// server; unmapped errors become a generic 500.
// ============================================================================

export class AppError extends Error {
  /**
   * @param {string} code stable machine code, e.g. INSUFFICIENT_BALANCE
   * @param {string} message Indonesian, safe to show to the user
   * @param {number} status HTTP status
   * @param {object} [extra] optional safe details
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

/**
 * Database/transport failure that carries the REAL diagnostic server-side while
 * exposing only a safe message to the client.
 *
 * Production incident 2026-10-26: `fromDbError` collapsed PostgREST failures
 * into `DB_ERROR` with a generic message, so the log said only
 * "RPC rpc_public_summary gagal" and the actual cause (missing function in the
 * schema cache, revoked EXECUTE, missing table, bad key) was lost. The `cause`
 * was dropped by the log redactor as well, because Errors are serialised as
 * {name, message, code, stack}.
 */
export class DbError extends AppError {
  constructor(code, message, status, diagnostic) {
    super(code, message, status, { diagnostic });
    this.name = 'DbError';
    Object.assign(this, diagnostic);
  }
}

/**
 * PostgREST + PostgreSQL failure classes we can act on.
 * `safe` is the only text a client ever sees; everything else stays in logs.
 */
const DB_FAILURE_MAP = {
  // PostgREST: function not found in its schema cache (stale cache or missing fn)
  PGRST202: ['DB_FUNCTION_MISSING', 503, 'Layanan data sedang disiapkan. Coba lagi beberapa saat lagi.'],
  PGRST203: ['DB_FUNCTION_MISSING', 503, 'Layanan data sedang disiapkan. Coba lagi beberapa saat lagi.'],
  // PostgreSQL: undefined_function
  42883: ['DB_FUNCTION_MISSING', 503, 'Layanan data sedang disiapkan. Coba lagi beberapa saat lagi.'],
  // PostgreSQL: undefined_table / undefined_column
  '42P01': ['DB_SCHEMA_MISMATCH', 503, 'Struktur data belum siap. Hubungi admin.'],
  '42703': ['DB_SCHEMA_MISMATCH', 503, 'Struktur data belum siap. Hubungi admin.'],
  PGRST204: ['DB_SCHEMA_MISMATCH', 503, 'Struktur data belum siap. Hubungi admin.'],
  PGRST205: ['DB_SCHEMA_MISMATCH', 503, 'Struktur data belum siap. Hubungi admin.'],
  // PostgreSQL: insufficient_privilege / RLS violation
  '42501': ['DB_PERMISSION_DENIED', 503, 'Layanan data menolak permintaan. Hubungi admin.'],
  PGRST301: ['DB_PERMISSION_DENIED', 503, 'Layanan data menolak permintaan. Hubungi admin.'],
  // Bad/expired server key or disabled project
  PGRST302: ['DB_AUTH_FAILED', 503, 'Koneksi data tidak terautentikasi. Hubungi admin.'],
  '28000': ['DB_AUTH_FAILED', 503, 'Koneksi data tidak terautentikasi. Hubungi admin.'],
  '28P01': ['DB_AUTH_FAILED', 503, 'Koneksi data tidak terautentikasi. Hubungi admin.'],
  // Connection level
  ETIMEDOUT: ['DB_UNAVAILABLE', 503, 'Layanan data sedang tidak dapat dihubungi.'],
  ECONNREFUSED: ['DB_UNAVAILABLE', 503, 'Layanan data sedang tidak dapat dihubungi.'],
  ENOTFOUND: ['DB_UNAVAILABLE', 503, 'Layanan data sedang tidak dapat dihubungi.'],
  PGRST000: ['DB_UNAVAILABLE', 503, 'Layanan data sedang tidak dapat dihubungi.'],
  PGRST001: ['DB_UNAVAILABLE', 503, 'Layanan data sedang tidak dapat dihubungi.']
};

const RETRYABLE_DB_CODES = new Set([
  'DB_FUNCTION_MISSING',
  'DB_SCHEMA_MISMATCH',
  'DB_PERMISSION_DENIED',
  'DB_AUTH_FAILED',
  'DB_UNAVAILABLE'
]);

/** Strip anything that looks like a credential before it can reach a log line. */
export function scrubSecrets(text) {
  return String(text ?? '')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[db-url redacted]')
    .replace(/https?:\/\/[^\s"']*supabase[^\s"']*/gi, '[supabase-url redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt redacted]')
    .replace(/\b(?:sbp|sb_secret|service_role)[_a-z0-9]{8,}\b/gi, '[key redacted]')
    .slice(0, 800);
}

/**
 * Translate any driver error into a DbError.
 * @param {object} error  PostgREST/Postgres/supabase-js error
 * @param {object} [context] { rpc, table, message } — used for logs only
 */
export function fromDbError(error, context = {}) {
  if (error instanceof AppError) return error;
  const ctx = typeof context === 'string' ? { message: context } : (context || {});

  const pgCode = String(error?.code ?? ctx.pgCode ?? '');
  const pgMessage = scrubSecrets(error?.message || ctx.message || '');
  const pgDetails = scrubSecrets(error?.details || '');
  const pgHint = scrubSecrets(error?.hint || '');

  const diagnostic = {
    pgCode: pgCode || null,
    pgMessage: pgMessage || null,
    pgDetails: pgDetails || null,
    pgHint: pgHint || null,
    rpc: ctx.rpc || null,
    table: ctx.table || null
  };

  // 1. A database RAISE with a known machine code (business rule) wins.
  const mapped = dbErrorCode(error);
  if (mapped) {
    const [status, message] = DB_ERROR_MAP[mapped];
    return new DbError(mapped, message, status, diagnostic);
  }

  // 2. Known infrastructure failure classes.
  const failure = DB_FAILURE_MAP[pgCode];
  if (failure) {
    const [code, status, message] = failure;
    return new DbError(code, message, status, diagnostic);
  }

  // 3. Heuristics for errors that arrive without a usable code.
  const haystack = `${pgMessage} ${pgDetails}`.toLowerCase();
  if (/could not find the function|function .* does not exist|schema cache/.test(haystack)) {
    return new DbError('DB_FUNCTION_MISSING', DB_FAILURE_MAP.PGRST202[2], 503, diagnostic);
  }
  if (/permission denied|row-level security|not authorized/.test(haystack)) {
    return new DbError('DB_PERMISSION_DENIED', DB_FAILURE_MAP['42501'][2], 503, diagnostic);
  }
  if (/relation .* does not exist|column .* does not exist/.test(haystack)) {
    return new DbError('DB_SCHEMA_MISMATCH', DB_FAILURE_MAP['42P01'][2], 503, diagnostic);
  }
  if (/invalid api key|jwt|unauthorized|no api key/.test(haystack)) {
    return new DbError('DB_AUTH_FAILED', DB_FAILURE_MAP.PGRST302[2], 503, diagnostic);
  }
  if (/fetch failed|network|timeout|econnrefused|enotfound|socket hang up/.test(haystack)) {
    return new DbError('DB_UNAVAILABLE', DB_FAILURE_MAP.PGRST000[2], 503, diagnostic);
  }

  return new DbError(
    'DB_ERROR',
    ctx.message || 'Terjadi kesalahan pada database.',
    500,
    diagnostic
  );
}

export const isRetryableDbError = (err) => RETRYABLE_DB_CODES.has(err?.code);

/** Errors raised by PostgreSQL RPCs (MESSAGE = machine code). */
const DB_ERROR_MAP = {
  INSUFFICIENT_BALANCE: [402, 'Saldo tidak mencukupi untuk menyelesaikan pembelian.'],
  WALLET_NOT_FOUND: [404, 'Dompet tidak ditemukan.'],
  INVALID_AMOUNT: [400, 'Nominal tidak valid.'],
  INVALID_INPUT: [400, 'Data yang dikirim tidak valid.'],
  INVALID_EMAIL: [400, 'Format email tidak valid.'],
  INVALID_IDEMPOTENCY_KEY: [400, 'Idempotency key tidak valid.'],
  IDEMPOTENCY_CONFLICT: [409, 'Permintaan dengan kunci yang sama memiliki isi berbeda.'],
  DUPLICATE_LEDGER_ENTRY: [409, 'Transaksi ini sudah pernah diterapkan.'],
  DUPLICATE_ADJUSTMENT: [409, 'Penyesuaian dengan referensi ini sudah pernah diterapkan.'],
  ORDER_NOT_FOUND: [404, 'Order tidak ditemukan.'],
  DEPOSIT_NOT_FOUND: [404, 'Deposit tidak ditemukan.'],
  USER_NOT_FOUND: [404, 'Pengguna tidak ditemukan.'],
  FORBIDDEN: [403, 'Anda tidak memiliki izin untuk tindakan ini.'],
  FORBIDDEN_COLUMN: [403, 'Kolom ini tidak boleh diubah.'],
  INVALID_TRANSITION: [409, 'Perubahan status tidak diizinkan.'],
  INVALID_STATUS: [400, 'Status tidak dikenal.'],
  CANCEL_NOT_AVAILABLE: [409, 'Pembatalan belum tersedia untuk order ini.'],
  TOO_MANY_ACTIVE_ORDERS: [429, 'Terlalu banyak order aktif. Selesaikan order sebelumnya.'],
  TOO_MANY_PENDING_DEPOSITS: [429, 'Terlalu banyak deposit menunggu. Tunggu review admin.'],
  DEPOSIT_ALREADY_REVIEWED: [409, 'Deposit ini sudah direview.'],
  DEPOSIT_BELOW_MINIMUM: [400, 'Nominal deposit di bawah minimum.'],
  DEPOSIT_ABOVE_MAXIMUM: [400, 'Nominal deposit melebihi batas maksimum.'],
  PAYMENT_GATEWAY_DISABLED: [503, 'Pembayaran otomatis belum dikonfigurasi. Gunakan deposit manual.'],
  PAYMENT_PROVIDER_UNAVAILABLE: [503, 'AstraPay sedang tidak dapat dihubungi. Coba lagi.'],
  PAYMENT_PROVIDER_REJECTED: [502, 'AstraPay menolak permintaan pembayaran.'],
  PAYMENT_PROVIDER_CONTRACT_INVALID: [502, 'Respons AstraPay tidak sesuai dokumentasi. Deposit belum dikreditkan.'],
  PAYMENT_AUTO_REVIEW: [409, 'Deposit gateway hanya dapat diselesaikan setelah verifikasi pembayaran.'],
  PAYMENT_ORDER_MISMATCH: [409, 'Referensi transaksi AstraPay tidak cocok.'],
  PAYMENT_AMOUNT_MISMATCH: [409, 'Nominal pembayaran AstraPay tidak cocok dengan invoice.'],
  PAYMENT_ORDER_NOT_PAID: [409, 'Pembayaran AstraPay belum berstatus lunas.'],
  PAYMENT_EXPIRED: [409, 'Invoice AstraPay kedaluwarsa sebelum pembayaran dikonfirmasi.'],
  PROOF_REQUIRED: [400, 'Bukti transfer wajib diunggah.'],
  PROOF_INVALID_TYPE: [415, 'Format bukti transfer tidak didukung.'],
  PROOF_TOO_LARGE: [413, 'Ukuran bukti transfer terlalu besar.'],
  REFUND_NOT_ALLOWED: [409, 'Refund tidak diizinkan untuk order ini.'],
  SUPPLIER_ORDER_MISMATCH: [409, 'Referensi order supplier tidak cocok.'],
  ORDER_HAS_SUPPLIER_REFERENCE: [409, 'Order sudah memiliki referensi supplier; lakukan rekonsiliasi.'],
  LAST_ADMIN: [409, 'Admin terakhir tidak dapat diturunkan.'],
  RATE_LIMITED: [429, 'Terlalu banyak permintaan. Coba lagi nanti.']
};

/** Extract the machine code from a Supabase/PostgREST error. */
export function dbErrorCode(error) {
  if (!error) return null;
  const raw = String(error.message || error.details || error.hint || '');
  // Supabase surfaces the RAISE MESSAGE first, detail second.
  for (const code of Object.keys(DB_ERROR_MAP)) {
    if (raw.includes(code)) return code;
  }
  if (error.code === '23505' || raw.includes('duplicate key')) return 'DUPLICATE_LEDGER_ENTRY';
  return null;
}

/** Build the same AppError the SQL layer would produce, for the memory driver. */
export function appErrorFromCode(code) {
  const entry = DB_ERROR_MAP[code];
  if (!entry) return new AppError(code, 'Permintaan tidak valid.', 400);
  const [status, message] = entry;
  return new AppError(code, message, status);
}

export const errors = {
  unauthorized: () => new AppError('UNAUTHORIZED', 'Sesi tidak valid. Silakan masuk kembali.', 401),
  sessionExpired: () =>
    new AppError('SESSION_EXPIRED', 'Sesi Anda telah berakhir. Silakan masuk kembali.', 401),
  forbidden: () => new AppError('FORBIDDEN', 'Anda tidak memiliki akses ke halaman ini.', 403),
  notFound: (what = 'Sumber daya') => new AppError('NOT_FOUND', `${what} tidak ditemukan.`, 404),
  badRequest: (message = 'Permintaan tidak valid.', code = 'BAD_REQUEST') => new AppError(code, message, 400),
  rateLimited: (retryAfterSeconds = 60) =>
    new AppError('RATE_LIMITED', 'Terlalu banyak permintaan. Silakan coba lagi nanti.', 429, {
      retryAfter: retryAfterSeconds
    }),
  csrf: () => new AppError('CSRF_FAILED', 'Permintaan ditolak (CSRF). Muat ulang halaman.', 403),
  origin: () => new AppError('ORIGIN_NOT_ALLOWED', 'Origin permintaan tidak diizinkan.', 403),
  payloadTooLarge: (max) => new AppError('PAYLOAD_TOO_LARGE', 'Ukuran permintaan terlalu besar.', 413, { max }),
  unsupportedMedia: () => new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type tidak didukung.', 415),
  methodNotAllowed: (allowed = []) =>
    new AppError('METHOD_NOT_ALLOWED', 'Metode HTTP tidak didukung.', 405, { allowed }),
  supplierUnavailable: (message = 'Layanan supplier sedang tidak tersedia.') =>
    new AppError('SUPPLIER_UNAVAILABLE', message, 503),
  supplierNotConfigured: () =>
    new AppError('SUPPLIER_NOT_CONFIGURED', 'Integrasi supplier belum dikonfigurasi oleh administrator.', 503),
  maintenance: () => new AppError('MAINTENANCE', 'Layanan sedang dalam pemeliharaan.', 503),
  accountSuspended: () => new AppError('ACCOUNT_SUSPENDED', 'Akun Anda tidak aktif. Hubungi dukungan.', 403),
  emailNotVerified: () =>
    new AppError('EMAIL_NOT_VERIFIED', 'Verifikasi email Anda terlebih dahulu.', 403),
  conflict: (message = 'Terjadi konflik data.') => new AppError('CONFLICT', message, 409)
};
