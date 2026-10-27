// ============================================================================
// WALLET, DEPOSIT AND PROFILE ROUTES
// ============================================================================
import * as v from '../validation.js';
import { errors } from '../errors.js';
import { parsePage, enforceLimit, ok, created } from './helpers.js';

export function registerWalletRoutes({ router }) {
  router.get('/api/wallet', async (ctx) => {
    const session = await ctx.requireUser();
    const { page } = parsePage(ctx.query, { defaultPerPage: 15 });
    const summary = await ctx.services.wallet.summary(session.profile, { page, perPage: 15 });
    return ok(summary);
  });

  router.get('/api/wallet/policy', async (ctx) => {
    await ctx.requireUser();
    const policy = await ctx.services.deposits.policy();
    return ok(policy);
  });

  router.get('/api/deposits', async (ctx) => {
    const session = await ctx.requireUser();
    const { page } = parsePage(ctx.query, { defaultPerPage: 10 });
    const result = await ctx.services.deposits.listMine({ user: session.profile, page, perPage: 10 });
    return ok(result);
  });

  router.post('/api/deposits/gateway', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `gateway-deposit:${session.user.id}`, 6, 60 * 60, { critical: true });
    const body = await ctx.readJson({ limit: 4 * 1024 });
    const policy = await ctx.services.deposits.policy();
    const amount = v.money(body.amount, { field: 'amount', min: policy.minAmount, max: policy.gatewayMaxAmount });
    const result = await ctx.services.deposits.createGateway({ user: session.profile, amount });
    return created({
      ...result,
      message: 'Invoice AstraPay dibuat. Saldo baru dikreditkan setelah status lunas diverifikasi server.'
    });
  });

  router.post('/api/deposits', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `deposit:${session.user.id}`, 6, 60 * 60, { critical: true });

    // Uploads travel as base64 inside JSON, so the body limit is raised here only.
    const body = await ctx.readJson({ limit: ctx.config.limits.maxUploadBytes + 128 * 1024 });
    const amount = v.money(body.amount, { field: 'amount', min: 1 });
    const proof = v.string(body.proof, { field: 'proof', max: 8 * 1024 * 1024 });
    const note = body.note === undefined || body.note === null || body.note === ''
      ? null
      : v.string(body.note, { field: 'note', max: 500, optional: true });

    const result = await ctx.services.deposits.create({
      user: session.profile,
      amount,
      proofBase64: proof,
      note
    });
    return created({
      deposit: result.deposit,
      policy: result.policy,
      message: 'Deposit diajukan. Tunggu verifikasi admin maksimal 1x24 jam.'
    });
  });

  // ------------------------------------------------------------------ profile
  router.get('/api/profile', async (ctx) => {
    const session = await ctx.requireUser();
    return ok({
      profile: {
        id: session.profile.id,
        email: session.profile.email,
        username: session.profile.username,
        fullName: session.profile.full_name,
        phone: session.profile.phone,
        role: session.profile.role,
        status: session.profile.status,
        emailVerifiedAt: session.profile.email_verified_at,
        createdAt: session.profile.created_at
      },
      session: {
        createdAt: session.session.created_at,
        lastUsedAt: session.session.last_used_at,
        expiresAt: session.session.expires_at,
        ip: session.session.ip,
        userAgent: session.session.user_agent
      }
    });
  });

  router.patch('/api/profile', async (ctx) => {
    const session = await ctx.requireUser();
    await enforceLimit(ctx, `profile:update:${session.user.id}`, 10, 10 * 60);
    const body = await ctx.readJson({ limit: 8 * 1024 });

    const patch = {};
    if (body.full_name !== undefined) {
      patch.full_name = body.full_name === '' || body.full_name === null
        ? null
        : v.string(body.full_name, { field: 'full_name', min: 2, max: 80, optional: true });
    }
    if (body.username !== undefined) {
      const username = v.username(body.username, { field: 'username', optional: true });
      patch.username = username;
    }
    if (body.phone !== undefined) {
      patch.phone = body.phone === '' || body.phone === null
        ? null
        : v.string(body.phone, { field: 'phone', min: 8, max: 20, pattern: /^[0-9+\-\s()]+$/, optional: true });
    }
    if (Object.keys(patch).length === 0) throw errors.badRequest('Tidak ada perubahan yang dikirim.', 'EMPTY_PATCH');

    const updated = await ctx.services.db.profiles.update(session.user.id, patch);
    return ok({
      message: 'Profil diperbarui.',
      profile: {
        id: updated.id,
        email: updated.email,
        username: updated.username,
        fullName: updated.full_name,
        phone: updated.phone
      }
    });
  });
}
