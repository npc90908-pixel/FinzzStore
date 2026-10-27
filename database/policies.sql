-- ============================================================================
-- FINZZ STORE V2 — ROW LEVEL SECURITY & PRIVILEGES
-- Apply after schema.sql, before functions.sql
--
-- Threat model
--  * The browser never holds a Supabase key in this application (BFF pattern),
--    so RLS is defence in depth for the case where the anon key leaks or the
--    project is queried directly through PostgREST.
--  * Rules enforced here:
--      - a user may read only their own rows;
--      - no user may write balances, ledger rows, orders, OTPs, roles, prices,
--        deposit statuses or payment results;
--      - only admins may read the audit log and other users' profiles;
--      - anon may read the public catalog only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: is the caller an active admin?
-- SECURITY DEFINER so it can read profiles regardless of the caller's RLS.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.status = 'active'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Guard: privileged profile columns can only change through trusted RPCs
-- (service_role / postgres). Even if table grants were mis-configured, a normal
-- authenticated user cannot promote themselves or change their own status.
-- ----------------------------------------------------------------------------
create or replace function public.guard_profiles_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller text := current_user;
begin
  -- Only the restricted PostgREST roles are policed here. Trusted roles
  -- (postgres table owner, service_role, supabase_admin) manage these
  -- columns exclusively through audited RPCs.
  if caller not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'FORBIDDEN_COLUMN' using detail = 'role may not be changed by this caller';
  end if;
  if new.status is distinct from old.status then
    raise exception 'FORBIDDEN_COLUMN' using detail = 'status may not be changed by this caller';
  end if;
  if new.email is distinct from old.email then
    raise exception 'FORBIDDEN_COLUMN' using detail = 'email is managed by Supabase Auth';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profiles_privileged_columns();

-- ============================================================================
-- ENABLE RLS
-- ============================================================================
alter table public.profiles              enable row level security;
alter table public.wallets               enable row level security;
alter table public.wallet_transactions   enable row level security;
alter table public.deposits              enable row level security;
alter table public.services              enable row level security;
alter table public.orders                enable row level security;
alter table public.order_events          enable row level security;
alter table public.app_settings          enable row level security;
alter table public.admin_audit_logs      enable row level security;
alter table public.sessions              enable row level security;
alter table public.idempotency_keys      enable row level security;
alter table public.supplier_webhook_events enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.rate_limits           enable row level security;
alter table public.job_leases            enable row level security;
alter table public.catalog_sync_runs     enable row level security;

-- NOTE: we deliberately do NOT use `force row level security`.
-- In Supabase the tables are owned by `postgres`, and the SECURITY DEFINER
-- RPCs in functions.sql execute as that owner. Forcing RLS on the owner would
-- make every financial RPC fail (there are no write policies, by design).
-- anon / authenticated / service_role still go through RLS exactly as
-- intended, and service_role additionally has BYPASSRLS.


-- ============================================================================
-- REVOKE ALL, THEN GRANT THE MINIMUM
-- Supabase grants broad privileges to anon/authenticated by default; we reset
-- them explicitly so the policies below are the only way in.
-- ============================================================================
revoke all on public.profiles              from anon, authenticated;
revoke all on public.wallets               from anon, authenticated;
revoke all on public.wallet_transactions   from anon, authenticated;
revoke all on public.deposits              from anon, authenticated;
revoke all on public.services              from anon, authenticated;
revoke all on public.orders                from anon, authenticated;
revoke all on public.order_events          from anon, authenticated;
revoke all on public.app_settings          from anon, authenticated;
revoke all on public.admin_audit_logs      from anon, authenticated;
revoke all on public.sessions              from anon, authenticated;
revoke all on public.idempotency_keys      from anon, authenticated;
revoke all on public.supplier_webhook_events from anon, authenticated;
revoke all on public.payment_webhook_events from anon, authenticated;
revoke all on public.rate_limits           from anon, authenticated;
revoke all on public.job_leases            from anon, authenticated;
revoke all on public.catalog_sync_runs     from anon, authenticated;

-- sequences behind identity columns
revoke all on sequence public.order_events_id_seq from anon, authenticated;
revoke all on sequence public.admin_audit_logs_id_seq from anon, authenticated;
revoke all on sequence public.supplier_webhook_events_id_seq from anon, authenticated;
revoke all on sequence public.catalog_sync_runs_id_seq from anon, authenticated;

-- Read-only, owner scoped
grant select on public.profiles to authenticated;
grant update (full_name, phone, username) on public.profiles to authenticated;

grant select on public.wallets to authenticated;
grant select on public.wallet_transactions to authenticated;
grant select on public.deposits to authenticated;
-- Orders are readable by their owner, but the raw OTP content is NOT part of
-- any API role's column grants. OTP values are served exclusively by the Node
-- backend to the authenticated owner of the order (service role, audited).
grant select (id, user_id, service_id, status, provider, provider_app_name,
              provider_country_name, provider_country_iso, phone_number,
              otp_received_at, otp_count, supplier_price, markup_amount,
              tax_amount, total_price, currency, can_cancel, cancel_available_at,
              expires_at, completed_at, closed_at, refunded_at, created_at, updated_at)
  on public.orders to authenticated;
grant select on public.order_events to authenticated;
grant select on public.app_settings to anon, authenticated;
grant select on public.services to anon, authenticated;

-- Deposit requests may be opened by their owner; approval is RPC-only.
grant insert (user_id, amount, method, user_note, proof_path, proof_mime, proof_size, proof_sha256, status)
  on public.deposits to authenticated;

-- ============================================================================
-- POLICIES
-- ============================================================================

-- profiles ---------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- wallets ----------------------------------------------------------------
drop policy if exists wallets_select_own on public.wallets;
create policy wallets_select_own on public.wallets
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- no insert/update/delete policy: balances are RPC-only.

-- wallet_transactions ----------------------------------------------------
drop policy if exists wallet_tx_select_own on public.wallet_transactions;
create policy wallet_tx_select_own on public.wallet_transactions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- append-only: no write policies at all.

-- deposits ---------------------------------------------------------------
drop policy if exists deposits_select_own on public.deposits;
create policy deposits_select_own on public.deposits
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists deposits_insert_own on public.deposits;
create policy deposits_insert_own on public.deposits
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and approved_amount is null
    and method = 'manual_transfer'
  );
-- no update/delete policy: review happens through SECURITY DEFINER RPCs.

-- services ---------------------------------------------------------------
drop policy if exists services_read_active on public.services;
create policy services_read_active on public.services
  for select to anon, authenticated
  using (is_active = true or public.is_admin());
-- catalog is written by the sync job through the service role only.

-- orders -----------------------------------------------------------------
drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- no write policies: orders are created/updated by SECURITY DEFINER RPCs.

-- order_events -----------------------------------------------------------
drop policy if exists order_events_select_own on public.order_events;
create policy order_events_select_own on public.order_events
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_events.order_id
        and (o.user_id = auth.uid() or public.is_admin())
    )
  );

-- app_settings -----------------------------------------------------------
drop policy if exists app_settings_read_public on public.app_settings;
create policy app_settings_read_public on public.app_settings
  for select to anon, authenticated
  using (is_public = true or public.is_admin());

-- admin_audit_logs -------------------------------------------------------
drop policy if exists audit_select_admin on public.admin_audit_logs;
create policy audit_select_admin on public.admin_audit_logs
  for select to authenticated
  using (public.is_admin());

-- Internal tables --------------------------------------------------------
-- sessions, idempotency_keys, supplier_webhook_events, payment_webhook_events,
-- rate_limits, job_leases, catalog_sync_runs: RLS enabled and intentionally NO policies.
-- Only the service role (server) can touch them.

comment on table public.sessions is 'Server side sessions. Cookie value is stored as sha256; Supabase refresh token is AES-256-GCM encrypted. Service role only.';
comment on table public.wallets is 'Balance is numeric(18,2) and can only be mutated by SECURITY DEFINER RPCs in functions.sql.';
