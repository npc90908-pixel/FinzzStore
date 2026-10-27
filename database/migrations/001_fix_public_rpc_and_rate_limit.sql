-- ============================================================================
-- MIGRATION 001 — repair the public RPCs and the distributed rate limiter
--
-- Context: production (Vercel) on 2026-10-26 logged
--     "RPC rpc_public_summary gagal"      -> GET /api/public/catalog 500
--     "RPC rpc_rate_limit_hit gagal"      -> limiter fell back to per-instance
--                                            memory, i.e. no limit at all on
--                                            serverless
--
-- Properties of this migration:
--   * idempotent            — safe to run more than once
--   * non-destructive       — no DROP TABLE, no DELETE, no TRUNCATE, no UPDATE
--   * RLS stays ON          — no `disable row level security` anywhere
--   * grants are explicit   — service_role for writes, anon/authenticated only
--                             for the read-only summary
--   * reloads PostgREST's schema cache so a freshly created function is
--     immediately callable through /rest/v1/rpc/*
--
-- Run with:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/001_fix_public_rpc_and_rate_limit.sql
-- or paste it into the Supabase SQL editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Preconditions (fail loudly with a readable message instead of silently
--    creating a half-working database)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.services') is null then
    raise exception 'MIGRATION_ABORTED: public.services is missing — run database/schema.sql first';
  end if;
  if to_regclass('public.app_settings') is null then
    raise exception 'MIGRATION_ABORTED: public.app_settings is missing — run database/schema.sql first';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. rate limiter storage
--    The counter table is shared by every serverless instance. It must exist
--    before the RPC can be created; `create table if not exists` keeps this
--    migration safe on databases that already have it.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket_key   text primary key,
  window_start timestamptz not null,
  counter      integer not null default 0,
  updated_at   timestamptz not null default now()
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- RLS stays enabled. anon/authenticated hold no table privilege at all, so a
-- permissive policy for service_role adds no attack surface; it exists so the
-- counter stays usable no matter which role ends up owning the function.
alter table public.rate_limits enable row level security;

drop policy if exists rate_limits_service_all on public.rate_limits;
create policy rate_limits_service_all on public.rate_limits
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.rate_limits to service_role;

-- ---------------------------------------------------------------------------
-- 2. rpc_rate_limit_hit — atomic sliding counter
--    `create or replace` keeps the signature stable, so an existing grant is
--    preserved; the grants below are re-issued anyway to repair a database
--    where they were never applied.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_counter integer;
  v_start   timestamptz;
  v_reset   timestamptz;
begin
  if p_key is null or char_length(p_key) < 1 or char_length(p_key) > 200 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'rate limit key invalid';
  end if;
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'rate limit window invalid';
  end if;

  insert into public.rate_limits (bucket_key, window_start, counter, updated_at)
  values (p_key, now(), 1, now())
  on conflict (bucket_key) do update
    set counter = case
          when public.rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
            then 1
          else public.rate_limits.counter + 1
        end,
        window_start = case
          when public.rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
            then now()
          else public.rate_limits.window_start
        end,
        updated_at = now()
  returning counter, window_start into v_counter, v_start;

  v_reset := v_start + make_interval(secs => p_window_seconds);

  return jsonb_build_object(
    'allowed',   v_counter <= p_limit,
    'limit',     p_limit,
    'remaining', greatest(p_limit - v_counter, 0),
    'count',     v_counter,
    'reset_at',  v_reset
  );
end;
$$;

revoke all on function public.rpc_rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rpc_rate_limit_hit(text, integer, integer) from anon, authenticated;
grant execute on function public.rpc_rate_limit_hit(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. rpc_public_summary — aggregate counts for the storefront
--    `stable` + explicit search_path. Returns real counts only; there is no
--    fallback that could invent stock, price or traffic numbers.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_public_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'active_services',   (select count(*) from public.services where is_active = true),
    'countries',         (select count(distinct country_id) from public.services where is_active = true),
    'apps',              (select count(distinct provider_app_id) from public.services where is_active = true),
    'last_catalog_sync', (select max(price_synced_at) from public.services),
    'generated_at',      now()
  ) into v;
  return v;
end;
$$;

revoke all on function public.rpc_public_summary() from public;
-- Read-only aggregate, safe for the public read path.
grant execute on function public.rpc_public_summary() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Public read path — make sure the tables the endpoints touch are actually
--    readable by the API roles and covered by RLS policies.
--    (Re-stated here because a partially applied policies.sql is one of the
--    ways this incident can happen.)
-- ---------------------------------------------------------------------------
grant select on public.services to anon, authenticated;
grant select on public.app_settings to anon, authenticated;

alter table public.services     enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists services_read_active on public.services;
create policy services_read_active on public.services
  for select
  using (is_active = true);

drop policy if exists app_settings_read_public on public.app_settings;
create policy app_settings_read_public on public.app_settings
  for select
  using (is_public = true);

-- The server reads both tables with the service role (BYPASSRLS). If it ever
-- runs with a role that does not bypass RLS, this policy keeps the *public*
-- read path working for the values that are already public.
drop policy if exists services_service_all on public.services;
create policy services_service_all on public.services
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists app_settings_service_all on public.app_settings;
create policy app_settings_service_all on public.app_settings
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 5. Diagnostics — printed to the migration output so a reviewer can see the
--    effective state without querying by hand.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner text;
  v_bypass boolean;
  v_count bigint;
  v_public bigint;
begin
  select r.rolname, r.rolbypassrls
    into v_owner, v_bypass
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.rpc_rate_limit_hit(text,integer,integer)'::regprocedure;

  select count(*) into v_count from public.app_settings;
  select count(*) into v_public from public.app_settings where is_public = true;

  raise notice 'rpc_rate_limit_hit owner=% bypassrls=%', v_owner, v_bypass;
  if not coalesce(v_bypass, false) then
    raise notice 'NOTE: the function owner does not have BYPASSRLS. The service_role policy above keeps rate limiting working, but running this migration as `postgres` (or another BYPASSRLS role) is recommended.';
  end if;
  raise notice 'app_settings rows=% public_rows=%', v_count, v_public;
  if v_public = 0 then
    raise notice 'NOTE: no public settings row exists — /api/public/config will report settingsAvailable=false until app_settings is seeded (scripts/seed-dev.mjs).';
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- 6. Refresh PostgREST's schema cache.
--    Without this, a function created seconds ago still answers
--    PGRST202 "Could not find the function ... in the schema cache".
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
