// ============================================================================
// DATABASE — direct PostgreSQL driver (production).
//
// Replaces the PostgREST/supabase-js data layer with a pooled `pg` connection.
// The public surface is IDENTICAL to src/database.js so every service, route
// and job keeps working untouched:
//
//   db.settings / profiles / wallets / transactions / services / orders /
//   deposits / audit / sessions / rateLimit / jobs / webhooks
//   db.publicSummary() / db.dashboard(adminId) / db.ping() / db.close()
//
// Design rules (see master prompt §3):
//   · every financial mutation is still a PostgreSQL RPC — locking, idempotency
//     and refund rules stay in the database, never in JavaScript;
//   · every user-supplied value is a bind parameter ($1..$n), never string
//     concatenation;
//   · the pool is created once per process and closed on shutdown;
//   · TLS is negotiated through the connection string (sslmode) and is never
//     disabled to "make it work".
// ============================================================================
import { Pool, types } from 'pg';
import { fromDbError } from './errors.js';

// PostgREST used to hand back numbers for numeric columns; `pg` returns strings
// for numeric/bigint to avoid precision loss. Money columns are all integer
// rupiah in this schema (see database/schema.sql), so parsing them as numbers
// keeps every existing consumer working.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

/** Functions returning SETOF — called with `select * from fn(...)`. */
const SET_RETURNING = new Set(['rpc_claim_orders_for_sync']);

/** Columns never sent to the browser; stripped from profile rows. */
const PROFILE_SECRET_COLUMNS = ['password_hash'];

function stripSecrets(row) {
  if (!row || typeof row !== 'object') return row;
  for (const column of PROFILE_SECRET_COLUMNS) delete row[column];
  return row;
}

export function createPgDatabase(config, { logger } = {}) {
  const { connectionString, ssl, poolMax, connectionTimeoutMs, idleTimeoutMs, statementTimeoutMs } = config.database;
  if (!connectionString) throw new Error('DATABASE_URL is not configured');

  const pool = new Pool({
    connectionString,
    ssl,
    max: poolMax,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    // A hung statement must not pin a pool slot forever.
    statement_timeout: statementTimeoutMs,
    application_name: 'finzz-store'
  });

  let closed = false;
  pool.on('error', (err) => {
    // An idle client dropped by the provider is expected on serverless; log
    // once and let `pg` replace it rather than crashing the process.
    logger?.warn?.('postgres idle client error', { code: err?.code || null, message: err?.message || null });
  });

  /** Parameterised query. Never interpolate user input into `text`. */
  const query = async (text, params = [], context = {}) => {
    const started = Date.now();
    try {
      return await pool.query(text, params);
    } catch (err) {
      throw fromDbError(err, context);
    } finally {
      if (Date.now() - started > 2000) {
        logger?.warn?.('slow query', { ms: Date.now() - started, ...context });
      }
    }
  };

  /** Unwrap a single JSONB/boolean/integer RPC result. */
  /**
   * Bind a JS value to a node-postgres parameter.
   *
   * node-postgres turns a JS array into a Postgres *array literal* (`{a,b}`),
   * not JSON, so an `array`/`object` argument to a `jsonb` RPC parameter used
   * to arrive as a malformed string and the function raised INVALID_INPUT.
   * Anything structured is therefore serialised explicitly.
   */
  const bindValue = (value) => {
    if (value === undefined) return null;
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      return JSON.stringify(value);
    }
    return value;
  };

  const call = async (name, params = {}) => {
    const keys = Object.keys(params);
    const args = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k) => bindValue(params[k]));
    const sql = SET_RETURNING.has(name)
      ? `select * from public.${name}(${args})`
      : `select public.${name}(${args}) as data`;
    const { rows } = await query(sql, values, { rpc: name });
    return SET_RETURNING.has(name) ? rows : (rows[0]?.data ?? null);
  };

  /** Run a callback inside a single transaction (BEGIN/COMMIT/ROLLBACK). */
  const transaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  const selectRows = (result) => result.rows;

  // ------------------------------------------------------------------ crypto
  // Session/reset/OTP secrets live in the auth layer, not here.

  const db = {
    kind: 'pg',
    pool,
    query,
    call,
    transaction,

    async ping() {
      const started = Date.now();
      const { rows } = await query('select 1 as ok', [], { table: 'health' });
      if (rows[0]?.ok !== 1) throw new Error('database ping failed');
      return { ok: true, latencyMs: Date.now() - started };
    },

    /** Readiness detail used by /api/health and scripts/db-doctor.mjs. */
    async readiness() {
      const { rows } = await query(`
        select
          (select count(*)::int from public.services)              as services,
          (select count(*)::int from public.app_settings)          as settings,
          (select to_regprocedure('public.rpc_public_summary()') is not null) as has_summary_rpc,
          (select to_regprocedure('public.rpc_rate_limit_hit(text,integer,integer)') is not null) as has_limiter_rpc
      `);
      return rows[0];
    },

    // -------------------------------------------------------------- settings
    settings: {
      async get(key) {
        const { rows } = await query('select value from public.app_settings where key = $1 limit 1', [key], { table: 'app_settings' });
        return rows[0]?.value ?? null;
      },
      async getAll() {
        const { rows } = await query('select key, value from public.app_settings', [], { table: 'app_settings' });
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
      async getPublic() {
        const { rows } = await query('select key, value from public.app_settings where is_public = true', [], { table: 'app_settings' });
        return Object.fromEntries(rows.map((r) => [r.key, r.value]));
      },
      async update(key, value, adminId) {
        const { rows } = await query(
          'update public.app_settings set value = $2, updated_by = $3 where key = $1 returning *',
          [key, value, adminId], { table: 'app_settings' }
        );
        return rows[0] ?? null;
      }
    },

    // -------------------------------------------------------------- profiles
    profiles: {
      async get(id) {
        const { rows } = await query('select * from public.profiles where id = $1 limit 1', [id], { table: 'profiles' });
        return stripSecrets(rows[0] ?? null);
      },
      async byEmail(email) {
        const { rows } = await query('select * from public.profiles where lower(email) = lower($1) limit 1', [email], { table: 'profiles' });
        return stripSecrets(rows[0] ?? null);
      },
      /** Full row including the password hash — auth layer only. */
      async byEmailWithSecret(email) {
        const { rows } = await query('select * from public.profiles where lower(email) = lower($1) limit 1', [email], { table: 'profiles' });
        return rows[0] ?? null;
      },
      async ensure({ userId, email, username }) {
        const data = await call('ensure_user_profile', {
          p_user_id: userId,
          p_email: email,
          p_username: username || null
        });
        return { profile: stripSecrets(data?.profile), wallet: data?.wallet };
      },
      async update(id, patch) {
        const allowed = ['full_name', 'username', 'phone', 'last_seen_at'];
        const keys = Object.keys(patch).filter((k) => allowed.includes(k));
        if (keys.length === 0) return this.get(id);
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const { rows } = await query(
          `update public.profiles set ${sets} where id = $1 returning *`,
          [id, ...keys.map((k) => patch[k])], { table: 'profiles' }
        );
        return stripSecrets(rows[0] ?? null);
      },
      async touch(id) {
        await query('update public.profiles set last_seen_at = now() where id = $1', [id], { table: 'profiles' });
      },
      /** OAuth login: the provider already proved ownership of the email. */
      async markEmailVerified(id) {
        await query(
          'update public.profiles set email_verified_at = coalesce(email_verified_at, now()) where id = $1',
          [id], { table: 'profiles' }
        );
        return { ok: true };
      },
      async list({ search = '', role = null, status = null, limit = 25, offset = 0 } = {}) {
        const where = [];
        const values = [];
        if (search) {
          values.push(`%${search}%`);
          where.push(`(email ilike $${values.length} or username ilike $${values.length})`);
        }
        if (role) { values.push(role); where.push(`role = $${values.length}`); }
        if (status) { values.push(status); where.push(`status = $${values.length}`); }
        const clause = where.length ? `where ${where.join(' and ')}` : '';
        const countRes = await query(`select count(*)::int as total from public.profiles ${clause}`, values, { table: 'profiles' });
        values.push(limit, offset);
        const { rows } = await query(
          `select * from public.profiles ${clause} order by created_at desc limit $${values.length - 1} offset $${values.length}`,
          values, { table: 'profiles' }
        );
        return { rows: rows.map(stripSecrets), total: countRes.rows[0]?.total ?? 0 };
      },
      async setRole(userId, adminId, role, meta) {
        return call('rpc_set_user_role', {
          p_user_id: userId,
          p_admin_id: adminId,
          p_role: role,
          p_ip: meta?.ip || null,
          p_user_agent: meta?.userAgent || null
        });
      },
      async setStatus(userId, adminId, status, reason, meta) {
        return call('rpc_set_user_status', {
          p_user_id: userId,
          p_admin_id: adminId,
          p_status: status,
          p_reason: reason || null,
          p_ip: meta?.ip || null,
          p_user_agent: meta?.userAgent || null
        });
      },
      async count() {
        const { rows } = await query('select count(*)::int as total from public.profiles', [], { table: 'profiles' });
        return rows[0]?.total ?? 0;
      },
      /**
       * Demo/local seeding only. Creates the profile through the normal
       * registration path, then marks it verified and (optionally) admin.
       * Never called in production: config refuses DEMO_MODE there.
       */
      async seedDemo({ email, passwordHash, role = 'user', verified = true }) {
        const data = await call('rpc_register_user', {
          p_email: email, p_password_hash: passwordHash, p_username: null
        });
        const { rows } = await query(
          `update public.profiles
              set role = $2,
                  email_verified_at = case when $3 then coalesce(email_verified_at, now()) else email_verified_at end
            where id = $1
            returning *`,
          [data.profile.id, role, verified], { table: 'profiles' }
        );
        return { profile: stripSecrets(rows[0]), wallet: data.wallet };
      }
    },

    // ------------------------------------------------------- OAuth identities
    // Subjects are private server-side identifiers; listForUser returns only
    // the provider/email/linked timestamp needed by the authenticated profile UI.
    oauthIdentities: {
      async listForUser(userId) {
        const { rows } = await query(
          `select provider, provider_email, provider_name, created_at as linked_at
             from public.oauth_identities where user_id = $1 order by created_at`,
          [userId], { table: 'oauth_identities' }
        );
        return rows;
      },
      async findBySubject(provider, subject) {
        const { rows } = await query(
          `select user_id, provider, provider_subject, provider_email, provider_name, created_at
             from public.oauth_identities where provider = $1 and provider_subject = $2 limit 1`,
          [provider, subject], { table: 'oauth_identities' }
        );
        return rows[0] ?? null;
      },
      async link({ userId, providerSubject, email, name, ip, userAgent }) {
        return call('rpc_link_google_identity', {
          p_user_id: userId,
          p_provider_subject: providerSubject,
          p_provider_email: email,
          p_provider_name: name || null,
          p_ip: ip || null,
          p_user_agent: userAgent || null
        });
      },
      async createAccount({ email, passwordHash, username, providerSubject, name, ip, userAgent }) {
        return call('rpc_create_google_account', {
          p_email: email,
          p_password_hash: passwordHash,
          p_username: username || null,
          p_provider_subject: providerSubject,
          p_provider_email: email,
          p_provider_name: name || null,
          p_ip: ip || null,
          p_user_agent: userAgent || null
        });
      },
      async unlink({ userId, ip, userAgent }) {
        return call('rpc_unlink_google_identity', {
          p_user_id: userId,
          p_ip: ip || null,
          p_user_agent: userAgent || null
        });
      }
    },

    // --------------------------------------------------------------- wallets
    wallets: {
      async get(userId) {
        const { rows } = await query('select * from public.wallets where user_id = $1 limit 1', [userId], { table: 'wallets' });
        return rows[0] ?? null;
      },
      async adjust(userId, adminId, { direction, amount, reason, reference, ip, userAgent }) {
        return call('rpc_admin_adjust_balance', {
          p_user_id: userId,
          p_admin_id: adminId,
          p_direction: direction,
          p_amount: amount,
          p_reason: reason,
          p_reference: reference,
          p_ip: ip || null,
          p_user_agent: userAgent || null
        });
      }
    },

    // ---------------------------------------------------------- transactions
    transactions: {
      async listByUser(userId, { limit = 25, offset = 0 } = {}) {
        const countRes = await query('select count(*)::int as total from public.wallet_transactions where user_id = $1', [userId], { table: 'wallet_transactions' });
        const { rows } = await query(
          'select * from public.wallet_transactions where user_id = $1 order by created_at desc limit $2 offset $3',
          [userId, limit, offset], { table: 'wallet_transactions' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async listAll({ limit = 50, offset = 0, type = null } = {}) {
        const values = [];
        let clause = '';
        if (type) { values.push(type); clause = 'where type = $1'; }
        const countRes = await query(`select count(*)::int as total from public.wallet_transactions ${clause}`, values, { table: 'wallet_transactions' });
        values.push(limit, offset);
        const { rows } = await query(
          `select * from public.wallet_transactions ${clause} order by created_at desc limit $${values.length - 1} offset $${values.length}`,
          values, { table: 'wallet_transactions' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      }
    },

    // -------------------------------------------------------------- services
    services: {
      async listPublic() {
        const { rows } = await query(`
          select id, code, name, provider_server, provider_app_id, app_name,
                 country_id, country_name, country_iso, country_calling_code,
                 price, stock, is_active, price_synced_at, sort_order
            from public.services
           where is_active = true
           order by sort_order asc, price asc
        `, [], { table: 'services' });
        return rows;
      },
      async listAll({ limit = 200, offset = 0 } = {}) {
        const countRes = await query('select count(*)::int as total from public.services', [], { table: 'services' });
        const { rows } = await query(
          'select * from public.services order by sort_order asc, price asc limit $1 offset $2',
          [limit, offset], { table: 'services' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async get(id) {
        const { rows } = await query('select * from public.services where id = $1 limit 1', [id], { table: 'services' });
        return rows[0] ?? null;
      },
      async sync(provider, server, items) {
        return call('rpc_sync_services', { p_provider: provider, p_server: server, p_services: items });
      },
      async update(id, patch) {
        const allowed = ['is_active', 'markup_bps', 'price', 'sort_order', 'stock', 'name'];
        const keys = Object.keys(patch).filter((k) => allowed.includes(k));
        if (keys.length === 0) return this.get(id);
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const { rows } = await query(
          `update public.services set ${sets} where id = $1 returning *`,
          [id, ...keys.map((k) => patch[k])], { table: 'services' }
        );
        return rows[0] ?? null;
      },
      async lastSyncAt() {
        const { rows } = await query(
          'select started_at, finished_at, status, error, services_upserted from public.catalog_sync_runs order by started_at desc limit 1',
          [], { table: 'catalog_sync_runs' }
        );
        return rows[0] ?? null;
      },
      async recordSyncRun(entry) {
        const keys = Object.keys(entry);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const { rows } = await query(
          `insert into public.catalog_sync_runs (${keys.join(', ')}) values (${placeholders}) returning *`,
          keys.map((k) => entry[k]), { table: 'catalog_sync_runs' }
        );
        return rows[0] ?? null;
      }
    },

    // ------------------------------------------------------------ cron locks
    // One row per job in public.cron_locks; see migration 003. The claim is an
    // atomic upsert inside a `for update` transaction, so two serverless
    // instances cannot both win.
    cron: {
      async claim(name, owner, ttlSeconds) {
        return call('rpc_cron_claim', { p_name: name, p_owner: owner, p_ttl_seconds: ttlSeconds });
      },
      async release(name, owner, status, result) {
        return call('rpc_cron_release', {
          p_name: name, p_owner: owner, p_status: status, p_result: result ?? null
        });
      },
      async heartbeat(name, owner, ttlSeconds) {
        return call('rpc_cron_heartbeat', { p_name: name, p_owner: owner, p_ttl_seconds: ttlSeconds });
      },
      async status() {
        const { rows } = await query(
          'select * from public.cron_locks order by name',
          [],
          { table: 'cron_locks' }
        );
        return rows;
      }
    },

    // ---------------------------------------------------------------- orders
    orders: {
      async create(params) {
        return call('rpc_create_order', {
          p_user_id: params.userId,
          p_service_id: params.serviceId,
          p_idempotency_key: params.idempotencyKey,
          p_request_hash: params.requestHash,
          p_supplier_price: params.supplierPrice,
          p_markup_amount: params.markupAmount,
          p_tax_amount: params.taxAmount,
          p_total_price: params.totalPrice,
          p_provider: params.provider,
          p_provider_server: params.providerServer,
          p_provider_app_id: params.providerAppId,
          p_provider_app_name: params.providerAppName,
          p_country_id: params.countryId,
          p_country_name: params.countryName,
          p_country_iso: params.countryIso,
          p_provider_offer_id: params.providerOfferId,
          p_max_active_orders: params.maxActiveOrders ?? 5
        });
      },
      async get(id) {
        const { rows } = await query('select * from public.orders where id = $1 limit 1', [id], { table: 'orders' });
        return rows[0] ?? null;
      },
      /**
       * Store the pricing *rules* behind the money columns (migration 003).
       * Best effort: a missing snapshot must never block a legitimate order,
       * because the four amount columns are already the authoritative snapshot.
       */
      async setPricingSnapshot(orderId, snapshot) {
        if (!snapshot) return false;
        try {
          await query(
            'update public.orders set pricing_snapshot = $2::jsonb where id = $1',
            [orderId, JSON.stringify(snapshot)],
            { table: 'orders' }
          );
          return true;
        } catch {
          return false;
        }
      },
      async findBySupplierId(supplierOrderId) {
        const { rows } = await query('select * from public.orders where supplier_order_id = $1 limit 1', [supplierOrderId], { table: 'orders' });
        return rows[0] ?? null;
      },
      async getForUser(id, userId) {
        const { rows } = await query('select * from public.orders where id = $1 and user_id = $2 limit 1', [id, userId], { table: 'orders' });
        return rows[0] ?? null;
      },
      async listByUser(userId, { status = null, limit = 20, offset = 0 } = {}) {
        const values = [userId];
        let clause = 'where user_id = $1';
        if (status) { values.push(status); clause += ' and status = $2'; }
        const countRes = await query(`select count(*)::int as total from public.orders ${clause}`, values, { table: 'orders' });
        values.push(limit, offset);
        const { rows } = await query(
          `select * from public.orders ${clause} order by created_at desc limit $${values.length - 1} offset $${values.length}`,
          values, { table: 'orders' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async listActive(userId) {
        const { rows } = await query(
          `select * from public.orders
            where user_id = $1 and status in ('pending','waiting','received','needs_review')
            order by created_at desc`,
          [userId], { table: 'orders' }
        );
        return rows;
      },
      async adminList({ status = null, search = '', limit = 30, offset = 0 } = {}) {
        const values = [];
        const where = [];
        if (status) { values.push(status); where.push(`status = $${values.length}`); }
        if (search) {
          values.push(`%${search}%`);
          where.push(`(supplier_order_id ilike $${values.length} or phone_number ilike $${values.length})`);
        }
        const clause = where.length ? `where ${where.join(' and ')}` : '';
        const countRes = await query(`select count(*)::int as total from public.orders ${clause}`, values, { table: 'orders' });
        values.push(limit, offset);
        const { rows } = await query(
          `select * from public.orders ${clause} order by created_at desc limit $${values.length - 1} offset $${values.length}`,
          values, { table: 'orders' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async attach({ orderId, supplierOrderId, status, phoneNumber, expiresAt, canCancel, cancelAvailableAt, worker }) {
        return call('rpc_attach_supplier_order', {
          p_order_id: orderId,
          p_supplier_order_id: supplierOrderId,
          p_status: status,
          p_phone_number: phoneNumber || null,
          p_expires_at: expiresAt || null,
          p_can_cancel: canCancel ?? false,
          p_cancel_available_at: cancelAvailableAt || null,
          p_worker: worker || 'api'
        });
      },
      async applyState({ orderId, status, phoneNumber, otps, canCancel, cancelAvailableAt, expiresAt, source, errorCode, message }) {
        return call('rpc_apply_supplier_state', {
          p_order_id: orderId,
          p_status: status,
          p_phone_number: phoneNumber || null,
          p_otps: otps || [],
          p_can_cancel: canCancel ?? null,
          p_cancel_available_at: cancelAvailableAt || null,
          p_expires_at: expiresAt || null,
          p_source: source || 'system',
          p_error_code: errorCode || null,
          p_message: message ? String(message).slice(0, 500) : null
        });
      },
      async fail({ orderId, errorCode, message, refund = true, source = 'system' }) {
        return call('rpc_fail_order', {
          p_order_id: orderId,
          p_error_code: errorCode || null,
          p_message: message || null,
          p_refund: refund,
          p_source: source
        });
      },
      async beginCancel(orderId, userId) {
        return call('rpc_begin_cancel', { p_order_id: orderId, p_user_id: userId });
      },
      async releaseCancel(orderId, message) {
        return call('rpc_release_cancel', { p_order_id: orderId, p_message: message || null });
      },
      async refund(orderId, reason, adminId = null) {
        return call('rpc_refund_order', { p_order_id: orderId, p_reason: reason, p_admin_id: adminId });
      },
      async claimForSync(limit, leaseSeconds, worker) {
        return call('rpc_claim_orders_for_sync', {
          p_limit: limit,
          p_lease_seconds: leaseSeconds,
          p_worker: worker
        }) || [];
      },
      async releaseLease(orderId, nextSyncAt, errorCode, errorMessage) {
        return call('rpc_release_order_lease', {
          p_order_id: orderId,
          p_next_sync_at: nextSyncAt || null,
          p_error_code: errorCode || null,
          p_error_message: errorMessage ? String(errorMessage).slice(0, 500) : null
        });
      },
      async flagOrphans(ageSeconds = 180) {
        return call('rpc_flag_orphan_pending_orders', { p_age_seconds: ageSeconds });
      },
      async eventsFor(orderId, { limit = 30 } = {}) {
        const { rows } = await query(
          `select id, event_type, from_status, to_status, source, message, created_at
             from public.order_events where order_id = $1 order by id desc limit $2`,
          [orderId, limit], { table: 'order_events' }
        );
        return { rows };
      },
      async countActive(userId) {
        const { rows } = await query(
          `select count(*)::int as total from public.orders
            where user_id = $1 and status in ('pending','waiting','received')`,
          [userId], { table: 'orders' }
        );
        return rows[0]?.total ?? 0;
      }
    },

    // -------------------------------------------------------------- deposits
    deposits: {
      async create(params) {
        return call('rpc_create_deposit', {
          p_user_id: params.userId,
          p_amount: params.amount,
          p_proof_path: params.proofPath,
          p_proof_mime: params.proofMime,
          p_proof_size: params.proofSize,
          p_proof_sha256: params.proofSha256,
          p_user_note: params.note || null,
          p_min_amount: params.minAmount,
          p_max_amount: params.maxAmount,
          p_max_pending: params.maxPending ?? 3
        });
      },
      async createGateway(params) {
        return call('rpc_create_astrapay_deposit', {
          p_user_id: params.userId,
          p_amount: params.amount,
          p_reference: params.reference,
          p_min_amount: params.minAmount,
          p_max_amount: params.maxAmount,
          p_max_pending: params.maxPending ?? 3,
          p_expires_in: params.expiresIn ?? 600
        });
      },
      async storeGatewayInvoice(params) {
        return call('rpc_store_astrapay_invoice', {
          p_deposit_id: params.depositId,
          p_provider_order_id: params.providerOrderId,
          p_reference: params.reference,
          p_pay_amount: params.payAmount,
          p_fee_amount: params.feeAmount,
          p_checkout_url: params.checkoutUrl,
          p_qris_payload: params.qris,
          p_expires_at: params.expiresAt,
          p_provider_status: params.providerStatus ?? 'pending'
        });
      },
      async findGatewayByReference(reference) {
        const { rows } = await query(
          `select * from public.deposits where method = 'gateway' and provider_reference = $1 limit 1`,
          [reference], { table: 'deposits' }
        );
        return rows[0] ?? null;
      },
      async listPendingGateway({ limit = 10 } = {}) {
        const { rows } = await query(
          `select * from public.deposits
            where method = 'gateway' and status = 'pending'
            order by created_at asc limit $1`,
          [limit], { table: 'deposits' }
        );
        return { rows };
      },
      async confirmGatewayPayment(params) {
        return call('rpc_confirm_astrapay_deposit', {
          p_event_id: params.eventId,
          p_event_type: params.eventType,
          p_provider_order_id: params.providerOrderId,
          p_reference: params.reference,
          p_base_amount: params.baseAmount,
          p_fee_amount: params.feeAmount,
          p_pay_amount: params.payAmount,
          p_paid_at: params.paidAt
        });
      },
      async closeGatewayDeposit(depositId, providerStatus) {
        return call('rpc_close_astrapay_deposit', {
          p_deposit_id: depositId,
          p_provider_status: providerStatus
        });
      },
      async get(id) {
        const { rows } = await query('select * from public.deposits where id = $1 limit 1', [id], { table: 'deposits' });
        return rows[0] ?? null;
      },
      async listByUser(userId, { limit = 20, offset = 0 } = {}) {
        const countRes = await query('select count(*)::int as total from public.deposits where user_id = $1', [userId], { table: 'deposits' });
        const { rows } = await query(
          'select * from public.deposits where user_id = $1 order by created_at desc limit $2 offset $3',
          [userId, limit, offset], { table: 'deposits' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async listPendingByUser(userId, { limit = 10 } = {}) {
        const { rows } = await query(
          `select * from public.deposits where user_id = $1 and status = 'pending'
            order by created_at desc limit $2`,
          [userId, limit], { table: 'deposits' }
        );
        return { rows };
      },
      async adminList({ status = 'pending', limit = 30, offset = 0 } = {}) {
        const values = [];
        let clause = '';
        if (status) { values.push(status); clause = 'where status = $1'; }
        const countRes = await query(`select count(*)::int as total from public.deposits ${clause}`, values, { table: 'deposits' });
        values.push(limit, offset);
        const { rows } = await query(
          `select * from public.deposits ${clause} order by created_at desc limit $${values.length - 1} offset $${values.length}`,
          values, { table: 'deposits' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      },
      async approve(id, adminId, amount, note, meta) {
        return call('rpc_approve_deposit', {
          p_deposit_id: id,
          p_admin_id: adminId,
          p_approved_amount: amount,
          p_admin_note: note || null,
          p_ip: meta?.ip || null,
          p_user_agent: meta?.userAgent || null
        });
      },
      async reject(id, adminId, reason, meta) {
        return call('rpc_reject_deposit', {
          p_deposit_id: id,
          p_admin_id: adminId,
          p_reason: reason,
          p_ip: meta?.ip || null,
          p_user_agent: meta?.userAgent || null
        });
      }
    },

    // ----------------------------------------------------------------- audit
    audit: {
      async log(entry) {
        const { rows } = await query(
          `insert into public.admin_audit_logs
             (admin_id, action, target_type, target_id, reason, before, after, ip, user_agent)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning *`,
          [
            entry.adminId ?? null, entry.action, entry.targetType ?? null, entry.targetId || null,
            entry.reason || null, entry.before ?? null, entry.after ?? null,
            entry.ip || null, entry.userAgent || null
          ],
          { table: 'admin_audit_logs' }
        );
        return rows[0] ?? null;
      },
      async list({ limit = 50, offset = 0 } = {}) {
        const countRes = await query('select count(*)::int as total from public.admin_audit_logs', [], { table: 'admin_audit_logs' });
        const { rows } = await query(
          'select * from public.admin_audit_logs order by created_at desc limit $1 offset $2',
          [limit, offset], { table: 'admin_audit_logs' }
        );
        return { rows, total: countRes.rows[0]?.total ?? 0 };
      }
    },

    // -------------------------------------------------------------- sessions
    /**
     * Email verification contexts — the server-side proof that the browser
     * asking to verify a code is the browser that registered the account.
     * Only the SHA-256 of the token is stored (see migration 007).
     */
    verifyContexts: {
      async issue({ userId, tokenHash, email, ttlSeconds = 1800, ip = null, userAgent = null }) {
        return call('rpc_issue_verify_context', {
          p_user_id: userId,
          p_token_hash: tokenHash,
          p_email: email,
          p_ttl_seconds: ttlSeconds,
          p_ip: ip,
          p_user_agent: userAgent
        });
      },
      async read(tokenHash) {
        return call('rpc_read_verify_context', { p_token_hash: tokenHash });
      },
      async markDelivery(tokenHash, sent, error = null) {
        return call('rpc_mark_verify_delivery', {
          p_token_hash: tokenHash, p_sent: Boolean(sent), p_error: error
        });
      },
      /** Atomic cooldown claim — the reason two simultaneous resends cannot both win. */
      async claimResend(tokenHash, { cooldownSeconds = 60, maxPerHour = 5 } = {}) {
        return call('rpc_claim_verify_resend', {
          p_token_hash: tokenHash,
          p_cooldown_s: cooldownSeconds,
          p_max_per_hour: maxPerHour
        });
      },
      async consume(tokenHash) {
        return call('rpc_consume_verify_context', { p_token_hash: tokenHash });
      }
    },

    sessions: {
      async create(row) {
        const allowed = [
          'user_id', 'token_hash', 'csrf_hash', 'ip', 'user_agent', 'expires_at',
          'refresh_token_enc', 'access_token_enc', 'access_expires_at'
        ];
        const keys = Object.keys(row).filter((k) => allowed.includes(k) && row[k] !== undefined);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const { rows } = await query(
          `insert into public.sessions (${keys.join(', ')}) values (${placeholders}) returning *`,
          keys.map((k) => row[k]), { table: 'sessions' }
        );
        return rows[0] ?? null;
      },
      async byTokenHash(hash) {
        const { rows } = await query('select * from public.sessions where token_hash = $1 limit 1', [hash], { table: 'sessions' });
        return rows[0] ?? null;
      },
      async update(id, patch) {
        const allowed = ['csrf_hash', 'last_used_at', 'expires_at', 'revoked_at', 'ip', 'user_agent',
          'refresh_token_enc', 'access_token_enc', 'access_expires_at'];
        const keys = Object.keys(patch).filter((k) => allowed.includes(k));
        if (keys.length === 0) return null;
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const { rows } = await query(
          `update public.sessions set ${sets} where id = $1 returning *`,
          [id, ...keys.map((k) => patch[k])], { table: 'sessions' }
        );
        return rows[0] ?? null;
      },
      async revoke(id) {
        await query('update public.sessions set revoked_at = now() where id = $1', [id], { table: 'sessions' });
      },
      async revokeAllForUser(userId) {
        await query(
          'update public.sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [userId], { table: 'sessions' }
        );
      },
      async listForUser(userId, { limit = 50 } = {}) {
        const { rows } = await query(
          `select id, user_id, created_at, last_used_at, expires_at, revoked_at, ip, user_agent
             from public.sessions
            where user_id = $1 and revoked_at is null
            order by created_at desc limit $2`,
          [userId, limit], { table: 'sessions' }
        );
        return { rows };
      },
      async deleteExpired() {
        await query('delete from public.sessions where expires_at < now()', [], { table: 'sessions' });
      }
    },

    // ----------------------------------------------------------- rate limits
    rateLimit: {
      async hit(key, limit, windowSeconds) {
        const data = await call('rpc_rate_limit_hit', {
          p_key: key,
          p_limit: limit,
          p_window_seconds: windowSeconds
        });
        return {
          allowed: data.allowed,
          limit: data.limit,
          remaining: data.remaining,
          count: data.count,
          resetAt: new Date(data.reset_at).getTime()
        };
      }
    },

    // ---------------------------------------------------------- notifications
    // Rows are created by database triggers (migration 008) from real order and
    // deposit state changes, so nothing here invents an event. The repository
    // only reads them and marks them as read.
    notifications: {
      async listByUser(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
        const values = [userId];
        let where = 'where user_id = $1';
        if (unreadOnly) where += ' and read_at is null';
        const listRes = await query(
          `select id, user_id, type, severity, title, body, order_id, deposit_id, meta, read_at, created_at
             from public.notifications
             ${where}
             order by created_at desc, id desc
             limit ${Number(limit)} offset ${Number(offset)}`,
          values,
          { table: 'notifications' }
        );
        const totalRes = await query(
          `select count(*)::int as total,
                  count(*) filter (where read_at is null)::int as unread
             from public.notifications where user_id = $1`,
          [userId],
          { table: 'notifications' }
        );
        return {
          rows: listRes.rows,
          total: totalRes.rows[0]?.total ?? 0,
          unread: totalRes.rows[0]?.unread ?? 0,
          offset,
          limit
        };
      },

      async unreadCount(userId) {
        const res = await query(
          'select count(*)::int as unread from public.notifications where user_id = $1 and read_at is null',
          [userId],
          { table: 'notifications' }
        );
        return res.rows[0]?.unread ?? 0;
      },

      // `ids` scoped by user_id: an id that belongs to somebody else simply
      // updates nothing, which is what stops IDOR here.
      async markRead(userId, ids = null) {
        if (Array.isArray(ids)) {
          const list = ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100);
          if (list.length === 0) return 0;
          const res = await query(
            'update public.notifications set read_at = now() where user_id = $1 and read_at is null and id = any($2::bigint[])',
            [userId, list],
            { table: 'notifications' }
          );
          return res.rowCount ?? 0;
        }
        const res = await query(
          'update public.notifications set read_at = now() where user_id = $1 and read_at is null',
          [userId],
          { table: 'notifications' }
        );
        return res.rowCount ?? 0;
      },

      // Used by server-side flows that need to announce a verified app event
      // (for example "email verified"). Business code can never pass arbitrary
      // fields through: the type/severity are validated by table constraints.
      async create({ userId, type, severity = 'info', title, body = null, orderId = null, depositId = null, meta = {} }) {
        const res = await query(
          `insert into public.notifications (user_id, type, severity, title, body, order_id, deposit_id, meta)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           returning id, user_id, type, severity, title, body, order_id, deposit_id, meta, read_at, created_at`,
          [userId, type, severity, title, body, orderId, depositId, JSON.stringify(meta ?? {})],
          { table: 'notifications' }
        );
        return res.rows[0] ?? null;
      }
    },

    // ------------------------------------------------------------- job leases
    jobs: {
      async acquire(name, owner, leaseSeconds) {
        const data = await call('rpc_acquire_job_lease', {
          p_name: name,
          p_owner: owner,
          p_lease_seconds: leaseSeconds
        });
        return data === true;
      },
      async release(name, owner) {
        await call('rpc_release_job_lease', { p_name: name, p_owner: owner });
      }
    },

    // -------------------------------------------------------------- webhooks
    webhooks: {
      async record(deliveryId, eventType, payload) {
        return call('rpc_record_webhook_event', {
          p_delivery_id: deliveryId,
          p_event_type: eventType,
          p_payload: payload
        });
      },
      async markProcessed(deliveryId, error = null) {
        await query(
          'update public.supplier_webhook_events set processed_at = now(), error = $2 where delivery_id = $1',
          [deliveryId, error], { table: 'supplier_webhook_events' }
        );
      }
    },

    // ------------------------------------------------------------- aggregates
    async publicSummary() {
      return call('rpc_public_summary');
    },
    async dashboard(adminId) {
      return call('rpc_admin_dashboard', { p_admin_id: adminId });
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end().catch(() => {});
      logger?.debug?.('postgres pool closed');
    }
  };

  return db;
}
