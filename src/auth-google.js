// ============================================================================
// GOOGLE OIDC — server-side authorization-code flow.
//
// Uses the existing FINZZ session system. State + PKCE + nonce are one-time
// HttpOnly cookies; the ID token signature and OIDC claims (iss, aud, exp, iat,
// nonce, sub, verified email) are checked before an identity is used. Provider
// tokens are never stored, returned to the browser, or logged.
// ============================================================================
import { createPublicKey, verify as verifySignature, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const SCOPE = 'openid email profile';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google melebihi batas ukuran.', 502);
  }
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google melebihi batas ukuran.', 502);
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    const text = await readBoundedText(response);
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new AppError(
        'OAUTH_PROVIDER_FAILED',
        'Login Google gagal diproses. Coba lagi atau masuk dengan password.',
        502,
        { providerStatus: response.status }
      );
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google tidak valid.', 502);
    }
    return { payload, headers: response.headers };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      'OAUTH_PROVIDER_UNREACHABLE',
      'Tidak dapat menghubungi Google untuk login. Coba lagi nanti.',
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

function decodeJwtPart(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cacheSeconds(headers) {
  const header = String(headers.get('cache-control') || '');
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header);
  return match ? Math.max(60, Math.min(86_400, Number(match[1]))) : 3600;
}

export function createGoogleOAuth(config, { logger, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const oauth = config.oauth;
  let jwksCache = null;

  async function getGoogleKeys() {
    if (jwksCache && jwksCache.expiresAt > now()) return jwksCache.keys;
    const { payload, headers } = await fetchJson(fetchImpl, JWKS_ENDPOINT, {
      headers: { Accept: 'application/json' }
    });
    if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
      throw new AppError('OAUTH_PROVIDER_FAILED', 'Kunci verifikasi Google tidak valid.', 502);
    }
    jwksCache = { keys: payload.keys, expiresAt: now() + cacheSeconds(headers) * 1000 };
    return jwksCache.keys;
  }

  async function verifyIdToken(idToken, expectedNonce) {
    if (typeof idToken !== 'string' || idToken.length > 20_000 || !expectedNonce) {
      throw new AppError('OAUTH_PROFILE_INVALID', 'Respons login Google tidak lengkap.', 502);
    }
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new AppError('OAUTH_PROFILE_INVALID', 'ID token Google tidak valid.', 502);
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new AppError('OAUTH_PROFILE_INVALID', 'ID token Google tidak valid.', 502);
    }

    const keys = await getGoogleKeys();
    const jwk = keys.find((candidate) => candidate?.kid === header.kid && candidate?.kty === 'RSA');
    if (!jwk) throw new AppError('OAUTH_PROVIDER_FAILED', 'Kunci tanda tangan Google tidak ditemukan.', 502);

    let validSignature = false;
    try {
      const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
      validSignature = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], 'base64url')
      );
    } catch {
      validSignature = false;
    }
    if (!validSignature) throw new AppError('OAUTH_PROFILE_INVALID', 'Tanda tangan ID token Google tidak valid.', 401);

    const currentSeconds = Math.floor(now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const issuerValid = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    const audienceValid = audiences.includes(oauth.clientId)
      && (!claims.azp || claims.azp === oauth.clientId)
      && (audiences.length <= 1 || claims.azp === oauth.clientId);
    const timeValid = Number.isFinite(Number(claims.exp))
      && Number(claims.exp) > currentSeconds
      && Number.isFinite(Number(claims.iat))
      && Number(claims.iat) <= currentSeconds + 60;
    const nonceValid = timingSafeStringEqual(claims.nonce, expectedNonce);
    const email = String(claims.email || '').trim().toLowerCase();
    const verifiedEmail = claims.email_verified === true || claims.email_verified === 'true';
    const subject = String(claims.sub || '').trim();

    if (!issuerValid || !audienceValid || !timeValid || !nonceValid) {
      logger?.warn?.('google oidc claims rejected', {
        issuerValid, audienceValid, timeValid, nonceValid
      });
      throw new AppError('OAUTH_PROFILE_INVALID', 'Klaim login Google tidak valid atau sudah kedaluwarsa.', 401);
    }
    if (!subject || subject.length > 255 || !email || email.length > 254 || !verifiedEmail) {
      logger?.warn?.('google oidc verified identity missing', { hasSubject: Boolean(subject), hasEmail: Boolean(email), verifiedEmail });
      throw new AppError('OAUTH_EMAIL_UNVERIFIED', 'Email Google belum terverifikasi. Gunakan cara masuk lain.', 401);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('OAUTH_PROFILE_INVALID', 'Alamat email Google tidak valid.', 401);
    }

    return {
      provider: 'google',
      providerSubject: subject,
      email,
      name: String(claims.name || '').slice(0, 80) || null
    };
  }

  return {
    get available() {
      return Boolean(oauth.available);
    },

    /** URL consent. Nonce is bound to the one-time state cookies by the route. */
    authorizeUrl({ state, codeChallenge, nonce }) {
      const params = new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: oauth.redirectUri,
        response_type: 'code',
        scope: SCOPE,
        state,
        nonce,
        prompt: 'select_account',
        access_type: 'online',
        include_granted_scopes: 'true',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
    },

    /** Exchange an authorization code and validate the signed OIDC ID token. */
    async authenticate(code, codeVerifier, nonce) {
      const { payload } = await fetchJson(fetchImpl, TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code: String(code || ''),
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          redirect_uri: oauth.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: String(codeVerifier || '')
        }).toString()
      });
      if (!payload.id_token) {
        throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google tidak berisi ID token.', 502);
      }
      return verifyIdToken(payload.id_token, nonce);
    }
  };
}
