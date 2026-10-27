-- ============================================================================
-- FINZZ STORE — MIGRASI LENGKAP UNTUK SUPABASE SQL EDITOR
-- Dijalankan SETELAH database/BOOTSTRAP_SUPABASE.sql (skema dasar + RLS + RPC).
--
-- Isi file ini adalah gabungan, berurutan, dari:
--   database/migrations/002_custom_auth.sql                     (auth kustom)
--   database/migrations/003_pricing_snapshot_and_cron_locks.sql (snapshot harga + lock cron)
--   database/migrations/004_auth_hardening.sql                  (OTP terikat user + hitung percobaan)
--   database/migrations/005_catalog_markup.sql                  (markup tersimpan saat sync)
--
-- Sifat: idempoten (aman diulang), aditif (tidak menghapus data, tidak
-- mematikan RLS, tidak mengubah harga yang sudah tercatat di order).
--
-- Cara pakai:
--   1. Supabase Dashboard → SQL Editor → New query
--   2. Tempel SELURUH isi file ini → Run
--   3. Jalankan blok DIAGNOSTIK di bagian paling bawah dan pastikan hasilnya
--      sesuai komentar yang tertulis.
-- ============================================================================


-- ############################################################################
-- ## 002_custom_auth.sql
-- ############################################################################

-- ============================================================================
-- MIGRATION 002 — CUSTOM AUTHENTICATION (Supabase Auth removed)
--
-- NON-DESTRUCTIVE. It never drops a table, never deletes a row and never
-- disables RLS. Existing Supabase-auth users keep their profiles: the foreign
-- key to auth.users is dropped, so profiles becomes the application's own user
-- table, and a nullable password_hash column is added.
--
-- Users created before this migration have password_hash = NULL. They simply
-- cannot sign in with a password until an admin triggers a password reset —
-- nobody is deleted and no password is invented.
--
-- Run after database/schema.sql + database/functions.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'MIGRATION_ABORTED: public.profiles is missing — run database/schema.sql first';
  end if;
  if to_regclass('public.sessions') is null then
    raise exception 'MIGRATION_ABORTED: public.sessions is missing — run database/schema.sql first';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. profiles becomes the application user table
-- ---------------------------------------------------------------------------
-- Detach from Supabase Auth. The data stays; only the constraint goes.
alter table public.profiles drop constraint if exists profiles_id_fkey;

-- profiles.id used to be supplied by Supabase Auth (auth.users). With that
-- gone the column needs its own default, otherwise registration fails with
-- 'null value in column "id"'.
alter table public.profiles alter column id set default gen_random_uuid();

alter table public.profiles
  add column if not exists password_hash         text,
  add column if not exists password_updated_at   timestamptz,
  add column if not exists failed_login_count    integer not null default 0,
  add column if not exists locked_until          timestamptz,
  add column if not exists last_login_at         timestamptz;

comment on column public.profiles.password_hash is
  'Argon2id hash. NULL = account predates custom auth; must reset password to sign in.';

-- Emails are compared case-insensitively everywhere (login, register, reset).
create unique index if not exists profiles_email_lower_uidx on public.profiles (lower(email));

-- Self-service security events (registration, password reset) have no admin.
-- Relaxing NOT NULL is additive: existing rows and writers are unaffected.
alter table public.admin_audit_logs alter column admin_id drop not null;

-- ---------------------------------------------------------------------------
-- 2. sessions: no more provider refresh/access tokens
-- ---------------------------------------------------------------------------
-- The session cookie IS the credential; the row stores only its SHA-256 hash.
alter table public.sessions alter column refresh_token_enc drop not null;
alter table public.sessions alter column refresh_token_enc drop default;

alter table public.sessions
  add column if not exists idle_expires_at timestamptz;

create index if not exists sessions_user_active_idx
  on public.sessions (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. One-time tokens: email verification (OTP) and password reset (link)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'auth_token_kind') then
    create type public.auth_token_kind as enum ('email_verification', 'password_reset');
  end if;
end
$$;

create table if not exists public.auth_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          public.auth_token_kind not null,
  -- SHA-256 of the raw token (link reset) or of the 6-digit OTP.
  token_hash    text not null,
  -- OTP lookups are by user+kind, so the hash alone is not unique across
  -- regenerations; uniqueness is enforced on (user_id, kind, token_hash).
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  constraint auth_tokens_hash_format check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint auth_tokens_attempts_check check (attempts >= 0)
);

create unique index if not exists auth_tokens_user_kind_hash_uidx
  on public.auth_tokens (user_id, kind, token_hash);
create index if not exists auth_tokens_lookup_idx
  on public.auth_tokens (kind, token_hash) where consumed_at is null;
create index if not exists auth_tokens_expiry_idx
  on public.auth_tokens (expires_at) where consumed_at is null;

alter table public.auth_tokens enable row level security;
-- No policy is granted to anon/authenticated on purpose: this table is only
-- reachable through the service role.
revoke all on public.auth_tokens from anon, authenticated;
grant select, insert, update, delete on public.auth_tokens to service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC: register a user atomically (profile + wallet in one transaction)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_register_user(
  p_email         text,
  p_password_hash text,
  p_username      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_profile public.profiles;
  v_wallet  public.wallets;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'EMAIL_INVALID' using errcode = '22023';
  end if;
  if p_password_hash is null or char_length(p_password_hash) < 20 then
    raise exception 'PASSWORD_HASH_REQUIRED' using errcode = '22023';
  end if;

  -- Serialise concurrent registrations of the same address.
  perform pg_advisory_xact_lock(hashtext(lower(p_email)));

  if exists (select 1 from public.profiles p where lower(p.email) = lower(p_email)) then
    raise exception 'EMAIL_TAKEN' using errcode = '23505';
  end if;

  insert into public.profiles (email, username, password_hash, email_verified_at)
  values (lower(p_email), p_username, p_password_hash, null)
  returning * into v_profile;

  insert into public.wallets (user_id) values (v_profile.id)
  returning * into v_wallet;

  v_id := v_profile.id;

  insert into public.admin_audit_logs (admin_id, action, target_type, target_id, reason)
  values (null, 'auth.register', 'user', v_id, 'self-service registration');

  return jsonb_build_object(
    'profile', to_jsonb(v_profile) - 'password_hash',
    'wallet',  to_jsonb(v_wallet)
  );
end
$$;

revoke all on function public.rpc_register_user(text, text, text) from public, anon, authenticated;
grant execute on function public.rpc_register_user(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: issue a one-time token (invalidates previous tokens of that kind)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_issue_auth_token(
  p_user_id    uuid,
  p_kind       public.auth_token_kind,
  p_token_hash text,
  p_ttl_seconds integer,
  p_max_attempts integer default 5,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'TOKEN_HASH_INVALID' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'TOKEN_TTL_INVALID' using errcode = '22023';
  end if;

  -- A new token supersedes every pending token of the same kind for that user.
  update public.auth_tokens
     set consumed_at = now()
   where user_id = p_user_id and kind = p_kind and consumed_at is null;

  v_expires := now() + make_interval(secs => p_ttl_seconds);

  insert into public.auth_tokens
    (user_id, kind, token_hash, expires_at, max_attempts, ip, user_agent)
  values
    (p_user_id, p_kind, p_token_hash, v_expires, coalesce(p_max_attempts, 5),
     left(p_ip, 64), left(p_user_agent, 300));

  return jsonb_build_object('expires_at', v_expires);
end
$$;

revoke all on function public.rpc_issue_auth_token(uuid, public.auth_token_kind, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.rpc_issue_auth_token(uuid, public.auth_token_kind, text, integer, integer, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. RPC: consume an email-verification token
-- ---------------------------------------------------------------------------
create or replace function public.rpc_consume_email_token(
  p_token_hash text,
  p_kind       public.auth_token_kind
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   public.auth_tokens;
  v_profile public.profiles;
begin
  -- Row lock makes double-submit impossible: the second caller sees
  -- consumed_at already set and is rejected.
  select * into v_token
    from public.auth_tokens
   where token_hash = p_token_hash
     and kind = p_kind
     and consumed_at is null
   order by created_at desc
   limit 1
   for update;

  if v_token.id is null then
    raise exception 'TOKEN_INVALID' using errcode = 'P0001';
  end if;
  if v_token.expires_at < now() then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    raise exception 'TOKEN_EXPIRED' using errcode = 'P0001';
  end if;
  if v_token.attempts >= v_token.max_attempts then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    raise exception 'TOKEN_ATTEMPTS_EXCEEDED' using errcode = 'P0001';
  end if;

  update public.auth_tokens
     set consumed_at = now(), attempts = attempts + 1
   where id = v_token.id;

  if p_kind = 'email_verification' then
    update public.profiles
       set email_verified_at = coalesce(email_verified_at, now())
     where id = v_token.user_id
     returning * into v_profile;
  else
    select * into v_profile from public.profiles where id = v_token.user_id;
  end if;

  return jsonb_build_object(
    'user_id', v_token.user_id,
    'email', v_profile.email,
    'email_verified_at', v_profile.email_verified_at
  );
end
$$;

revoke all on function public.rpc_consume_email_token(text, public.auth_token_kind) from public, anon, authenticated;
grant execute on function public.rpc_consume_email_token(text, public.auth_token_kind) to service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC: complete a password reset atomically
--    checks token → sets password → marks token used → revokes every session
-- ---------------------------------------------------------------------------
create or replace function public.rpc_complete_password_reset(
  p_token_hash    text,
  p_password_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   public.auth_tokens;
  v_user_id uuid;
begin
  if p_password_hash is null or char_length(p_password_hash) < 20 then
    raise exception 'PASSWORD_HASH_REQUIRED' using errcode = '22023';
  end if;

  select * into v_token
    from public.auth_tokens
   where token_hash = p_token_hash
     and kind = 'password_reset'
     and consumed_at is null
   order by created_at desc
   limit 1
   for update;

  if v_token.id is null then
    raise exception 'TOKEN_INVALID' using errcode = 'P0001';
  end if;
  if v_token.expires_at < now() then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    raise exception 'TOKEN_EXPIRED' using errcode = 'P0001';
  end if;

  update public.profiles
     set password_hash = p_password_hash,
         password_updated_at = now(),
         failed_login_count = 0,
         locked_until = null
   where id = v_token.user_id
   returning id into v_user_id;

  update public.auth_tokens set consumed_at = now() where id = v_token.id;

  -- A stolen session must not survive a password change.
  update public.sessions set revoked_at = now()
   where user_id = v_user_id and revoked_at is null;

  insert into public.admin_audit_logs (admin_id, action, target_type, target_id, reason)
  values (null, 'auth.password_reset', 'user', v_user_id, 'completed via reset link');

  return jsonb_build_object('user_id', v_user_id);
end
$$;

revoke all on function public.rpc_complete_password_reset(text, text) from public, anon, authenticated;
grant execute on function public.rpc_complete_password_reset(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC: login attempt bookkeeping (throttle + lockout)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_note_login(
  p_user_id  uuid,
  p_success  boolean,
  p_max_failures integer default 10,
  p_lock_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if p_success then
    update public.profiles
       set failed_login_count = 0, locked_until = null, last_login_at = now()
     where id = p_user_id
     returning * into v_profile;
  else
    update public.profiles
       set failed_login_count = failed_login_count + 1,
           locked_until = case
             when failed_login_count + 1 >= p_max_failures
             then now() + make_interval(secs => p_lock_seconds)
             else locked_until
           end
     where id = p_user_id
     returning * into v_profile;
  end if;

  return jsonb_build_object(
    'failed_login_count', v_profile.failed_login_count,
    'locked_until', v_profile.locked_until
  );
end
$$;

revoke all on function public.rpc_note_login(uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.rpc_note_login(uuid, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Cleanup helper used by the external cron
-- ---------------------------------------------------------------------------
create or replace function public.rpc_cleanup_auth()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tokens int;
  v_sessions int;
begin
  delete from public.auth_tokens
   where expires_at < now() - interval '1 day'
      or (consumed_at is not null and consumed_at < now() - interval '1 day');
  get diagnostics v_tokens = row_count;

  delete from public.sessions
   where expires_at < now() - interval '1 day'
      or (revoked_at is not null and revoked_at < now() - interval '7 days');
  get diagnostics v_sessions = row_count;

  return jsonb_build_object('tokens_deleted', v_tokens, 'sessions_deleted', v_sessions);
end
$$;

revoke all on function public.rpc_cleanup_auth() from public, anon, authenticated;
grant execute on function public.rpc_cleanup_auth() to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Diagnostics
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice '----------------------------------------';
  raise notice 'profiles.password_hash ada: %', exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name='password_hash');
  raise notice 'auth_tokens ada: %', to_regclass('public.auth_tokens') is not null;
  raise notice 'profiles tanpa password (harus reset): %', (
    select count(*) from public.profiles where password_hash is null);
  raise notice 'anon bisa baca auth_tokens: % (harus false)', has_table_privilege('anon','public.auth_tokens','select');
  raise notice 'service_role bisa panggil rpc_register_user: % (harus true)',
    has_function_privilege('service_role','public.rpc_register_user(text,text,text)','execute');
  raise notice '----------------------------------------';
end
$$;

notify pgrst, 'reload schema';


-- ############################################################################
-- ## 003_pricing_snapshot_and_cron_locks.sql
-- ############################################################################

-- ============================================================================
-- 003 — PRICE SNAPSHOT + POSTGRES-BACKED CRON LOCKS
--
-- Two independent additions, both additive and idempotent:
--
--   1. orders.pricing_snapshot
--      The four money columns (supplier_price, markup_amount, tax_amount,
--      total_price) already freeze the amount charged. This column stores the
--      *rules* that produced them (markup bps, which override applied, fixed
--      markup, min margin, rounding, tax label) so a price can be explained
--      months later without replaying historical configuration.
--
--   2. cron_locks + claim/release functions
--      Vercel/serverless instances come and go, so an in-process mutex cannot
--      stop two invocations from running the same job twice. The lock lives in
--      PostgreSQL with a TTL, so a crashed runner cannot deadlock the schedule.
--
-- Safe to run twice. No data is deleted; every statement is CREATE/ALTER IF
-- NOT EXISTS or CREATE OR REPLACE.
-- ============================================================================

begin;

-- ---------------------------------------------------------- price snapshot --
alter table public.orders
  add column if not exists pricing_snapshot jsonb;

comment on column public.orders.pricing_snapshot is
  'Rules used to price this order (markup bps, override source, fixed markup, min margin, rounding, tax label). Amounts live in the money columns.';

-- ------------------------------------------------------------- cron locks --
create table if not exists public.cron_locks (
  name          text primary key,
  owner         text,
  locked_until  timestamptz,
  last_run_at   timestamptz,
  last_owner    text,
  last_status   text,
  last_result   jsonb,
  run_count     bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cron_locks_name_format check (name ~ '^[a-z0-9_.:-]{3,64}$')
);

comment on table public.cron_locks is
  'Distributed lock + run history for scheduled jobs. One row per job name.';

alter table public.cron_locks enable row level security;

-- Internal table: no client role may read or write it. RLS alone is not enough
-- (a policy could be added by mistake), so privileges are revoked explicitly.
revoke all on public.cron_locks from anon, authenticated;
grant select, insert, update, delete on public.cron_locks to service_role;

-- --------------------------------------------------------------- claim/release
-- Claim `p_name` for `p_owner` until now() + p_ttl_seconds.
-- Returns {claimed: boolean, owner, locked_until, run_count, reason}.
-- A free lock, our own lock, or an expired lock can all be claimed; a live lock
-- held by another owner cannot.
create or replace function public.rpc_cron_claim(
  p_name         text,
  p_owner        text,
  p_ttl_seconds  integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.cron_locks;
  v_until timestamptz;
  v_ttl   integer := greatest(10, least(coalesce(p_ttl_seconds, 120), 3600));
begin
  if p_name is null or p_name !~ '^[a-z0-9_.:-]{3,64}$' then
    raise exception 'INVALID_LOCK_NAME' using errcode = '22023';
  end if;
  if p_owner is null or length(p_owner) < 4 or length(p_owner) > 120 then
    raise exception 'INVALID_LOCK_OWNER' using errcode = '22023';
  end if;

  insert into public.cron_locks (name)
  values (p_name)
  on conflict (name) do nothing;

  select * into v_row from public.cron_locks where name = p_name for update;

  if v_row.locked_until is not null
     and v_row.locked_until > now()
     and coalesce(v_row.owner, '') <> p_owner then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'LOCKED',
      'owner', v_row.owner,
      'locked_until', v_row.locked_until,
      'run_count', v_row.run_count
    );
  end if;

  v_until := now() + make_interval(secs => v_ttl);

  update public.cron_locks
     set owner = p_owner,
         locked_until = v_until,
         updated_at = now()
   where name = p_name;

  return jsonb_build_object(
    'claimed', true,
    'reason', 'ACQUIRED',
    'owner', p_owner,
    'locked_until', v_until,
    'run_count', v_row.run_count
  );
end;
$$;

-- Release a lock we still own. Releasing someone else's lock is a no-op.
-- Returns {released: boolean, last_run_at, run_count}.
create or replace function public.rpc_cron_release(
  p_name    text,
  p_owner   text,
  p_status  text default 'success',
  p_result  jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.cron_locks;
begin
  select * into v_row from public.cron_locks where name = p_name for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'NOT_FOUND');
  end if;

  if coalesce(v_row.owner, '') <> coalesce(p_owner, '') then
    return jsonb_build_object('released', false, 'reason', 'NOT_OWNER', 'last_run_at', v_row.last_run_at);
  end if;

  update public.cron_locks
     set owner = null,
         locked_until = null,
         last_run_at = now(),
         last_owner = p_owner,
         last_status = coalesce(p_status, 'success'),
         last_result = p_result,
         run_count = run_count + 1,
         updated_at = now()
   where name = p_name
   returning * into v_row;

  return jsonb_build_object('released', true, 'last_run_at', v_row.last_run_at, 'run_count', v_row.run_count);
end;
$$;

-- Extend a lock that is taking longer than expected (long catalogue syncs).
create or replace function public.rpc_cron_heartbeat(
  p_name         text,
  p_owner        text,
  p_ttl_seconds  integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ttl integer := greatest(10, least(coalesce(p_ttl_seconds, 120), 3600));
begin
  update public.cron_locks
     set locked_until = now() + make_interval(secs => v_ttl),
         updated_at = now()
   where name = p_name
     and owner = p_owner
     and locked_until > now();
  return found;
end;
$$;

revoke all on function public.rpc_cron_claim(text, text, integer) from public;
revoke all on function public.rpc_cron_release(text, text, text, jsonb) from public;
revoke all on function public.rpc_cron_heartbeat(text, text, integer) from public;
grant execute on function public.rpc_cron_claim(text, text, integer) to service_role;
grant execute on function public.rpc_cron_release(text, text, text, jsonb) to service_role;
grant execute on function public.rpc_cron_heartbeat(text, text, integer) to service_role;

-- Seed the rows so the admin panel can show "never run" instead of nothing.
insert into public.cron_locks (name)
values ('orders.poller'), ('orders.reconcile'), ('catalog.sync')
on conflict (name) do nothing;

commit;


-- ############################################################################
-- ## 004_auth_hardening.sql
-- ############################################################################

-- ============================================================================
-- 004 — AUTH HARDENING: bind OTP to its owner + count failed attempts
--
-- WHY THIS EXISTS
--
-- A 6-digit code has only 1,000,000 possible values. In 002 the verification
-- code was looked up by `sha256(code)` alone, with no reference to the account
-- it was issued for. Two consequences:
--
--   1. Two users holding the same code at the same time were ambiguous: the
--      lookup returned the newest matching row, so a caller could be handed a
--      session for an account that is not theirs.
--   2. `attempts` was only incremented when a token was *matched*, so a wrong
--      guess incremented nothing and `max_attempts` could never be reached.
--
-- Fixes, both inside the database:
--
--   * `p_user_id` scopes the lookup. The application hashes the code together
--     with the owning user id (sha256("<user-id>:<code>")), so a hash cannot
--     collide across accounts even in principle.
--   * A miss for a known user increments `attempts` on that user's live token
--     and burns it once `max_attempts` is reached, making brute force bounded
--     at the data layer instead of relying on HTTP rate limits alone.
--
-- RETURN-BASED ERRORS
--
-- Expected outcomes are returned as JSON, not raised. In PL/pgSQL a RAISE
-- aborts the enclosing statement, which would roll back the very counter update
-- this function exists to perform (the first version of this migration did
-- exactly that: a wrong guess raised TOKEN_INVALID and the attempts increment
-- was silently undone). Callers read `ok` and translate `reason` themselves.
--
-- The old two-argument signature is dropped, not overloaded, so there is no
-- path that can still call the unbound version. Idempotent.
-- ============================================================================

begin;

drop function if exists public.rpc_consume_email_token(text, public.auth_token_kind);
drop function if exists public.rpc_consume_email_token(text, public.auth_token_kind, uuid);

create or replace function public.rpc_consume_email_token(
  p_token_hash text,
  p_kind       public.auth_token_kind,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token      public.auth_tokens;
  v_profile    public.profiles;
  v_remaining  integer;
begin
  -- Row lock makes double-submit impossible: the second caller sees
  -- consumed_at already set and is rejected.
  select * into v_token
    from public.auth_tokens
   where token_hash = p_token_hash
     and kind = p_kind
     and consumed_at is null
     and (p_user_id is null or user_id = p_user_id)
   order by created_at desc
   limit 1
   for update;

  if v_token.id is null then
    -- No match. If we know which account is being verified, charge the guess
    -- to that account's live token so max_attempts actually means something.
    if p_user_id is not null then
      update public.auth_tokens
         set attempts = attempts + 1
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null;

      update public.auth_tokens
         set consumed_at = now()
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null
         and attempts >= max_attempts;

      select coalesce(min(max_attempts - attempts), 0) into v_remaining
        from public.auth_tokens
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null;
    end if;

    return jsonb_build_object(
      'ok', false,
      'reason', 'TOKEN_INVALID',
      'attempts_remaining', coalesce(v_remaining, 0)
    );
  end if;

  if v_token.expires_at < now() then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_EXPIRED', 'attempts_remaining', 0);
  end if;

  if v_token.attempts >= v_token.max_attempts then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_ATTEMPTS_EXCEEDED', 'attempts_remaining', 0);
  end if;

  update public.auth_tokens
     set consumed_at = now(), attempts = attempts + 1
   where id = v_token.id;

  if p_kind = 'email_verification' then
    update public.profiles
       set email_verified_at = coalesce(email_verified_at, now())
     where id = v_token.user_id
     returning * into v_profile;
  else
    select * into v_profile from public.profiles where id = v_token.user_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_token.user_id,
    'email', v_profile.email,
    'email_verified_at', v_profile.email_verified_at
  );
end;
$$;

revoke all on function public.rpc_consume_email_token(text, public.auth_token_kind, uuid)
  from public, anon, authenticated;
grant execute on function public.rpc_consume_email_token(text, public.auth_token_kind, uuid)
  to service_role;

commit;


-- ############################################################################
-- ## 005_catalog_markup.sql
-- ############################################################################

-- ============================================================================
-- 005 — CATALOGUE MARKUP PERSISTENCE
--
-- `rpc_sync_services` originally stored supplier_price and the final price but
-- dropped the markup that connected them, so services.markup_bps kept its
-- column default (1500) no matter what the admin configured. The catalogue then
-- displayed one price while the checkout recomputed another from the stale
-- markup.
--
-- The function now persists markup_bps as part of the sync payload. Existing
-- rows keep their stored price until the next successful sync, which is the
-- correct behaviour: a price shown to a customer is only replaced by a fresh
-- quote from the supplier.
--
-- Idempotent (CREATE OR REPLACE). The same definition is in database/functions.sql
-- so a fresh install never needs to run this file.
-- ============================================================================

begin;

create or replace function public.rpc_sync_services(
  p_provider text,
  p_server   text,
  p_services jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_codes text[];
  v_upserted integer := 0;
  v_deactivated integer := 0;
  v_item jsonb;
begin
  if p_services is null or jsonb_typeof(p_services) <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'services must be an array';
  end if;

  select array_agg(x->>'code') into v_codes
    from jsonb_array_elements(p_services) x
   where x ? 'code';

  for v_item in select * from jsonb_array_elements(p_services) loop
    insert into public.services
      (code, name, provider, provider_server, provider_app_id, app_name,
       country_id, country_name, country_iso, country_calling_code,
       supplier_price, markup_bps, price, stock, is_active, price_synced_at)
    values
      (v_item->>'code', v_item->>'name', coalesce(p_provider,'telekos'), p_server,
       v_item->>'provider_app_id', v_item->>'app_name',
       (v_item->>'country_id')::integer, v_item->>'country_name', v_item->>'country_iso',
       v_item->>'country_calling_code',
       nullif(v_item->>'supplier_price','')::numeric,
       coalesce(nullif(v_item->>'markup_bps','')::integer, 1500),
       nullif(v_item->>'price','')::numeric,
       coalesce((v_item->>'stock')::integer, 0),
       coalesce((v_item->>'is_active')::boolean, true),
       now())
    on conflict (code) do update
      set name = excluded.name,
          provider_app_id = excluded.provider_app_id,
          app_name = excluded.app_name,
          country_id = excluded.country_id,
          country_name = excluded.country_name,
          country_iso = excluded.country_iso,
          country_calling_code = excluded.country_calling_code,
          supplier_price = excluded.supplier_price,
          markup_bps = excluded.markup_bps,
          price = excluded.price,
          stock = excluded.stock,
          is_active = excluded.is_active,
          price_synced_at = now();
    v_upserted := v_upserted + 1;
  end loop;

  update public.services s
     set is_active = false
   where s.provider = coalesce(p_provider,'telekos')
     and s.provider_server = p_server
     and (v_codes is null or not (s.code = any(v_codes)))
     and s.is_active = true;
  get diagnostics v_deactivated = row_count;

  return jsonb_build_object('upserted', v_upserted, 'deactivated', v_deactivated);
end;
$$;

commit;


-- ============================================================================
-- DIAGNOSTIK — jalankan setelah migrasi selesai
-- ============================================================================
do $$
declare
  v_profiles_col boolean;
  v_tokens_tbl   boolean;
  v_no_password  integer;
  v_anon_tokens  boolean;
  v_cron_rows    integer;
  v_snapshot_col boolean;
  v_otp_args     integer;
begin
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='profiles' and column_name='password_hash')
    into v_profiles_col;
  select exists (select 1 from information_schema.tables
                  where table_schema='public' and table_name='auth_tokens') into v_tokens_tbl;
  select count(*) into v_no_password from public.profiles where password_hash is null;
  select has_table_privilege('anon', 'public.auth_tokens', 'select') into v_anon_tokens;
  select count(*) into v_cron_rows from public.cron_locks;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='orders' and column_name='pricing_snapshot')
    into v_snapshot_col;
  select pronargs::int into v_otp_args from pg_proc where proname = 'rpc_consume_email_token' limit 1;

  raise notice 'profiles.password_hash ada        : % (harus t)', v_profiles_col;
  raise notice 'auth_tokens ada                   : % (harus t)', v_tokens_tbl;
  raise notice 'profiles tanpa password           : % (semua pengguna lama harus reset password)', v_no_password;
  raise notice 'anon bisa baca auth_tokens        : % (harus f)', v_anon_tokens;
  raise notice 'cron_locks terisi                 : % (harus 3)', v_cron_rows;
  raise notice 'orders.pricing_snapshot ada       : % (harus t)', v_snapshot_col;
  raise notice 'rpc_consume_email_token argumen   : % (harus 3 — terikat user)', v_otp_args;
end $$;


-- ============================================================================
-- MIGRATION 012 — allow documented AstraPay QRIS/service fees safely.
-- Migration 011 assumed all gateway fees were always zero. Keep that migration
-- immutable; replace the RPCs with checks that permit non-negative declared fees while
-- allowing a separate payment unique code in pay_amount; wallet credit remains
-- base_amount only.
-- Apply after migration 011. This migration is additive/idempotent.
-- ============================================================================
begin;

create or replace function public.rpc_store_astrapay_invoice(
  p_deposit_id uuid,
  p_provider_order_id text,
  p_reference text,
  p_pay_amount numeric,
  p_fee_amount numeric,
  p_checkout_url text,
  p_qris_payload text,
  p_expires_at timestamptz,
  p_provider_status text default 'pending'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
begin
  if p_provider_order_id is null or char_length(p_provider_order_id) not between 1 and 120
     or p_reference is null or p_pay_amount is null or p_fee_amount is null
     or p_fee_amount < 0 or p_fee_amount <> trunc(p_fee_amount)
     or p_checkout_url is null
     or p_checkout_url !~ '^https://gateway\.astrapay\.biz\.id/pay/'
     or p_qris_payload is null or char_length(p_qris_payload) > 10000
     or p_expires_at is null or p_expires_at <= now()
     or p_expires_at > now() + interval '11 minutes'
     or coalesce(p_provider_status, '') <> 'pending' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_PROVIDER_CONTRACT_INVALID';
  end if;

  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found or v_deposit.method <> 'gateway' or v_deposit.provider_reference <> p_reference then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ORDER_MISMATCH';
  end if;
  if v_deposit.status not in ('pending','approved') then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED';
  end if;
  if p_pay_amount < v_deposit.amount or p_pay_amount <> trunc(p_pay_amount)
     or p_pay_amount < v_deposit.amount + p_fee_amount then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  if v_deposit.provider_order_id is not null and v_deposit.provider_order_id <> p_provider_order_id then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ORDER_MISMATCH';
  end if;

  update public.deposits
     set provider_order_id = p_provider_order_id,
         checkout_url = p_checkout_url,
         qris_payload = p_qris_payload,
         pay_amount = p_pay_amount,
         fee_amount = p_fee_amount,
         provider_status = p_provider_status,
         expires_at = p_expires_at
   where id = p_deposit_id
  returning * into v_deposit;
  return jsonb_build_object('deposit', to_jsonb(v_deposit));
end;
$$;

create or replace function public.rpc_confirm_astrapay_deposit(
  p_event_id text,
  p_event_type text,
  p_provider_order_id text,
  p_reference text,
  p_base_amount numeric,
  p_fee_amount numeric,
  p_pay_amount numeric,
  p_paid_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
  v_event_id text;
  v_ledger jsonb;
begin
  if p_event_id is null or p_event_type is null or p_event_id !~ '^[a-f0-9]{64}$'
     or p_event_type not in ('order.paid','reconciliation.paid')
     or p_provider_order_id is null or char_length(p_provider_order_id) not between 1 and 120
     or p_reference is null or p_base_amount is null or p_fee_amount is null
     or p_fee_amount < 0 or p_fee_amount <> trunc(p_fee_amount)
     or p_pay_amount is null or p_paid_at is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  insert into public.payment_webhook_events
    (event_id, event_type, provider_order_id, provider_reference)
  values
    (p_event_id, p_event_type, p_provider_order_id, p_reference)
  on conflict (event_id) do nothing
  returning event_id into v_event_id;
  if v_event_id is null then
    return jsonb_build_object('duplicate', true, 'credited', false);
  end if;

  select * into v_deposit
    from public.deposits
   where provider_reference = p_reference
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND';
  end if;
  if v_deposit.method <> 'gateway' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ORDER_MISMATCH';
  end if;

  if v_deposit.status = 'approved' then
    if v_deposit.provider_order_id = p_provider_order_id
       and v_deposit.approved_amount = p_base_amount then
      update public.payment_webhook_events set processed_at = now() where event_id = p_event_id;
      return jsonb_build_object('duplicate', true, 'credited', false, 'deposit', to_jsonb(v_deposit));
    end if;
    raise exception using errcode = 'P0001', message = 'PAYMENT_ORDER_MISMATCH';
  end if;
  if v_deposit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED';
  end if;
  if (v_deposit.provider_order_id is not null and v_deposit.provider_order_id <> p_provider_order_id)
     or p_base_amount <> v_deposit.amount
     or p_fee_amount < 0
     or p_pay_amount < p_base_amount + p_fee_amount
     or p_pay_amount < p_base_amount
     or p_pay_amount <> trunc(p_pay_amount)
     or (v_deposit.pay_amount is not null and p_pay_amount <> v_deposit.pay_amount)
     or (v_deposit.expires_at is not null and p_paid_at > v_deposit.expires_at)
     or p_paid_at > now() + interval '5 minutes' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  v_ledger := public._wallet_apply(
    v_deposit.user_id, 'deposit', 'credit', p_base_amount,
    'deposit', v_deposit.id, 'Deposit AstraPay terverifikasi', null,
    jsonb_build_object(
      'provider', 'astrapay',
      'provider_order_id', p_provider_order_id,
      'reference', p_reference,
      'base_amount', p_base_amount,
      'fee_amount', p_fee_amount,
      'pay_amount', p_pay_amount,
      'paid_at', p_paid_at
    )
  );

  update public.deposits
     set status = 'approved', approved_amount = p_base_amount,
         reviewed_by = null, reviewed_at = now(), paid_at = p_paid_at,
         provider_order_id = p_provider_order_id, pay_amount = p_pay_amount,
         fee_amount = p_fee_amount, provider_status = 'paid'
   where id = v_deposit.id
  returning * into v_deposit;

  update public.payment_webhook_events set processed_at = now() where event_id = p_event_id;
  return jsonb_build_object(
    'duplicate', false,
    'credited', true,
    'deposit', to_jsonb(v_deposit),
    'balance', v_ledger->'balance'
  );
end;
$$;

commit;

-- ============================================================================
-- Migration 013: TeleKos webhook retry recovery
-- Apply after migration 012. A failed delivery remains retryable; successful
-- deliveries stay idempotent and are never processed twice.
-- ============================================================================
create or replace function public.rpc_record_webhook_event(
  p_delivery_id text,
  p_event_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
  v_retried boolean := false;
begin
  insert into public.supplier_webhook_events (delivery_id, event_type, payload)
  values (p_delivery_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    update public.supplier_webhook_events
       set error = null
     where delivery_id = p_delivery_id
       and processed_at is null
       and error is not null
    returning id into v_id;
    v_retried := v_id is not null;
  end if;

  if v_id is null then
    return jsonb_build_object('inserted', false);
  end if;
  return jsonb_build_object('inserted', true, 'id', v_id, 'retried', v_retried);
end;
$$;
