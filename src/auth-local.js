// ============================================================================
// AUTH — custom, PostgreSQL-backed authentication.
//
// Supabase Auth is gone. This module owns the whole credential lifecycle:
//
//   register   → Argon2id hash → profiles row + wallet (one RPC transaction)
//              → 6-digit email OTP (HMAC-safe: only the SHA-256 is stored)
//   login      → constant-time verify → session row (cookie holds the raw
//                token, the database holds only its SHA-256)
//   reset      → 32-byte random link, 10 minutes, single use, revokes sessions
//   sessions   → revocable, listable, rotated on login
//
// The public surface matches the previous Supabase-backed service exactly, so
// routes, middlewares and the SPA need no changes.
// ============================================================================
import { AppError, errors } from './errors.js';
import {
  hashPassword, verifyPassword, needsRehash,
  randomToken, generateOtp, sha256, safeEqualHex
} from './auth/security.js';
import { verificationEmail, passwordResetEmail, maskEmail } from './auth/mailer.js';

export function createAuthService({ db, config, logger, mailer, turnstile }) {
  const now = () => Date.now();
  const authConfig = config.auth;

  // --------------------------------------------------------------- helpers
  const sessionExpiry = () => new Date(now() + config.cookie.maxAgeSeconds * 1000).toISOString();

  const publicUser = (profile) => ({
    id: profile.id,
    email: profile.email,
    email_verified_at: profile.email_verified_at,
    username: profile.username
  });

  /** Read the profile, creating it if an admin provisioned the user elsewhere. */
  const readProfile = async (userId, email) => {
    let profile = await db.profiles.get(userId);
    if (!profile) {
      const created = await db.profiles.ensure({ userId, email });
      profile = created.profile;
    }
    return profile;
  };

  /** Create the session row and return the raw tokens for the cookies. */
  const issueSession = async ({ userId, req }) => {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    await db.sessions.create({
      user_id: userId,
      token_hash: sha256(token),
      csrf_hash: sha256(csrfToken),
      ip: req?.ip || null,
      user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 300) || null,
      expires_at: sessionExpiry()
    });
    return { sessionToken: token, csrfToken };
  };

  /** Issue + email a one-time token. Returns false when delivery failed. */
  const issueEmailToken = async ({ userId, email, kind, req }) => {
    const isReset = kind === 'password_reset';
    const raw = isReset ? randomToken(32) : generateOtp();
    const ttl = isReset ? authConfig.resetTtlSeconds : authConfig.otpTtlSeconds;

    // A 6-digit code has only 1e6 possible values, so its hash is bound to the
    // owning account: sha256("<user-id>:<code>"). Two accounts can never share
    // a lookup key, and a stolen hash is useless for another user.
    // Reset tokens are 32 random bytes and need no binding.
    const tokenHash = isReset ? sha256(raw) : sha256(`${userId}:${raw}`);

    await db.call('rpc_issue_auth_token', {
      p_user_id: userId,
      p_kind: kind,
      p_token_hash: tokenHash,
      p_ttl_seconds: ttl,
      p_max_attempts: authConfig.maxAttempts,
      p_ip: req?.ip || null,
      p_user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 300) || null
    });

    const template = isReset
      ? passwordResetEmail({
          // Built from the trusted APP_URL, never from the Host header.
          link: `${config.appUrl}/reset-password?token=${encodeURIComponent(raw)}`,
          appName: config.storeName || 'FINZZ Store',
          ttlMinutes: Math.round(ttl / 60)
        })
      : verificationEmail({
          code: raw,
          appName: config.storeName || 'FINZZ Store',
          ttlMinutes: Math.round(ttl / 60)
        });

    if (!mailer.configured) {
      // Never claim an email was sent when SMTP is absent.
      logger.error('email not sent: SMTP is not configured', { kind });
      return { sent: false, reason: 'SMTP_NOT_CONFIGURED', raw: authConfig.exposeDevTokens ? raw : null };
    }

    try {
      await mailer.send({ to: email, ...template });
      return { sent: true };
    } catch {
      return { sent: false, reason: 'SMTP_FAILED' };
    }
  };

  // ------------------------------------------------- verification context
  //
  // The browser that just registered owns a random token in an HttpOnly
  // cookie; the database only holds its SHA-256. Verification therefore needs
  // a 6-digit code and nothing else — the address is read from the row, never
  // typed by the user. This is what removes the "enter your email again" step
  // without weakening the proof of ownership.
  const VERIFY_COOKIE = config.cookie.verifyName || 'fz_verify';
  const VERIFY_TTL_SECONDS = config.auth.verifyContextTtlSeconds || 1800;
  const RESEND_COOLDOWN_SECONDS = config.auth.resendCooldownSeconds || 60;
  const RESEND_MAX_PER_HOUR = config.auth.resendMaxPerHour || 5;

  const readVerifyCookie = (req) => {
    const header = String(req?.headers?.cookie || '');
    const found = header.split(';').map((p) => p.trim())
      .find((p) => p.startsWith(`${VERIFY_COOKIE}=`));
    if (!found) return null;
    const raw = decodeURIComponent(found.slice(VERIFY_COOKIE.length + 1));
    return raw && raw.length <= 200 ? raw : null;
  };

  /** Create (or replace) the verification context and mail the OTP. */
  const startVerification = async ({ profile, req }) => {
    const raw = randomToken(32);
    const tokenHash = sha256(raw);
    const issued = await db.verifyContexts.issue({
      userId: profile.id,
      tokenHash,
      email: profile.email,
      ttlSeconds: VERIFY_TTL_SECONDS,
      ip: req?.ip || null,
      userAgent: req?.headers?.['user-agent'] || null
    });

    const delivery = await issueEmailToken({
      userId: profile.id, email: profile.email, kind: 'email_verification', req
    });
    // Record the delivery outcome on the context so the UI can say the truth
    // ("email belum terkirim") instead of assuming success.
    await db.verifyContexts
      .markDelivery(tokenHash, delivery.sent, delivery.sent ? null : delivery.reason)
      .catch(() => {});

    return {
      token: raw,
      expiresAt: issued?.expires_at || new Date(now() + VERIFY_TTL_SECONDS * 1000).toISOString(),
      emailSent: delivery.sent,
      deliveryReason: delivery.sent ? null : delivery.reason,
      devToken: delivery.raw || undefined
    };
  };

  const describeContext = (row) => {
    const resendAt = row.last_sent_at
      ? new Date(new Date(row.last_sent_at).getTime() + RESEND_COOLDOWN_SECONDS * 1000).toISOString()
      : null;
    return {
      active: Boolean(row.active),
      expired: Boolean(row.expired),
      consumed: Boolean(row.consumed),
      alreadyVerified: Boolean(row.already_verified),
      emailMasked: maskEmail(row.email),
      expiresAt: row.expires_at,
      lastSentAt: row.last_sent_at,
      emailSent: Boolean(row.email_sent),
      deliveryProblem: row.email_sent ? null : (row.email_error || 'SMTP_NOT_CONFIGURED'),
      resendAt,
      resendCount: row.resend_count ?? 0,
      resendCooldownSeconds: RESEND_COOLDOWN_SECONDS
    };
  };

  // ----------------------------------------------------------------- csrf
  const verifyCsrf = (req, auth) => {
    const header = req.headers['x-csrf-token'];
    if (!header || !auth) return false;
    return safeEqualHex(sha256(String(header)), auth.csrfTokenHash);
  };

  // -------------------------------------------------------------- service
  const service = {
    kind: 'local',

    /** Resolve the cookie session into { session, user, profile }. */
    async attach(req) {
      const cookieHeader = String(req.headers.cookie || '');
      const match = cookieHeader.split(';').map((p) => p.trim())
        .find((p) => p.startsWith(`${config.cookie.name}=`));
      req.sessionState = 'none';
      if (!match) return null;

      const raw = decodeURIComponent(match.slice(config.cookie.name.length + 1));
      if (!raw || raw.length > 200) return null;

      const session = await db.sessions.byTokenHash(sha256(raw));
      if (!session) { req.sessionState = 'expired'; return null; }
      if (session.revoked_at) { req.sessionState = 'expired'; return null; }
      if (new Date(session.expires_at).getTime() < now()) {
        await db.sessions.revoke(session.id).catch(() => {});
        req.sessionState = 'expired';
        return null;
      }

      const profile = await db.profiles.get(session.user_id);
      if (!profile) {
        await db.sessions.revoke(session.id).catch(() => {});
        return null;
      }
      if (profile.status !== 'active') throw errors.accountSuspended();

      // Sliding last-used, at most once every 5 minutes.
      const lastUsed = session.last_used_at ? new Date(session.last_used_at).getTime() : 0;
      if (now() - lastUsed > 5 * 60_000) {
        db.sessions.update(session.id, { last_used_at: new Date().toISOString() }).catch(() => {});
        db.profiles.touch(profile.id).catch(() => {});
      }

      return {
        session,
        user: publicUser(profile),
        profile,
        csrfTokenHash: session.csrf_hash
      };
    },

    async requireUser(req) {
      const auth = await service.attach(req);
      if (!auth) {
        throw req.sessionState === 'expired' ? errors.sessionExpired() : errors.unauthorized();
      }
      if (auth.profile.status !== 'active') throw errors.accountSuspended();
      return auth;
    },

    async requireAdmin(req) {
      const auth = await service.requireUser(req);
      if (auth.profile.role !== 'admin') throw errors.forbidden();
      return auth;
    },

    // ------------------------------------------------------------ register
    async register({ email, password, username, req, turnstileToken }) {
      const captcha = await turnstile.verify(turnstileToken, { ip: req?.ip, action: 'register' });
      if (!captcha.ok) throw errors.badRequest('Verifikasi keamanan gagal. Muat ulang halaman.', captcha.code);

      if (await db.profiles.byEmail(email).catch(() => null)) {
        throw new AppError('EMAIL_TAKEN', 'Email ini sudah terdaftar. Silakan masuk atau reset password.', 409);
      }

      const passwordHash = await hashPassword(password);

      let created;
      try {
        created = await db.call('rpc_register_user', {
          p_email: email,
          p_password_hash: passwordHash,
          p_username: username || null
        });
      } catch (err) {
        // The unique index is the only authority on duplicates (race-safe).
        if (String(err?.pgCode || err?.code) === '23505') {
          throw new AppError('EMAIL_TAKEN', 'Email ini sudah terdaftar. Silakan masuk atau reset password.', 409);
        }
        throw err;
      }

      const profile = created.profile;
      logger.info('user registered', { userId: profile.id, email: maskEmail(email) });

      // Verification is mandatory unless explicitly disabled for local dev.
      if (authConfig.requireEmailVerification) {
        // One call issues the OTP *and* the server-side context, so the next
        // page needs nothing from the user but the six digits.
        const verification = await startVerification({ profile, req });
        return {
          requiresVerification: true,
          email: profile.email,
          emailMasked: maskEmail(profile.email),
          emailSent: verification.emailSent,
          deliveryReason: verification.deliveryReason,
          verifyToken: verification.token,
          verifyExpiresAt: verification.expiresAt,
          devToken: verification.devToken
        };
      }

      const tokens = await issueSession({ userId: profile.id, req });
      return { requiresVerification: false, user: publicUser(profile), profile, ...tokens };
    },

    // --------------------------------------------------------------- login
    async login({ email, password, req, turnstileToken }) {
      const captcha = await turnstile.verify(turnstileToken, { ip: req?.ip, action: 'login' });
      if (!captcha.ok) throw errors.badRequest('Verifikasi keamanan gagal. Muat ulang halaman.', captcha.code);

      const row = await db.profiles.byEmailWithSecret(email);
      // Constant-ish work either way: hash a dummy so a missing account does not
      // answer measurably faster than a wrong password.
      const hash = row?.password_hash || '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const valid = await verifyPassword(hash, password);

      if (!row || !valid) {
        if (row) {
          await db.call('rpc_note_login', {
            p_user_id: row.id, p_success: false,
            p_max_failures: authConfig.maxFailedLogins,
            p_lock_seconds: authConfig.lockSeconds
          }).catch(() => {});
        }
        throw new AppError('INVALID_CREDENTIALS', 'Email atau password salah.', 401);
      }

      if (row.locked_until && new Date(row.locked_until).getTime() > now()) {
        const retryAfter = Math.ceil((new Date(row.locked_until).getTime() - now()) / 1000);
        throw new AppError('ACCOUNT_LOCKED', 'Terlalu banyak percobaan. Coba lagi nanti.', 429, { retryAfter });
      }
      if (row.status !== 'active') throw errors.accountSuspended();

      if (authConfig.requireEmailVerification && !row.email_verified_at) {
        // No session for an unverified account, but do not dead-end the user:
        // resume (or create) the verification context so the verify page can
        // open straight away with the masked address already filled in.
        const profile = await readProfile(row.id, row.email);
        const context = await service.readVerificationContext(req);
        const verification = context.present && context.active
          ? { resume: true, ...context }
          : await startVerification({ profile, req }).then((v) => ({
              resume: false,
              active: true,
              emailMasked: maskEmail(profile.email),
              expiresAt: v.expiresAt,
              emailSent: v.emailSent,
              deliveryProblem: v.emailSent ? null : v.deliveryReason,
              resendAt: new Date(now() + 0).toISOString(),
              verifyToken: v.token
            }));
        throw new AppError(
          'EMAIL_NOT_VERIFIED',
          'Email belum diverifikasi. Kami sudah menyiapkan halaman verifikasi untuk Anda.',
          403,
          { verification }
        );
      }

      await db.call('rpc_note_login', { p_user_id: row.id, p_success: true }).catch(() => {});

      if (needsRehash(row.password_hash)) {
        const upgraded = await hashPassword(password);
        await db.query('update public.profiles set password_hash = $2, password_updated_at = now() where id = $1',
          [row.id, upgraded], { table: 'profiles' }).catch(() => {});
      }

      const profile = await readProfile(row.id, row.email);
      const tokens = await issueSession({ userId: row.id, req });
      logger.info('user signed in', { userId: row.id });
      return { user: publicUser(profile), profile, ...tokens };
    },

    // ----------------------------------------------------- OAuth (Google)
    // The provider has already proved ownership of a verified email, so this
    // path neither asks for a password nor an OTP. An existing account is
    // matched by email; a first-time visitor gets a normal profile + wallet
    // with an unguessable random password (reset password still works later).
    async loginWithProvider({ provider, email, name, req }) {
      const normalised = String(email || '').trim().toLowerCase();
      if (!normalised) throw new AppError('OAUTH_PROFILE_INVALID', 'Profil penyedia login tidak valid.', 400);

      const existing = await db.profiles.byEmailWithSecret(normalised);
      if (existing) {
        if (existing.status !== 'active') throw errors.accountSuspended();
        if (!existing.email_verified_at) {
          await db.profiles.markEmailVerified(existing.id);
        }
        await db.call('rpc_note_login', { p_user_id: existing.id, p_success: true }).catch(() => {});
        const profile = await readProfile(existing.id, existing.email);
        const tokens = await issueSession({ userId: existing.id, req });
        logger.info('provider sign-in', { provider, userId: existing.id });
        return { user: publicUser(profile), profile, ...tokens, created: false };
      }

      const randomPassword = randomToken(24);
      const passwordHash = await hashPassword(randomPassword);
      const localPart = (normalised.split('@')[0] || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 18) || 'user';
      const candidates = [
        localPart.padEnd(3, '1').slice(0, 24),
        ...Array.from({ length: 4 }, (_, i) => `${localPart.slice(0, 16)}_${i + 2}`)
      ];

      let created = null;
      for (const username of candidates) {
        try {
          created = await db.call('rpc_register_user', {
            p_email: normalised,
            p_password_hash: passwordHash,
            p_username: username
          });
          break;
        } catch (err) {
          const code = String(err?.pgCode || err?.code || '');
          if (code !== '23505' && code !== 'EMAIL_TAKEN') throw err;
          // Either the email row appeared in a race, or only the username
          // collided. Re-check by email; otherwise try the next candidate.
          const raced = await db.profiles.byEmailWithSecret(normalised);
          if (raced) {
            if (raced.status !== 'active') throw errors.accountSuspended();
            await db.profiles.markEmailVerified(raced.id);
            const profile = await readProfile(raced.id, raced.email);
            const tokens = await issueSession({ userId: raced.id, req });
            logger.info('provider sign-in after race', { provider, userId: raced.id });
            return { user: publicUser(profile), profile, ...tokens, created: false };
          }
        }
      }
      if (!created) {
        throw new AppError('OAUTH_SIGNUP_FAILED', 'Akun tidak dapat dibuat dari login Google. Coba lagi.', 500);
      }

      const profile = created.profile;
      await db.profiles.markEmailVerified(profile.id);
      if (name) {
        await db.profiles.update(profile.id, { full_name: name }).catch(() => {});
      }
      const verifiedProfile = await readProfile(profile.id, normalised);
      const tokens = await issueSession({ userId: profile.id, req });
      logger.info('provider account created', { provider, userId: profile.id });
      return { user: publicUser(verifiedProfile), profile: verifiedProfile, ...tokens, created: true };
    },

    // -------------------------------------------------------------- logout
    async logout(req) {
      const auth = await service.attach(req);
      if (auth) await db.sessions.revoke(auth.session.id).catch(() => {});
    },

    async logoutAll(userId, exceptSessionId = null) {
      const { rows } = await db.sessions.listForUser(userId, { limit: 100 });
      for (const s of rows) {
        if (s.id !== exceptSessionId) await db.sessions.revoke(s.id);
      }
      if (!rows.length) await db.sessions.revokeAllForUser(userId);
    },

    /** Sliding renewal: keeps the same session row, rotates the CSRF token. */
    async refresh(auth) {
      const csrfToken = randomToken(24);
      const expiresAt = sessionExpiry();
      await db.sessions.update(auth.session.id, {
        csrf_hash: sha256(csrfToken),
        expires_at: expiresAt,
        last_used_at: new Date().toISOString()
      });
      return {
        user: { id: auth.profile.id, email: auth.profile.email, username: auth.profile.username, role: auth.profile.role },
        csrfToken,
        expiresAt
      };
    },

    // ------------------------------------------------------ email verification
    /** Read the context behind the cookie (used by the verify page). */
    async readVerificationContext(req) {
      const raw = readVerifyCookie(req);
      if (!raw) return { present: false };
      const row = await db.verifyContexts.read(sha256(raw));
      if (!row?.ok) return { present: false, stale: true };
      return { present: true, ...describeContext(row) };
    },

    /**
     * Re-send the OTP using the cookie context. The cooldown is claimed
     * atomically in the database, so two tabs (or two serverless instances)
     * cannot both send at the same instant.
     */
    async resendVerificationForContext(req) {
      const raw = readVerifyCookie(req);
      if (!raw) return { ok: false, reason: 'NO_CONTEXT' };
      const tokenHash = sha256(raw);
      const claim = await db.verifyContexts.claimResend(tokenHash, {
        cooldownSeconds: RESEND_COOLDOWN_SECONDS,
        maxPerHour: RESEND_MAX_PER_HOUR
      });
      if (!claim?.ok) {
        return { ok: false, reason: claim?.reason || 'NOT_ALLOWED', retryAfter: claim?.retry_after ?? null };
      }
      const row = await db.verifyContexts.read(tokenHash);
      if (!row?.ok) return { ok: false, reason: 'NO_CONTEXT' };
      if (row.already_verified) return { ok: false, reason: 'ALREADY_VERIFIED' };

      const delivery = await issueEmailToken({
        userId: row.user_id, email: row.email, kind: 'email_verification', req
      });
      await db.verifyContexts
        .markDelivery(tokenHash, delivery.sent, delivery.sent ? null : delivery.reason)
        .catch(() => {});
      logger.info('verification code resent', { userId: row.user_id, sent: delivery.sent });
      return {
        ok: true,
        emailSent: delivery.sent,
        deliveryReason: delivery.sent ? null : delivery.reason,
        emailMasked: maskEmail(row.email),
        resendAt: new Date(now() + RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
        expiresAt: row.expires_at
      };
    },

    async verifyEmail({ email, code, req }) {
      const raw = String(code || '').trim();
      if (!/^\d{6}$/.test(raw)) {
        throw new AppError('INVALID_TOKEN', 'Kode verifikasi tidak valid.', 400);
      }
      // Who owns this code? Preferred answer: the server-side context behind
      // the HttpOnly cookie. The address is then never supplied by the browser.
      let owner = null;
      let contextHash = null;
      const rawContext = readVerifyCookie(req);
      if (rawContext) {
        const candidate = sha256(rawContext);
        const row = await db.verifyContexts.read(candidate);
        if (row?.ok && row.active) {
          owner = await db.profiles.byEmailWithSecret(row.email).catch(() => null);
          contextHash = candidate;
        }
      }
      // Legacy path (no cookie): the caller may still pass an email. Kept so a
      // user who lost the cookie — or an API client — is not locked out.
      if (!owner && email) {
        owner = await db.profiles.byEmailWithSecret(email).catch(() => null);
      }
      if (!owner) {
        // Same generic answer and the same work for unknown/garbage input.
        await hashPassword('dummy-password-to-equalise-timing');
        throw new AppError('INVALID_TOKEN', 'Kode verifikasi tidak valid atau sudah dipakai.', 400);
      }
      // The RPC returns {ok:false, reason} for expected failures instead of
      // raising, because a RAISE would roll back the attempt counter it just
      // incremented (see migration 004).
      const result = await db.call('rpc_consume_email_token', {
        p_token_hash: sha256(`${owner.id}:${raw}`),
        p_kind: 'email_verification',
        p_user_id: owner.id
      });

      if (!result?.ok) {
        switch (result?.reason) {
          case 'TOKEN_EXPIRED':
            throw new AppError('TOKEN_EXPIRED', 'Kode sudah kedaluwarsa. Minta kode baru.', 400);
          case 'TOKEN_ATTEMPTS_EXCEEDED':
            throw new AppError('TOKEN_ATTEMPTS_EXCEEDED', 'Terlalu banyak percobaan. Minta kode baru.', 429);
          default:
            throw new AppError(
              'INVALID_TOKEN',
              typeof result?.attempts_remaining === 'number' && result.attempts_remaining > 0
                ? `Kode verifikasi salah. Sisa percobaan: ${result.attempts_remaining}.`
                : 'Kode verifikasi tidak valid atau sudah dipakai.',
              400
            );
        }
      }

      const profile = await readProfile(result.user_id, result.email);
      const tokens = await issueSession({ userId: profile.id, req });
      if (contextHash) await db.verifyContexts.consume(contextHash).catch(() => {});
      logger.info('email verified', { userId: profile.id });
      return { verified: true, profile, ...tokens, requiresLogin: false, clearVerifyCookie: Boolean(rawContext) };
    },

    async resendVerification(email) {
      const row = await db.profiles.byEmailWithSecret(email).catch(() => null);
      // Never disclose whether the address exists.
      if (!row || row.email_verified_at) return { sent: true, skipped: true };
      const delivery = await issueEmailToken({
        userId: row.id, email: row.email, kind: 'email_verification', req: null
      });
      return { sent: delivery.sent, reason: delivery.reason, devToken: delivery.raw || undefined };
    },

    // ---------------------------------------------------------- password reset
    /**
     * Always answers the same way. The token is only generated for an eligible
     * account, and the raw value never leaves the server except through SMTP.
     */
    async requestPasswordReset(email, { req, turnstileToken } = {}) {
      const captcha = await turnstile.verify(turnstileToken, { ip: req?.ip, action: 'forgot_password' });
      if (!captcha.ok) throw errors.badRequest('Verifikasi keamanan gagal. Muat ulang halaman.', captcha.code);

      const row = await db.profiles.byEmailWithSecret(email).catch(() => null);
      if (!row || row.status !== 'active') return { sent: true };

      const delivery = await issueEmailToken({
        userId: row.id, email: row.email, kind: 'password_reset', req
      });

      if (!delivery.sent) {
        // Honest failure: the operator must see that mail is broken.
        logger.error('password reset email not delivered', { userId: row.id, reason: delivery.reason });
      }
      return { sent: delivery.sent, devResetToken: delivery.raw || undefined };
    },

    async resetPassword({ token, password }) {
      if (!token) throw errors.badRequest('Token reset tidak ditemukan.');
      const passwordHash = await hashPassword(password);
      try {
        const result = await db.call('rpc_complete_password_reset', {
          p_token_hash: sha256(String(token)),
          p_password_hash: passwordHash
        });
        logger.info('password reset completed', { userId: result.user_id });
        return { ok: true };
      } catch (err) {
        const message = String(err?.message || '');
        if (message.includes('TOKEN_EXPIRED')) {
          throw new AppError('TOKEN_EXPIRED', 'Tautan reset sudah kedaluwarsa. Minta tautan baru.', 400);
        }
        throw new AppError('INVALID_TOKEN', 'Tautan reset tidak valid atau sudah dipakai.', 400);
      }
    },

    /** Inspect a reset token without consuming it (for the reset page). */
    async inspectResetToken(token) {
      if (!token) return { valid: false, reason: 'MISSING' };
      const { rows } = await db.query(
        `select expires_at, consumed_at from public.auth_tokens
          where token_hash = $1 and kind = 'password_reset'
          order by created_at desc limit 1`,
        [sha256(String(token))], { table: 'auth_tokens' }
      );
      const row = rows[0];
      if (!row) return { valid: false, reason: 'INVALID' };
      if (row.consumed_at) return { valid: false, reason: 'USED' };
      if (new Date(row.expires_at).getTime() < now()) return { valid: false, reason: 'EXPIRED' };
      return { valid: true, expiresAt: row.expires_at };
    },

    // ----------------------------------------------------------- change password
    async changePassword({ auth, currentPassword, newPassword }) {
      const row = await db.profiles.byEmailWithSecret(auth.profile.email);
      const valid = row ? await verifyPassword(row.password_hash, currentPassword) : false;
      if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Password saat ini salah.', 401);

      const passwordHash = await hashPassword(newPassword);
      await db.query(
        'update public.profiles set password_hash = $2, password_updated_at = now() where id = $1',
        [auth.profile.id, passwordHash], { table: 'profiles' }
      );
      // Keep the current device signed in, drop the rest.
      await db.sessions.revokeAllForUser(auth.profile.id).catch(() => {});
      await db.sessions.update(auth.session.id, { revoked_at: null }).catch(() => {});
      logger.info('password changed', { userId: auth.profile.id });
      return { ok: true };
    },

    verifyCsrf,

    async cleanup() {
      await db.sessions.deleteExpired();
    }
  };

  return service;
}
