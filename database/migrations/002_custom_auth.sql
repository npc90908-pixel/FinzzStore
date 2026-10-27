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
