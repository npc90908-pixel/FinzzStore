// ============================================================================
// AUTH SECURITY PRIMITIVES
//
// Password hashing (Argon2id), one-time token generation and Cloudflare
// Turnstile verification. Nothing here logs, returns or stores a secret in
// clear text.
// ============================================================================
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

// OWASP-recommended Argon2id baseline: 19 MiB, 2 iterations, 1 lane.
// Kept deliberately modest so a serverless function can verify inside its
// timeout while still costing an attacker real memory per guess.
export const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
});

/** Hash a password with Argon2id (salt managed by the library). */
export async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false for NULL hashes (accounts created before
 * custom auth) instead of throwing, so the caller can answer with a generic
 * "wrong credentials" message.
 */
export async function verifyPassword(hash, password) {
  if (!hash || typeof hash !== 'string') return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash needs upgrading to current parameters. */
export function needsRehash(hash) {
  if (!hash) return false;
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/** 32 random bytes, base64url — used for password-reset links. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Cryptographically uniform 6-digit OTP (never Math.random). */
export function generateOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** SHA-256 hex; the form every token/OTP is stored in. */
export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time string comparison for hashes. */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Cloudflare Turnstile server-side verification.
 *
 * The widget callback in the browser is NOT proof of anything — only this
 * call decides. Fails closed when the feature is enabled but misconfigured.
 */
export function createTurnstileVerifier(config, { fetchImpl = globalThis.fetch, logger } = {}) {
  const { enabled, secretKey, siteKey, expectedHostname, timeoutMs } = config.turnstile;

  const status = () => ({
    enabled,
    // Never expose the secret; only whether it looks configured.
    configured: Boolean(secretKey && siteKey),
    expectedHostname: expectedHostname || null
  });

  const siteKeyForClient = () => (enabled && siteKey ? siteKey : null);

  /**
   * @returns {Promise<{ok:boolean, code:string|null}>}
   */
  async function verify(token, { ip, action } = {}) {
    if (!enabled) return { ok: true, code: 'TURNSTILE_DISABLED' };

    // Enabled but unconfigured is a deployment error: refuse the request
    // rather than silently letting everything through.
    if (!secretKey || !siteKey) {
      logger?.error?.('turnstile enabled without keys — failing closed');
      return { ok: false, code: 'TURNSTILE_MISCONFIGURED' };
    }
    if (!token) return { ok: false, code: 'TURNSTILE_MISSING' };

    const body = new URLSearchParams({ secret: secretKey, response: String(token) });
    if (ip) body.set('remoteip', ip);

    let payload;
    try {
      const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      payload = await response.json();
    } catch (err) {
      // Timeout or network failure: fail closed for sensitive operations.
      logger?.warn?.('turnstile verification unavailable', { error: err?.message });
      return { ok: false, code: 'TURNSTILE_UNAVAILABLE' };
    }

    if (!payload?.success) {
      return { ok: false, code: 'TURNSTILE_FAILED' };
    }
    if (expectedHostname && payload.hostname && payload.hostname !== expectedHostname) {
      return { ok: false, code: 'TURNSTILE_WRONG_HOST' };
    }
    if (action && payload.action && payload.action !== action) {
      return { ok: false, code: 'TURNSTILE_WRONG_ACTION' };
    }
    return { ok: true, code: null };
  }

  return { verify, status, siteKeyForClient };
}
