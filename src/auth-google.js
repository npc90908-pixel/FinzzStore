// ============================================================================
// GOOGLE OAUTH 2.0 — server-side authorization-code exchange.
//
// The browser only ever sees a normal 302 redirect; tokens are exchanged and
// kept on the server. Every outbound call has a hard timeout and a bounded
// payload so a stalling Google endpoint can never pin a serverless instance.
// When OAuth is not configured nothing here is reachable: the routes return
// 404 and the login button is not rendered.
// ============================================================================
import { AppError } from './errors.js';

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'openid email profile';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google melebihi batas ukuran.', 502);
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
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
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
    return payload || {};
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

export function createGoogleOAuth(config, { logger } = { logger: null }) {
  const oauth = config.oauth;

  return {
    get available() {
      return Boolean(oauth.available);
    },

    /** URL halaman consent Google. `state` melindungi dari CSRF lewat cookie. */
    authorizeUrl({ state, codeChallenge }) {
      const params = new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: oauth.redirectUri,
        response_type: 'code',
        scope: SCOPE,
        state,
        // Fresh account picker every time: shared devices never silently reuse
        // whichever Google profile was logged in before.
        prompt: 'select_account',
        access_type: 'online',
        include_granted_scopes: 'true',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
    },

    /** Tukar code dengan access token, lalu ambil profil terverifikasi. */
    async authenticate(code, codeVerifier) {
      const tokenPayload = await fetchJson(TOKEN_ENDPOINT, {
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

      const accessToken = tokenPayload.access_token;
      if (!accessToken) {
        throw new AppError('OAUTH_PROVIDER_FAILED', 'Respons Google tidak berisi token akses.', 502);
      }

      const profile = await fetchJson(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      });

      const email = String(profile.email || '').trim().toLowerCase();
      // Google guarantees email_verified for hosted/Gmail accounts; treat an
      // unverified assertion as a hard failure instead of provisioning a ghost
      // account on an address nobody proved they own.
      const providerSubject = String(profile.sub || '').trim();
      if (!email || profile.email_verified !== true) {
        logger?.warn?.('google oauth: unverified or missing email claim', { hasEmail: Boolean(email) });
        throw new AppError('OAUTH_EMAIL_UNVERIFIED', 'Email Google belum terverifikasi. Gunakan cara masuk lain.', 401);
      }
      if (!providerSubject) {
        throw new AppError('OAUTH_PROFILE_INVALID', 'Profil login Google tidak lengkap.', 502);
      }

      return {
        provider: 'google',
        email,
        name: String(profile.name || '').slice(0, 80) || null
      };
    }
  };
}
