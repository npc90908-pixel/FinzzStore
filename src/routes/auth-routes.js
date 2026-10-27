// ============================================================================
// AUTH ROUTES — custom authentication (Argon2id + emailed one-time codes).
// The browser only ever sees an HttpOnly session cookie; password hashes, OTP
// codes and reset tokens never appear in any response or log.
// ============================================================================
import * as v from '../validation.js';
import { setSessionCookies, setCsrfCookie, clearSessionCookies, sendNoContent, setVerifyCookie, clearVerifyCookie } from '../http.js';
import { enforceLimit, ok, created } from './helpers.js';
import { AppError, errors } from '../errors.js';

export function registerAuthRoutes({ router }) {

  router.post(
    '/api/auth/register',
    async (ctx) => {
      await enforceLimit(ctx, `register:${ctx.ip}`, 5, 10 * 60, { critical: true });
      const body = await ctx.readJson({ limit: 8 * 1024 });
      const email = v.email(body.email);
      const password = v.password(body.password);
      const username = v.username(body.username);

      // Cloudflare Turnstile: the token is verified server-side and the check
      // fails closed (see createTurnstileVerifier).
      const result = await ctx.services.auth.register({
        email, password, username, req: ctx.req,
        turnstileToken: body.turnstile_token || null
      });

      if (result.requiresVerification) {
        // The proof-of-registration cookie is issued here, so the next page
        // needs no email from the user. `emailSent` stays honest: when SMTP is
        // down the API must not imply that an email went out.
        if (result.verifyToken) {
          setVerifyCookie(ctx.res, ctx.config, result.verifyToken, ctx.config.auth.verifyContextTtlSeconds);
        }
        return created({
          requiresVerification: true,
          email,
          emailMasked: result.emailMasked,
          emailSent: result.emailSent !== false,
          deliveryProblem: result.deliveryReason || null,
          verification: {
            active: true,
            emailMasked: result.emailMasked,
            expiresAt: result.verifyExpiresAt,
            emailSent: result.emailSent !== false,
            deliveryProblem: result.deliveryReason || null,
            resendAt: new Date().toISOString(),
            resendCooldownSeconds: ctx.config.auth.resendCooldownSeconds
          },
          ...(result.emailSent === false
            ? { message: 'Pendaftaran berhasil, tetapi email verifikasi belum terkirim. Gunakan tombol kirim ulang, atau hubungi admin.' }
            : { message: 'Pendaftaran berhasil. Masukkan 6 digit kode dari email Anda.' }),
          ...(result.devToken ? { devToken: result.devToken } : {})
        });
      }

      setSessionCookies(ctx.res, ctx.config, result);
      return created({
        requiresVerification: false,
        user: {
          id: result.profile.id,
          email: result.profile.email,
          username: result.profile.username,
          role: result.profile.role
        }
      });
    },
    { public: true }
  );

  router.post(
    '/api/auth/login',
    async (ctx) => {
      const body = await ctx.readJson({ limit: 8 * 1024 });
      const email = v.email(body.email);
      v.password(body.password);
      // Two buckets: per IP (bot floods) and per account (credential stuffing).
      await enforceLimit(ctx, `login:ip:${ctx.ip}`, 15, 10 * 60, { critical: true });
      await enforceLimit(ctx, `login:acct:${email}`, 8, 10 * 60, { critical: true });

      let result;
      try {
        result = await ctx.services.auth.login({
          email, password: body.password, req: ctx.req,
          turnstileToken: body.turnstile_token || null
        });
      } catch (err) {
        // Unverified account: the service prepared a verification context, so
        // seal the cookie here — the client then continues to /verify-email
        // without retyping anything.
        const token = err?.verification?.verifyToken;
        if (token) {
          setVerifyCookie(ctx.res, ctx.config, token, ctx.config.auth.verifyContextTtlSeconds);
          delete err.verification.verifyToken;
        }
        throw err;
      }
      setSessionCookies(ctx.res, ctx.config, result);
      return ok({
        user: {
          id: result.profile.id,
          email: result.profile.email,
          username: result.profile.username,
          role: result.profile.role
        }
      });
    },
    { public: true }
  );

  // Session refresh: slides the cookie window and rotates the CSRF token so a
  // long-lived tab keeps working without a re-login. The session id is reused.
  router.post('/api/auth/refresh', async (ctx) => {
    const auth = await ctx.requireUser();
    await enforceLimit(ctx, `session:refresh:${auth.profile.id}`, 30, 10 * 60);
    const refreshed = await ctx.services.auth.refresh(auth);
    setCsrfCookie(ctx.res, ctx.config, refreshed.csrfToken);
    return ok({
      user: refreshed.user,
      csrfToken: refreshed.csrfToken,
      expiresAt: refreshed.expiresAt
    });
  });

  router.post('/api/auth/logout', async (ctx) => {
    await ctx.services.auth.logout(ctx.req);
    clearSessionCookies(ctx.res, ctx.config);
    sendNoContent(ctx.res);
  });

  router.get('/api/auth/session', async (ctx) => {
    const session = await ctx.requireUser();
    return ok({
      user: {
        id: session.profile.id,
        email: session.profile.email,
        username: session.profile.username,
        fullName: session.profile.full_name,
        phone: session.profile.phone,
        role: session.profile.role,
        status: session.profile.status,
        createdAt: session.profile.created_at
      },
      session: {
        createdAt: session.session.created_at,
        expiresAt: session.session.expires_at,
        userAgent: session.session.user_agent
      }
    });
  });

  router.post(
    '/api/auth/forgot-password',
    async (ctx) => {
      const body = await ctx.readJson({ limit: 4 * 1024 });
      const email = v.email(body.email);
      await enforceLimit(ctx, `forgot:ip:${ctx.ip}`, 5, 15 * 60, { critical: true });
      await enforceLimit(ctx, `forgot:acct:${email}`, 3, 15 * 60, { critical: true });

      const result = await ctx.services.auth.requestPasswordReset(email, {
        req: ctx.req,
        turnstileToken: body.turnstile_token || null
      });
      // Always the same response: never disclose whether the account exists.
      return ok({
        message: 'Jika email terdaftar, tautan reset password telah dikirim.',
        // Only when AUTH_EXPOSE_DEV_TOKENS is on outside production; the
        // production config refuses that flag at boot.
        ...(result.devResetToken ? { devResetToken: result.devResetToken } : {})
      });
    },
    { public: true }
  );

  // GET /api/auth/reset-password/validate?token=… — lets the reset page say
  // "tautan kedaluwarsa" before the user types a new password. Read-only: it
  // never consumes the token and never reveals whose account it belongs to.
  router.get(
    '/api/auth/reset-password/validate',
    async (ctx) => {
      await enforceLimit(ctx, `resetcheck:ip:${ctx.ip}`, 30, 15 * 60);
      const token = v.string(ctx.query.get('token') || '', { field: 'token', max: 512, optional: true });
      const result = await ctx.services.auth.inspectResetToken(token);
      return ok(result);
    },
    { public: true }
  );

  router.post(
    '/api/auth/reset-password',
    async (ctx) => {
      const body = await ctx.readJson({ limit: 8 * 1024 });
      const password = v.password(body.password);
      const token = v.string(body.token || '', { field: 'token', max: 512 });
      await enforceLimit(ctx, `reset:ip:${ctx.ip}`, 10, 15 * 60, { critical: true });
      const result = await ctx.services.auth.resetPassword({ token, password });
      return ok({ message: 'Password berhasil diperbarui. Silakan masuk kembali.', ...result });
    },
    { public: true }
  );

  router.post(
    '/api/auth/verify-email',
    async (ctx) => {
      const body = await ctx.readJson({ limit: 8 * 1024 });
      // Per-IP and per-email buckets: a 6-digit code is short enough that
      // unlimited guesses would eventually succeed.
      await enforceLimit(ctx, `verify:ip:${ctx.ip}`, 20, 15 * 60, { critical: true });
      // `email` is now optional: the owning account comes from the
      // proof-of-registration cookie. It stays accepted for API clients and for
      // users whose cookie expired, but it is no longer the normal path.
      const email = body.email ? v.email(body.email) : null;
      if (email) await enforceLimit(ctx, `verify:acct:${email}`, 8, 15 * 60, { critical: true });
      const code = v.string(body.code, { field: 'code', max: 12 });

      const result = await ctx.services.auth.verifyEmail({ email, code, req: ctx.req });
      if (result.sessionToken) {
        setSessionCookies(ctx.res, ctx.config, { sessionToken: result.sessionToken, csrfToken: result.csrfToken });
      }
      if (result.clearVerifyCookie) clearVerifyCookie(ctx.res, ctx.config);
      // Welcome notice. This is a verified event (the account really did become
      // verified in this request), and it is the only application-level
      // notification in the system; everything else comes from DB triggers.
      if (result.profile?.id) {
        ctx.services.notifications?.announce({
          userId: result.profile.id,
          type: 'account.verified',
          severity: 'success',
          title: 'Email terverifikasi',
          body: 'Akun Anda aktif. Anda sekarang bisa membeli nomor dan mengajukan deposit.'
        });
      }
      return ok({
        verified: true,
        requiresLogin: Boolean(result.requiresLogin),
        user: result.profile
          ? { id: result.profile.id, email: result.profile.email, username: result.profile.username, role: result.profile.role }
          : undefined,
        message: 'Email berhasil diverifikasi.'
      });
    },
    { public: true }
  );

  // The verify page asks this on load: "who am I verifying?" The answer comes
  // from the HttpOnly cookie, so no email is ever typed by the browser.
  router.get(
    '/api/auth/verification-context',
    async (ctx) => {
      const context = await ctx.services.auth.readVerificationContext(ctx.req);
      if (!context.present) {
        // `stale` means a cookie existed but no longer resolves. Clearing it
        // avoids a confusing loop where the page looks signed-in-but-not.
        if (context.stale) clearVerifyCookie(ctx.res, ctx.config);
        return ok({ present: false, active: false, reason: 'NO_CONTEXT' });
      }
      if (context.alreadyVerified) {
        clearVerifyCookie(ctx.res, ctx.config);
        return ok({ present: true, active: false, alreadyVerified: true, emailMasked: context.emailMasked });
      }
      return ok({ present: true, ...context });
    },
    { public: true }
  );

  router.post(
    '/api/auth/resend-verification',
    async (ctx) => {
      const body = await ctx.readJson({ limit: 4 * 1024 }).catch(() => ({}));
      await enforceLimit(ctx, `resend:ip:${ctx.ip}`, 5, 15 * 60, { critical: true });

      // Preferred path: the cookie context. Its cooldown is claimed atomically
      // in PostgreSQL, so simultaneous requests cannot each trigger a send.
      if (!body.email) {
        const outcome = await ctx.services.auth.resendVerificationForContext(ctx.req);
        if (!outcome.ok) {
          const map = {
            NO_CONTEXT: ['VERIFY_CONTEXT_MISSING', 'Sesi verifikasi tidak ditemukan. Silakan masuk untuk melanjutkan.', 401],
            CONTEXT_EXPIRED: ['VERIFY_CONTEXT_EXPIRED', 'Waktu verifikasi sudah habis. Silakan masuk untuk memulai lagi.', 410],
            ALREADY_VERIFIED: ['ALREADY_VERIFIED', 'Email Anda sudah terverifikasi. Silakan masuk.', 409],
            COOLDOWN: ['RESEND_COOLDOWN', `Tunggu ${outcome.retryAfter} detik sebelum meminta kode lagi.`, 429],
            RESEND_LIMIT: ['RESEND_LIMIT', 'Batas kirim ulang tercapai. Coba lagi nanti atau hubungi admin.', 429]
          };
          const [codeName, message, status] = map[outcome.reason] || ['RESEND_FAILED', 'Tidak dapat mengirim ulang saat ini.', 400];
          throw new AppError(codeName, message, status, { retryAfter: outcome.retryAfter ?? null });
        }
        return ok({
          emailMasked: outcome.emailMasked,
          emailSent: outcome.emailSent,
          deliveryProblem: outcome.deliveryReason || null,
          resendAt: outcome.resendAt,
          expiresAt: outcome.expiresAt,
          message: outcome.emailSent
            ? 'Kode baru sudah dikirim ke email Anda.'
            : 'Kode baru dibuat, tetapi email belum terkirim. Hubungi admin bila berulang.'
        });
      }

      // Legacy path (explicit email). Never discloses whether the address exists.
      const email = v.email(body.email);
      await enforceLimit(ctx, `resend:acct:${email}`, 3, 15 * 60, { critical: true });
      await ctx.services.auth.resendVerification(email);
      return ok({ message: 'Jika email terdaftar dan belum diverifikasi, email verifikasi baru telah dikirim.' });
    },
    { public: true }
  );

  router.post('/api/auth/change-password', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `chpw:${session.user.id}`, 5, 15 * 60, { critical: true });
    const body = await ctx.readJson({ limit: 8 * 1024 });
    const currentPassword = v.password(body.current_password, { field: 'current_password' });
    const newPassword = v.password(body.new_password, { field: 'new_password' });
    if (currentPassword === newPassword) {
      throw errors.badRequest('Password baru harus berbeda dari password saat ini.', 'SAME_PASSWORD');
    }
    await ctx.services.auth.changePassword({ auth: session, currentPassword, newPassword });
    return ok({ message: 'Password berhasil diubah. Sesi lain telah diakhiri.' });
  });

  router.post('/api/auth/logout-all', async (ctx) => {
    const session = await ctx.requireUser();
    await ctx.services.auth.logoutAll(session.user.id, session.session.id);
    return ok({ message: 'Semua sesi lain telah diakhiri.' });
  });
}
