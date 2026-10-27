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
