// ============================================================================
// INPUT VALIDATION — server-side, explicit, no schema library dependency.
// Every value that reaches the database or the HTML renderer passes here first.
// ============================================================================
import { parseRupiah } from './money.js';

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.status = 422;
    this.field = field;
    this.expose = true;
  }
}

const fail = (field, message) => {
  throw new ValidationError(field, message);
};

/** Strip control characters (except newline/tab), normalise whitespace. */
export function sanitizeText(value, { maxLength = 1000 } = {}) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, maxLength);
}

export function string(value, { field = 'field', min = 0, max = 1000, pattern = null, optional = false, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    fail(field, `${field} wajib diisi`);
  }
  if (typeof value !== 'string') fail(field, `${field} harus berupa teks`);
  const out = trim ? sanitizeText(value, { maxLength: max + 1 }) : value;
  if (out.length < min) fail(field, `${field} minimal ${min} karakter`);
  if (out.length > max) fail(field, `${field} maksimal ${max} karakter`);
  if (pattern && !pattern.test(out)) fail(field, `${field} formatnya tidak valid`);
  return out;
}

export function email(value, { field = 'email' } = {}) {
  const raw = string(value, { field, max: 254 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(raw)) fail(field, 'Format email tidak valid');
  return raw;
}

export function uuid(value, { field = 'id', optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const raw = string(value, { field, max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    fail(field, `${field} tidak valid`);
  }
  return raw.toLowerCase();
}

/** Idempotency keys are client generated but strictly constrained. */
export function idempotencyKey(value, { field = 'idempotency_key' } = {}) {
  const raw = string(value, { field, min: 8, max: 128 });
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) fail(field, `${field} mengandung karakter tidak valid`);
  return raw;
}

export function password(value, { field = 'password' } = {}) {
  if (typeof value !== 'string') fail(field, 'Password wajib diisi');
  if (value.length < 8) fail(field, 'Password minimal 8 karakter');
  if (value.length > 72) fail(field, 'Password maksimal 72 karakter');
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    fail(field, 'Password harus mengandung huruf dan angka');
  }
  return value;
}

export function username(value, { field = 'username', optional = true } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const raw = string(value, { field, min: 3, max: 24 });
  if (!/^[A-Za-z0-9_]+$/.test(raw)) fail(field, 'Username hanya boleh huruf, angka, dan garis bawah');
  return raw.toLowerCase();
}

export function enumOf(value, { field = 'field', values = [] } = {}) {
  const raw = string(value, { field, max: 60 });
  if (!values.includes(raw)) fail(field, `${field} tidak dikenal`);
  return raw;
}

export function integer(value, { field = 'field', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail(field, `${field} wajib diisi`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) fail(field, `${field} harus bilangan bulat`);
  if (n < min || n > max) fail(field, `${field} di luar rentang yang diizinkan`);
  return n;
}

export function money(value, { field = 'amount', min = 0, max = 1_000_000_000 } = {}) {
  try {
    return parseRupiah(value, { min, max, field });
  } catch (err) {
    fail(field, err.message);
  }
}

export function boolean(value, { field = 'field', fallback = false } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  fail(field, `${field} harus boolean`);
}

export function arrayOf(value, { field = 'items', max = 50, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return [];
    fail(field, `${field} wajib diisi`);
  }
  if (!Array.isArray(value)) fail(field, `${field} harus berupa array`);
  if (value.length > max) fail(field, `${field} maksimal ${max} item`);
  return value;
}

/**
 * Validate an object against a schema of validator functions.
 * Unknown keys are rejected so clients cannot smuggle fields into updates.
 */
export function object(value, schema, { field = 'body', allowUnknown = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'Body harus berupa objek JSON');
  const out = {};
  for (const [key, validator] of Object.entries(schema)) {
    if (typeof validator !== 'function') continue;
    out[key] = validator(value[key]);
  }
  if (!allowUnknown) {
    const unknown = Object.keys(value).filter((k) => !(k in schema));
    if (unknown.length > 0) fail(field, `Field tidak dikenal: ${unknown.slice(0, 5).join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// FILE UPLOAD VALIDATION (magic bytes, not just the declared MIME type)
// ---------------------------------------------------------------------------
export const ALLOWED_PROOF_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
});

export function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  return null;
}

/**
 * Decode a base64 (or data URL) upload and verify type + size.
 * @returns {{buffer: Buffer, mime: string, size: number, ext: string}}
 */
export function decodeUpload(value, { maxBytes = 5 * 1024 * 1024, field = 'proof' } = {}) {
  if (typeof value !== 'string' || value.length === 0) fail(field, 'File wajib diunggah');
  let base64 = value;
  const dataUrl = /^data:([\w/+.-]+);base64,(.+)$/s.exec(value);
  if (dataUrl) base64 = dataUrl[2];
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) fail(field, 'Encoding file tidak valid');
  const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) fail(field, 'File kosong');
  if (buffer.length > maxBytes) fail(field, `Ukuran file maksimal ${Math.floor(maxBytes / 1024 / 1024)} MB`);

  const mime = detectMime(buffer);
  if (!mime || !ALLOWED_PROOF_TYPES[mime]) {
    fail(field, 'File harus berupa PNG, JPG, WEBP, atau PDF yang valid');
  }
  if (dataUrl && dataUrl[1] !== mime) fail(field, 'Tipe file tidak cocok dengan isinya');

  return { buffer, mime, size: buffer.length, ext: ALLOWED_PROOF_TYPES[mime] };
}

/** Guard against open redirects: only same-origin absolute paths are allowed. */
export function safeReturnPath(value, fallback = '/dashboard') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return fallback;
  if (/^\/api\//.test(value)) return fallback;
  return value;
}
