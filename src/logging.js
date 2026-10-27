// ============================================================================
// STRUCTURED LOGGING with secret redaction.
// Every log line is a single JSON object on stdout/stderr so PM2/Vercel can
// capture it. Tokens, cookies, passwords, OTP codes and API keys are redacted
// before write.
//
// Production incident 2026-10-26: the redactor serialised every Error as
// {name,message,code,stack} and silently dropped `cause` and any extra field.
// The database diagnostic (SQLSTATE, PostgREST code, RPC name, hint) was lost,
// so the only thing left in production logs was "RPC rpc_public_summary gagal".
// Errors now keep a whitelisted set of diagnostic fields, still scrubbed.
// ============================================================================
import { scrubSecrets } from './errors.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /(pass|secret|token|authorization|cookie|otp|api[_-]?key|signature|csrf|refresh|access|credential)/i;
const REDACTED = '[redacted]';

/**
 * Fields copied from an Error instance. Everything here is operational
 * metadata (never credentials); each string is passed through scrubSecrets.
 */
const DIAGNOSTIC_FIELDS = [
  'pgCode',
  'pgMessage',
  'pgDetails',
  'pgHint',
  'rpc',
  'table',
  'status',
  'retryAfter',
  'field',
  'requestId',
  'supabaseCode'
];

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'string') {
    // Never let a bearer token or a JWT slip through as a plain string.
    if (/^Bearer\s+/i.test(value)) return 'Bearer [redacted]';
    if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(value)) return '[jwt redacted]';
    const clean = scrubSecrets(value);
    return clean.length > 2000 ? `${clean.slice(0, 2000)}…` : clean;
  }
  if (typeof value !== 'object') return value;

  if (value instanceof Error) {
    const out = {
      name: value.name,
      message: scrubSecrets(value.message),
      code: value.code ?? null,
      stack: value.stack?.split('\n').slice(0, 5)
    };
    for (const field of DIAGNOSTIC_FIELDS) {
      if (value[field] === undefined || value[field] === null) continue;
      out[field] = typeof value[field] === 'string' ? scrubSecrets(value[field]) : value[field];
    }
    // Preserve a nested driver error (supabase-js wraps PostgREST payloads).
    if (value.cause) out.cause = redact(value.cause, depth + 1);
    if (value.diagnostic) out.diagnostic = redact(value.diagnostic, depth + 1);
    return out;
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function createLogger({ level = 'info', sink = console, base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...redact(base),
      ...(meta ? redact(meta) : {})
    };
    const line = JSON.stringify(entry);
    if (lvl === 'error') sink.error(line);
    else if (lvl === 'warn') sink.warn(line);
    else sink.log(line);
  };

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (bindings) => createLogger({ level, sink, base: { ...base, ...bindings } })
  };
}

export const silentLogger = createLogger({ level: 'silent' });
