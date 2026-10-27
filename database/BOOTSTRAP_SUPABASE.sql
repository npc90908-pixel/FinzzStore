-- ============================================================================
-- FINZZ STORE — BOOTSTRAP DATABASE SUPABASE (SATU KALI JALAN)
--
-- KENAPA FILE INI ADA:
--   Log produksi 26 Okt 2026 menunjukkan PostgREST menjawab
--     PGRST205  Could not find the table 'public.services' in the schema cache
--     PGRST205  Could not find the table 'public.app_settings' in the schema cache
--     PGRST202  rpc_public_summary tidak ditemukan
--   Artinya skema database belum pernah diterapkan ke project Supabase ini.
--   Karena itu /api/public/catalog, /api/public/config, dan /api/public/summary
--   gagal — bukan karena kode aplikasi.
--
-- CARA PAKAI:
--   1. Supabase Dashboard → SQL Editor → New query
--   2. Tempel SELURUH isi file ini → Run (butuh beberapa detik)
--   3. Di bagian paling bawah ada blok "HASIL PEMERIKSAAN" — baca outputnya
--   4. Buka https://finzzstore.vercel.app/api/public/summary → harus 200
--
-- SIFATNYA:
--   · idempoten — boleh dijalankan berulang tanpa error
--   · tidak menghapus data apa pun
--   · tidak mematikan RLS (malah mengaktifkan RLS di semua tabel)
--   · berhenti dengan pesan jelas kalau ada yang tidak beres
--
-- ISI (berurutan):
--   1. schema.sql      — 15 tabel, tipe enum, index, trigger
--   2. policies.sql    — RLS + grant (anon hanya boleh baca katalog publik)
--   3. functions.sql   — 28 fungsi RPC (semua mutasi uang atomik)
--   4. migrations/001  — rpc_public_summary, rpc_rate_limit_hit, perbaikan grant
-- ============================================================================

-- Pastikan role standar Supabase ada (di project Supabase selalu ada; di DB
-- lokal file ini memakai peran yang sudah disiapkan).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'Role anon tidak ditemukan. Jalankan di project Supabase, bukan di server lain.';
  end if;
end
$$;

create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;

-- ============================================================================
-- BAGIAN 1/4 — SCHEMA
-- ============================================================================
-- ============================================================================
-- FINZZ STORE V2 — DATABASE SCHEMA
-- Target : Supabase PostgreSQL 15+ (verified locally against PostgreSQL 17)
-- Apply  : Supabase Dashboard > SQL Editor, or `psql` with a privileged role.
-- Order  : schema.sql -> policies.sql -> functions.sql
--
-- Notes
--  * Money is stored as numeric(18,2). The application layer represents money
--    as integer rupiah and never uses floating point arithmetic.
--  * Users are identified by auth.users.id (Supabase Auth). There is no custom
--    password table anywhere in this schema.
--  * Public registration never grants the admin role (see profiles.role default
--    and policies.sql / functions.sql which revoke privilege escalation paths).
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('user', 'admin');
  end if;
  if not exists (select 1 from pg_type where typname = 'account_status') then
    create type public.account_status as enum ('active', 'suspended', 'banned');
  end if;
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type public.order_status as enum (
      'pending',      -- wallet debited, supplier purchase in flight (never visible as success)
      'waiting',      -- supplier issued a number, waiting for OTP
      'received',     -- OTP received, awaiting completion
      'completed',    -- terminal: OTP delivered, order finished at supplier
      'cancelled',    -- terminal: cancelled at supplier, refunded
      'expired',      -- terminal: supplier expired the order without OTP, refunded
      'failed',       -- terminal: supplier rejected the purchase, refunded
      'needs_review'  -- terminal-ish: ambiguous supplier result, requires reconciliation
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'deposit_status') then
    create type public.deposit_status as enum ('pending', 'approved', 'rejected', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'wallet_tx_type') then
    create type public.wallet_tx_type as enum ('deposit', 'purchase', 'refund', 'adjustment');
  end if;
  if not exists (select 1 from pg_type where typname = 'wallet_tx_direction') then
    create type public.wallet_tx_direction as enum ('credit', 'debit');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type public.payment_method as enum ('manual_transfer', 'gateway');
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- updated_at helper
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- app_settings
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  is_public   boolean not null default false,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint app_settings_key_format check (key ~ '^[a-z0-9_]{3,60}$')
);

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create or replace trigger trg_app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  username      text,
  full_name     text,
  phone         text,
  role          public.user_role not null default 'user',
  status        public.account_status not null default 'active',
  email_verified_at timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_email_format check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint profiles_username_format check (username is null or username ~ '^[a-zA-Z0-9_]{3,24}$'),
  constraint profiles_full_name_length check (full_name is null or char_length(full_name) between 1 and 80)
);

create unique index if not exists profiles_email_lower_key on public.profiles (lower(email));
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username)) where username is not null;
create index if not exists profiles_role_idx on public.profiles (role) where role = 'admin';
create index if not exists profiles_created_at_idx on public.profiles (created_at desc);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create or replace trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- wallets — balance is only ever mutated by SECURITY DEFINER RPCs
-- ----------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  balance     numeric(18,2) not null default 0,
  currency    char(3) not null default 'IDR',
  version     bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint wallets_balance_non_negative check (balance >= 0),
  constraint wallets_currency_supported check (currency = 'IDR')
);

drop trigger if exists trg_wallets_updated_at on public.wallets;
create or replace trigger trg_wallets_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- wallet_transactions — append-only ledger
-- ----------------------------------------------------------------------------
create table if not exists public.wallet_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  type            public.wallet_tx_type not null,
  direction       public.wallet_tx_direction not null,
  amount          numeric(18,2) not null,
  balance_before  numeric(18,2) not null,
  balance_after   numeric(18,2) not null,
  reference_type  text not null,
  reference_id    uuid,
  idempotency_key text,
  description     text,
  created_by      uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint wallet_tx_amount_positive check (amount > 0),
  constraint wallet_tx_balance_delta check (balance_after = balance_before + case when direction = 'credit' then amount else -amount end),
  constraint wallet_tx_reference_type_format check (reference_type ~ '^[a-z_]{3,40}$'),
  constraint wallet_tx_idempotency_key_format check (idempotency_key is null or char_length(idempotency_key) between 8 and 128)
);

-- One refund per order, one credit per deposit, one debit per order, etc.
create unique index if not exists wallet_tx_unique_reference
  on public.wallet_transactions (reference_type, reference_id, type)
  where reference_id is not null;

create unique index if not exists wallet_tx_idempotency_key
  on public.wallet_transactions (user_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists wallet_tx_user_created_idx
  on public.wallet_transactions (user_id, created_at desc);
create index if not exists wallet_tx_created_at_idx
  on public.wallet_transactions (created_at desc);

-- ----------------------------------------------------------------------------
-- deposits
-- ----------------------------------------------------------------------------
create table if not exists public.deposits (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  amount         numeric(18,2) not null,
  approved_amount numeric(18,2),
  status         public.deposit_status not null default 'pending',
  method         public.payment_method not null default 'manual_transfer',
  unique_code    smallint,
  proof_path     text,
  proof_mime     text,
  proof_size     integer,
  proof_sha256   text,
  user_note      text,
  admin_note     text,
  reviewed_by    uuid references public.profiles (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint deposits_amount_positive check (amount > 0),
  constraint deposits_amount_max check (amount <= 100000000),
  constraint deposits_proof_mime_allowed check (proof_mime is null or proof_mime in ('image/png','image/jpeg','image/webp','application/pdf')),
  constraint deposits_proof_size_limit check (proof_size is null or (proof_size > 0 and proof_size <= 5242880)),
  constraint deposits_user_note_length check (user_note is null or char_length(user_note) <= 500),
  constraint deposits_admin_note_length check (admin_note is null or char_length(admin_note) <= 500),
  constraint deposits_approved_amount_valid check (approved_amount is null or approved_amount > 0),
  -- A pending deposit must not carry review metadata; a reviewed one must.
  constraint deposits_review_consistency check (
    (status = 'pending' and reviewed_at is null and reviewed_by is null)
    or (status in ('approved','rejected') and reviewed_at is not null and reviewed_by is not null)
    or (status = 'cancelled')
  )
);

create index if not exists deposits_user_created_idx on public.deposits (user_id, created_at desc);
create index if not exists deposits_status_created_idx on public.deposits (status, created_at desc);
create index if not exists deposits_pending_idx on public.deposits (created_at) where status = 'pending';

drop trigger if exists trg_deposits_updated_at on public.deposits;
create or replace trigger trg_deposits_updated_at
  before update on public.deposits
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- services (catalog synced from the supplier, sellable to customers)
-- ----------------------------------------------------------------------------
create table if not exists public.services (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  provider           text not null default 'telekos',
  provider_server    text not null default 'server1',
  provider_app_id    text not null,
  app_name           text not null,
  country_id         integer not null,
  country_name       text not null,
  country_iso        text,
  country_calling_code text,
  supplier_price     numeric(18,2),
  markup_bps         integer not null default 1500,
  price              numeric(18,2),
  stock              integer not null default 0,
  currency           char(3) not null default 'IDR',
  is_active          boolean not null default true,
  sort_order         integer not null default 100,
  price_synced_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint services_supplier_price_positive check (supplier_price is null or supplier_price >= 0),
  constraint services_price_positive check (price is null or price > 0),
  constraint services_markup_range check (markup_bps between 0 and 10000),
  constraint services_stock_non_negative check (stock >= 0),
  constraint services_code_format check (code ~ '^[a-z0-9-]{3,80}$'),
  constraint services_provider_server_format check (provider_server ~ '^[a-z0-9_-]{1,32}$')
);

create index if not exists services_active_idx on public.services (is_active, sort_order, price);
create index if not exists services_app_country_idx on public.services (provider_app_id, country_id);
create index if not exists services_price_synced_idx on public.services (price_synced_at desc);

drop trigger if exists trg_services_updated_at on public.services;
create or replace trigger trg_services_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- orders
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  service_id       uuid references public.services (id) on delete set null,
  idempotency_key  text not null,
  request_hash     text not null,
  status           public.order_status not null default 'pending',
  provider         text not null default 'telekos',
  provider_server  text not null,
  provider_app_id  text not null,
  provider_app_name text not null,
  provider_country_id integer not null,
  provider_country_name text not null,
  provider_country_iso text,
  provider_offer_id text,
  supplier_order_id text,
  phone_number     text,
  otp_code         text,
  otp_message      text,
  otp_sender       text,
  otp_received_at  timestamptz,
  otp_count        integer not null default 0,
  supplier_price   numeric(18,2) not null,
  markup_amount    numeric(18,2) not null default 0,
  tax_amount       numeric(18,2) not null default 0,
  total_price      numeric(18,2) not null,
  currency         char(3) not null default 'IDR',
  can_cancel       boolean not null default false,
  cancel_available_at timestamptz,
  cancel_requested_at timestamptz,
  expires_at       timestamptz,
  completed_at     timestamptz,
  closed_at        timestamptz,
  refunded_at      timestamptz,
  last_synced_at   timestamptz,
  next_sync_at     timestamptz not null default now(),
  sync_lease_until timestamptz,
  sync_owner       text,
  sync_attempts    integer not null default 0,
  last_error_code  text,
  last_error_message text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint orders_total_price_positive check (total_price > 0),
  constraint orders_supplier_price_non_negative check (supplier_price >= 0),
  constraint orders_markup_non_negative check (markup_amount >= 0 and tax_amount >= 0),
  constraint orders_price_math check (total_price = supplier_price + markup_amount + tax_amount),
  constraint orders_idempotency_key_format check (char_length(idempotency_key) between 8 and 128),
  constraint orders_request_hash_format check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint orders_otp_code_format check (otp_code is null or char_length(otp_code) <= 32),
  constraint orders_supplier_order_id_format check (supplier_order_id is null or supplier_order_id ~ '^[A-Za-z0-9_-]{4,80}$')
);

create unique index if not exists orders_user_idempotency_key
  on public.orders (user_id, idempotency_key);
create index if not exists orders_user_created_idx on public.orders (user_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_active_sync_idx
  on public.orders (next_sync_at)
  where status in ('pending', 'waiting', 'received', 'needs_review');
create index if not exists orders_supplier_order_id_idx on public.orders (supplier_order_id);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

drop trigger if exists trg_orders_updated_at on public.orders;
create or replace trigger trg_orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- order_events — append-only audit trail of every order transition
-- ----------------------------------------------------------------------------
create table if not exists public.order_events (
  id          bigserial primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  event_type  text not null,
  from_status public.order_status,
  to_status   public.order_status,
  source      text not null default 'system',
  actor_id    uuid,
  message     text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint order_events_event_type_format check (event_type ~ '^[a-z_]{3,40}$'),
  constraint order_events_source_allowed check (source in ('user','system','supplier','admin','webhook')),
  constraint order_events_message_length check (message is null or char_length(message) <= 500)
);

create index if not exists order_events_order_idx on public.order_events (order_id, id);
create index if not exists order_events_created_idx on public.order_events (created_at desc);

-- ----------------------------------------------------------------------------
-- admin_audit_logs
-- ----------------------------------------------------------------------------
create table if not exists public.admin_audit_logs (
  id          bigserial primary key,
  admin_id    uuid not null references public.profiles (id) on delete restrict,
  action      text not null,
  target_type text not null,
  target_id   text,
  reason      text,
  before      jsonb,
  after       jsonb,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  constraint audit_action_format check (action ~ '^[a-z0-9_.]{3,60}$'),
  constraint audit_target_type_format check (target_type ~ '^[a-z_]{3,40}$')
);

create index if not exists audit_admin_created_idx on public.admin_audit_logs (admin_id, created_at desc);
create index if not exists audit_target_idx on public.admin_audit_logs (target_type, target_id);
create index if not exists audit_created_idx on public.admin_audit_logs (created_at desc);

-- ----------------------------------------------------------------------------
-- sessions — server-side session envelopes (cookie value is hashed)
-- ----------------------------------------------------------------------------
create table if not exists public.sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  token_hash         text not null unique,
  csrf_hash          text not null,
  -- Supabase refresh token, encrypted at rest with APP_ENCRYPTION_KEY (AES-256-GCM)
  refresh_token_enc  text not null,
  access_token_enc   text,
  access_expires_at  timestamptz,
  ip                 text,
  user_agent         text,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz not null default now(),
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  constraint sessions_token_hash_format check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint sessions_csrf_hash_format check (csrf_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists sessions_user_idx on public.sessions (user_id, created_at desc);
create index if not exists sessions_expires_idx on public.sessions (expires_at) where revoked_at is null;

-- ----------------------------------------------------------------------------
-- idempotency_keys — generic replay protection for mutating endpoints
-- ----------------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  scope         text not null,
  key           text not null,
  payload_hash  text not null,
  resource_id   uuid,
  created_at    timestamptz not null default now(),
  constraint idem_scope_format check (scope ~ '^[a-z_]{3,40}$'),
  constraint idem_key_length check (char_length(key) between 8 and 128),
  constraint idem_payload_hash_format check (payload_hash ~ '^[a-f0-9]{64}$')
);

create unique index if not exists idempotency_keys_unique
  on public.idempotency_keys (user_id, scope, key);

-- ----------------------------------------------------------------------------
-- supplier_webhook_events — idempotent webhook inbox
-- ----------------------------------------------------------------------------
create table if not exists public.supplier_webhook_events (
  id           bigserial primary key,
  delivery_id  text not null unique,
  event_type   text not null,
  payload      jsonb not null,
  order_id     uuid references public.orders (id) on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

create index if not exists webhook_events_received_idx on public.supplier_webhook_events (received_at desc);

-- ----------------------------------------------------------------------------
-- rate_limits — DB backed sliding counter shared by all PM2 workers
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket_key   text primary key,
  window_start timestamptz not null,
  counter      integer not null default 0,
  updated_at   timestamptz not null default now()
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- ----------------------------------------------------------------------------
-- job_leases — distributed locks for pollers / cron style jobs
-- ----------------------------------------------------------------------------
create table if not exists public.job_leases (
  name         text primary key,
  owner        text not null,
  locked_until timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb
);

-- ----------------------------------------------------------------------------
-- catalog sync metadata
-- ----------------------------------------------------------------------------
create table if not exists public.catalog_sync_runs (
  id          bigserial primary key,
  provider    text not null default 'telekos',
  status      text not null default 'running',
  server      text,
  services_seen integer not null default 0,
  services_upserted integer not null default 0,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  constraint catalog_sync_status_allowed check (status in ('running','success','partial','failed'))
);

create index if not exists catalog_sync_started_idx on public.catalog_sync_runs (started_at desc);

-- ----------------------------------------------------------------------------
-- Default settings (idempotent)
-- ----------------------------------------------------------------------------
insert into public.app_settings (key, value, description, is_public)
values
  ('store_profile', '{"name":"FINZZ Store","tagline":"Nomor virtual instan untuk verifikasi akun","support_email":"support@finzz.store","support_whatsapp":"","support_telegram":""}'::jsonb, 'Public store identity and support channels', true),
  ('deposit_policy', '{"min_amount":10000,"max_amount":5000000,"instructions":"Transfer ke rekening resmi yang tertera. Sertakan nominal unik pada berita transfer.","bank_accounts":[],"expiry_hours":24}'::jsonb, 'Manual deposit policy; bank_accounts must be filled by the owner', true),
  ('pricing_policy', '{"default_markup_bps":1500,"tax_bps":0,"tax_label":"PPN"}'::jsonb, 'Markup & tax configuration applied to supplier price', false),
  ('operations', '{"sales_open":true,"maintenance_message":"","order_poll_interval_ms":4000,"server_poll_interval_ms":15000,"order_expiry_seconds":1260,"max_active_orders_per_user":5}'::jsonb, 'Operational switches and polling cadence', true),
  ('refund_policy', '{"summary":"Refund otomatis hanya jika nomor tidak pernah menerima OTP dan supplier mengonfirmasi order selesai tanpa OTP. Refund dicatat pada ledger dan hanya terjadi satu kali."}'::jsonb, 'Customer facing refund policy summary', true),
  ('legal', '{"terms_version":"2026-10-01","privacy_version":"2026-10-01"}'::jsonb, 'Legal document versions', true),
  ('supplier', '{"provider":"telekos","server":"server1","app_allowlist":[],"sync_enabled":true}'::jsonb, 'Supplier integration switches (no secrets here)', false)
on conflict (key) do nothing;


-- ============================================================================
-- BAGIAN 2/4 — KEBIJAKAN RLS & GRANT
-- ============================================================================
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
-- sessions, idempotency_keys, supplier_webhook_events, rate_limits,
-- job_leases, catalog_sync_runs: RLS enabled and intentionally NO policies.
-- Only the service role (server) can touch them.

comment on table public.sessions is 'Server side sessions. Cookie value is stored as sha256; Supabase refresh token is AES-256-GCM encrypted. Service role only.';
comment on table public.wallets is 'Balance is numeric(18,2) and can only be mutated by SECURITY DEFINER RPCs in functions.sql.';


-- ============================================================================
-- BAGIAN 3/4 — FUNGSI RPC
-- ============================================================================
-- ============================================================================
-- FINZZ STORE V2 — RPC / TRANSACTIONAL FUNCTIONS
-- Apply after policies.sql
--
-- Conventions
--  * Every function pins `search_path = public, pg_temp`.
--  * Errors are raised as SQLSTATE P0001 with a stable machine code in
--    MESSAGE and a human readable hint in DETAIL. The Node backend maps the
--    code to an HTTP status; raw database errors are never sent to clients.
--  * Mutating functions are executable by the service role only. The public
--    read function rpc_public_summary() is the single anon-executable RPC.
--  * Money is numeric(18,2); every ledger row stores balance_before/after and
--    a CHECK enforces the arithmetic.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- INTERNAL: wallet ledger primitives (not granted to any API role)
-- ----------------------------------------------------------------------------
create or replace function public._wallet_apply(
  p_user_id        uuid,
  p_type           public.wallet_tx_type,
  p_direction      public.wallet_tx_direction,
  p_amount         numeric,
  p_reference_type text,
  p_reference_id   uuid,
  p_description    text,
  p_created_by     uuid default null,
  p_metadata       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet   public.wallets;
  v_before   numeric(18,2);
  v_after    numeric(18,2);
  v_tx_id    uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'amount must be positive';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'amount supports at most 2 decimals';
  end if;

  -- Create the wallet on demand, then lock it. The lock serialises every
  -- balance mutation for this user, which is what prevents double spending.
  insert into public.wallets (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'WALLET_NOT_FOUND';
  end if;

  v_before := v_wallet.balance;
  v_after  := case when p_direction = 'credit' then v_before + p_amount else v_before - p_amount end;

  if v_after < 0 then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_BALANCE',
      detail = format('balance %s is lower than required %s', v_before, p_amount);
  end if;

  update public.wallets
     set balance = v_after,
         version = v_wallet.version + 1
   where user_id = p_user_id;

  begin
    insert into public.wallet_transactions
      (user_id, type, direction, amount, balance_before, balance_after,
       reference_type, reference_id, description, created_by, metadata)
    values
      (p_user_id, p_type, p_direction, p_amount, v_before, v_after,
       p_reference_type, p_reference_id, p_description, p_created_by, coalesce(p_metadata, '{}'::jsonb))
    returning id into v_tx_id;
  exception
    when unique_violation then
      -- A ledger row for this reference already exists: duplicate refund /
      -- duplicate deposit credit / duplicate debit. Roll the balance change
      -- back by aborting the whole statement.
      raise exception using errcode = 'P0001', message = 'DUPLICATE_LEDGER_ENTRY',
        detail = format('%s for %s:%s already exists', p_type, p_reference_type, p_reference_id);
  end;

  return jsonb_build_object(
    'transaction_id', v_tx_id,
    'balance_before', v_before,
    'balance_after',  v_after,
    'balance',        v_after
  );
end;
$$;

create or replace function public._assert_admin(p_admin_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_admin_id is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'admin identity required';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_admin_id and role = 'admin' and status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'caller is not an active admin';
  end if;
end;
$$;

create or replace function public._audit(
  p_admin_id uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_reason text default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_ip text default null,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.admin_audit_logs
    (admin_id, action, target_type, target_id, reason, before, after, ip, user_agent)
  values
    (p_admin_id, p_action, p_target_type, p_target_id, p_reason, p_before, p_after, p_ip, p_user_agent);
end;
$$;

-- ----------------------------------------------------------------------------
-- PROVISIONING
-- ----------------------------------------------------------------------------
create or replace function public.ensure_user_profile(
  p_user_id  uuid,
  p_email    text,
  p_username text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_username text;
begin
  if p_user_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'user id required';
  end if;
  if p_email is null or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception using errcode = 'P0001', message = 'INVALID_EMAIL';
  end if;

  v_username := null;
  if p_username is not null and p_username ~ '^[a-zA-Z0-9_]{3,24}$' then
    v_username := lower(p_username);
    if exists (select 1 from public.profiles where lower(username) = v_username and id <> p_user_id) then
      v_username := null;
    end if;
  end if;

  insert into public.profiles (id, email, username)
  values (p_user_id, lower(p_email), v_username)
  on conflict (id) do update
    set email = excluded.email
    where public.profiles.email is distinct from excluded.email
  returning * into v_profile;

  insert into public.wallets (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  return jsonb_build_object(
    'profile', to_jsonb(v_profile),
    'wallet', (select to_jsonb(w) from public.wallets w where w.user_id = p_user_id)
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- RATE LIMITING (shared by all PM2 workers)
-- ----------------------------------------------------------------------------
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
  if p_key is null or char_length(p_key) > 200 then
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

-- ----------------------------------------------------------------------------
-- ORDER CREATION (debit + order + idempotency, single atomic transaction)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_create_order(
  p_user_id            uuid,
  p_service_id         uuid,
  p_idempotency_key    text,
  p_request_hash       text,
  p_supplier_price     numeric,
  p_markup_amount      numeric,
  p_tax_amount         numeric,
  p_total_price        numeric,
  p_provider           text,
  p_provider_server    text,
  p_provider_app_id    text,
  p_provider_app_name  text,
  p_country_id         integer,
  p_country_name       text,
  p_country_iso        text,
  p_provider_offer_id  text,
  p_max_active_orders  integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id   uuid := gen_random_uuid();
  v_existing   public.idempotency_keys;
  v_order      public.orders;
  v_active     integer;
  v_ledger     jsonb;
begin
  if p_user_id is null or p_idempotency_key is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  if char_length(p_idempotency_key) < 8 or char_length(p_idempotency_key) > 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'request hash must be sha256 hex';
  end if;
  if p_total_price is null or p_total_price <= 0
     or p_supplier_price is null or p_supplier_price < 0
     or p_markup_amount is null or p_markup_amount < 0
     or p_tax_amount is null or p_tax_amount < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if p_total_price <> p_supplier_price + p_markup_amount + p_tax_amount then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT', detail = 'price composition mismatch';
  end if;

  -- Idempotency gate. Concurrent duplicates block on the unique index until
  -- the first transaction commits, then see the stored hash.
  insert into public.idempotency_keys (user_id, scope, key, payload_hash, resource_id)
  values (p_user_id, 'order_create', p_idempotency_key, p_request_hash, v_order_id)
  on conflict (user_id, scope, key) do nothing
  returning * into v_existing;

  if v_existing.id is null then
    select * into v_existing
      from public.idempotency_keys
     where user_id = p_user_id and scope = 'order_create' and key = p_idempotency_key
       for update;

    if v_existing.payload_hash <> p_request_hash then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT',
        detail = 'the same idempotency key was used with a different payload';
    end if;

    select * into v_order from public.orders where id = v_existing.resource_id;
    if found then
      return jsonb_build_object(
        'replayed', true,
        'order', to_jsonb(v_order),
        'balance', (select balance from public.wallets where user_id = p_user_id)
      );
    end if;

    -- Key reserved but the first attempt rolled back before creating the order.
    v_order_id := v_existing.resource_id;
    update public.idempotency_keys
       set payload_hash = p_request_hash
     where id = v_existing.id;
  end if;

  if p_user_id is not null then
    select count(*) into v_active
      from public.orders
     where user_id = p_user_id
       and status in ('pending', 'waiting', 'received');
    if v_active >= coalesce(p_max_active_orders, 5) then
      raise exception using errcode = 'P0001', message = 'TOO_MANY_ACTIVE_ORDERS',
        detail = format('maximum %s active orders', p_max_active_orders);
    end if;
  end if;

  -- Debit first: this locks the wallet row and fails on insufficient balance,
  -- aborting the whole function before the order exists.
  v_ledger := public._wallet_apply(
    p_user_id, 'purchase', 'debit', p_total_price,
    'order', v_order_id, 'Pembelian layanan nokos'
  );

  insert into public.orders (
    id, user_id, service_id, idempotency_key, request_hash, status,
    provider, provider_server, provider_app_id, provider_app_name,
    provider_country_id, provider_country_name, provider_country_iso,
    provider_offer_id, supplier_price, markup_amount, tax_amount, total_price,
    next_sync_at
  ) values (
    v_order_id, p_user_id, p_service_id, p_idempotency_key, p_request_hash, 'pending',
    coalesce(p_provider, 'telekos'), p_provider_server, p_provider_app_id, p_provider_app_name,
    p_country_id, p_country_name, p_country_iso,
    p_provider_offer_id, p_supplier_price, p_markup_amount, p_tax_amount, p_total_price,
    now() + interval '30 seconds'
  )
  returning * into v_order;

  insert into public.order_events (order_id, event_type, to_status, source, actor_id, message, metadata)
  values (v_order_id, 'order_created', 'pending', 'user', p_user_id, 'Order dibuat dan saldo didebit',
          jsonb_build_object('total_price', p_total_price, 'supplier_price', p_supplier_price));

  update public.idempotency_keys set resource_id = v_order_id where user_id = p_user_id and scope = 'order_create' and key = p_idempotency_key;

  return jsonb_build_object(
    'replayed', false,
    'order', to_jsonb(v_order),
    'balance', v_ledger -> 'balance'
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- ATTACH SUPPLIER RESULT AFTER A SUCCESSFUL PURCHASE CALL
-- ----------------------------------------------------------------------------
create or replace function public.rpc_attach_supplier_order(
  p_order_id           uuid,
  p_supplier_order_id  text,
  p_status             text,
  p_phone_number       text default null,
  p_expires_at         timestamptz default null,
  p_can_cancel         boolean default false,
  p_cancel_available_at timestamptz default null,
  p_worker             text default 'api'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_status public.order_status;
  v_prev public.order_status;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;

  -- Idempotent: attaching the same supplier order twice is a no-op.
  if v_order.supplier_order_id is not null then
    if v_order.supplier_order_id <> p_supplier_order_id then
      raise exception using errcode = 'P0001', message = 'SUPPLIER_ORDER_MISMATCH';
    end if;
    return jsonb_build_object('order', to_jsonb(v_order), 'changed', false);
  end if;

  if v_order.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail = format('cannot attach supplier order to status %s', v_order.status);
  end if;

  v_prev := v_order.status;
  begin
    v_status := coalesce(p_status, 'waiting')::public.order_status;
  exception when others then
    v_status := 'waiting';
  end;
  if v_status not in ('waiting', 'received', 'completed') then
    v_status := 'waiting';
  end if;

  update public.orders
     set supplier_order_id   = p_supplier_order_id,
         status              = v_status,
         phone_number        = coalesce(p_phone_number, phone_number),
         expires_at          = coalesce(p_expires_at, expires_at),
         can_cancel          = coalesce(p_can_cancel, false),
         cancel_available_at = coalesce(p_cancel_available_at, cancel_available_at),
         next_sync_at        = now() + interval '5 seconds',
         sync_lease_until    = null,
         sync_owner          = null,
         last_synced_at      = now(),
         last_error_code     = null,
         last_error_message  = null
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, from_status, to_status, source, message, metadata)
  values (p_order_id, 'supplier_order_attached', v_prev, v_order.status, 'system',
          'Nomor virtual diterbitkan supplier', jsonb_build_object('worker', p_worker));

  return jsonb_build_object('order', to_jsonb(v_order), 'changed', true);
end;
$$;

-- Transition helper kept separate so the matrix is easy to audit.
create or replace function public._transition_allowed(p_from public.order_status, p_to public.order_status)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_from = p_to then true
    when p_from = 'pending' and p_to in ('waiting','received','completed','failed','cancelled','expired','needs_review') then true
    when p_from = 'waiting' and p_to in ('received','completed','failed','cancelled','expired','needs_review') then true
    when p_from = 'received' and p_to in ('completed','cancelled','expired','needs_review') then true
    when p_from = 'needs_review' and p_to in ('completed','cancelled','expired','failed','waiting','received') then true
    else false
  end;
$$;

-- ----------------------------------------------------------------------------
-- APPLY SUPPLIER STATE (single source of truth for order transitions + refund)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_apply_supplier_state(
  p_order_id       uuid,
  p_status         text,
  p_phone_number   text default null,
  p_otps           jsonb default '[]'::jsonb,
  p_can_cancel     boolean default null,
  p_cancel_available_at timestamptz default null,
  p_expires_at     timestamptz default null,
  p_source         text default 'system',
  p_error_code     text default null,
  p_message        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order      public.orders;
  v_prev       public.order_status;
  v_next       public.order_status;
  v_otp        jsonb;
  v_otp_count  integer;
  v_refunded   boolean := false;
  v_refund     jsonb;
  v_source     text := coalesce(p_source, 'system');
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;

  begin
    v_next := p_status::public.order_status;
  exception when others then
    raise exception using errcode = 'P0001', message = 'INVALID_STATUS',
      detail = format('unknown supplier status %s', left(coalesce(p_status, ''), 40));
  end;

  v_prev := v_order.status;

  if v_source not in ('user','system','supplier','admin','webhook') then
    v_source := 'system';
  end if;

  -- Terminal states never move again.
  if v_prev in ('completed','cancelled','expired','failed') then
    return jsonb_build_object('order', to_jsonb(v_order), 'changed', false, 'refunded', false, 'reason', 'terminal');
  end if;

  -- Explicit transition matrix (see _transition_allowed).
  if not public._transition_allowed(v_prev, v_next) then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail = format('%s -> %s is not allowed', v_prev, v_next);
  end if;

  -- Newest OTP from the supplier payload wins; never clear an existing OTP.
  v_otp_count := v_order.otp_count;
  if p_otps is not null and jsonb_typeof(p_otps) = 'array' and jsonb_array_length(p_otps) > 0 then
    v_otp := p_otps -> (jsonb_array_length(p_otps) - 1);
    v_otp_count := greatest(v_otp_count, jsonb_array_length(p_otps));
  end if;

  update public.orders
     set status = v_next,
         phone_number = coalesce(p_phone_number, phone_number),
         otp_code = case
                      when v_otp is not null and coalesce(v_otp->>'code','') <> '' then left(v_otp->>'code', 32)
                      else otp_code
                    end,
         otp_message = case
                      when v_otp is not null then left(coalesce(v_otp->>'message',''), 500)
                      else otp_message
                    end,
         otp_sender = case
                      when v_otp is not null then left(coalesce(v_otp->>'sender',''), 80)
                      else otp_sender
                    end,
         otp_received_at = case
                      when v_otp is not null then coalesce(otp_received_at, now())
                      else otp_received_at
                    end,
         otp_count = v_otp_count,
         can_cancel = coalesce(p_can_cancel, can_cancel),
         cancel_available_at = coalesce(p_cancel_available_at, cancel_available_at),
         expires_at = coalesce(p_expires_at, expires_at),
         last_synced_at = now(),
         sync_lease_until = null,
         sync_owner = null,
         -- A fulfilled cancel request must not linger, otherwise a second
         -- cancel call would look like "still in progress" instead of 409.
         cancel_requested_at = case
                                 when v_next in ('completed','cancelled','expired','failed') then null
                                 else cancel_requested_at
                               end,
         last_error_code = p_error_code,
         last_error_message = left(coalesce(p_message, ''), 500),
         completed_at = case when v_next = 'completed' then coalesce(completed_at, now()) else completed_at end,
         closed_at = case when v_next in ('completed','cancelled','expired','failed') then coalesce(closed_at, now()) else closed_at end,
         next_sync_at = case when v_next in ('completed','cancelled','expired','failed') then next_sync_at else now() + interval '15 seconds' end
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, from_status, to_status, source, message, metadata)
  values (p_order_id, 'supplier_state', v_prev, v_next, v_source,
          left(coalesce(p_message, 'Sinkronisasi status supplier'), 500),
          jsonb_build_object('error_code', p_error_code, 'otp_count', v_otp_count));

  -- Refund only when the supplier definitively closed an order that never
  -- delivered an OTP. Ambiguity (needs_review) never refunds.
  if v_next in ('cancelled','expired','failed') and v_order.otp_count = 0 and v_order.refunded_at is null then
    begin
      v_refund := public._wallet_apply(
        v_order.user_id, 'refund', 'credit', v_order.total_price,
        'order', v_order.id,
        format('Refund otomatis order %s (%s)', left(v_order.id::text, 8), v_next),
        null, jsonb_build_object('reason', v_next)
      );
      update public.orders set refunded_at = now() where id = v_order.id returning * into v_order;
      insert into public.order_events (order_id, event_type, from_status, to_status, source, message, metadata)
      values (v_order.id, 'order_refunded', v_order.status, v_order.status, 'system',
              'Saldo dikembalikan penuh', jsonb_build_object('amount', v_order.total_price));
      v_refunded := true;
    exception
      when others then
        if sqlerrm like '%DUPLICATE_LEDGER_ENTRY%' then
          v_refunded := false; -- already refunded earlier, keep idempotent
        else
          raise;
        end if;
    end;
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'changed', true,
    'refunded', v_refunded,
    'previous_status', v_prev
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- DEFINITIVE SUPPLIER REJECTION BEFORE AN ORDER EXISTED -> refund
-- ----------------------------------------------------------------------------
create or replace function public.rpc_fail_order(
  p_order_id   uuid,
  p_error_code text,
  p_message    text,
  p_refund     boolean default true,
  p_source     text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_prev public.order_status;
  v_refunded boolean := false;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;

  if v_order.status not in ('pending') then
    return jsonb_build_object('order', to_jsonb(v_order), 'changed', false, 'refunded', false, 'reason', 'not_pending');
  end if;
  if v_order.supplier_order_id is not null then
    raise exception using errcode = 'P0001', message = 'ORDER_HAS_SUPPLIER_REFERENCE',
      detail = 'cannot fail an order that exists at the supplier; reconcile instead';
  end if;

  v_prev := v_order.status;
  update public.orders
     set status = 'failed', closed_at = now(), last_error_code = p_error_code,
         last_error_message = left(coalesce(p_message,''), 500), last_synced_at = now()
   where id = p_order_id
  returning * into v_order;

  insert into public.order_events (order_id, event_type, from_status, to_status, source, message, metadata)
  values (p_order_id, 'supplier_rejected', v_prev, 'failed', coalesce(p_source,'system'),
          left(coalesce(p_message,'Pembelian ditolak supplier'), 500),
          jsonb_build_object('error_code', p_error_code));

  if coalesce(p_refund, true) then
    perform public._wallet_apply(
      v_order.user_id, 'refund', 'credit', v_order.total_price,
      'order', v_order.id, 'Refund otomatis: pembelian gagal',
      null, jsonb_build_object('reason', p_error_code)
    );
    update public.orders set refunded_at = now() where id = p_order_id returning * into v_order;
    insert into public.order_events (order_id, event_type, source, message)
    values (p_order_id, 'order_refunded', 'system', 'Saldo dikembalikan penuh');
    v_refunded := true;
  end if;

  return jsonb_build_object('order', to_jsonb(v_order), 'changed', true, 'refunded', v_refunded);
exception
  when unique_violation then
    return jsonb_build_object('order', to_jsonb(v_order), 'changed', true, 'refunded', false, 'reason', 'already_refunded');
end;
$$;

-- ----------------------------------------------------------------------------
-- CANCEL REQUEST GUARD (prevents double supplier cancellation)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_begin_cancel(p_order_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.user_id <> p_user_id then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'order belongs to another user';
  end if;
  if v_order.cancel_requested_at is not null then
    return jsonb_build_object('order', to_jsonb(v_order), 'already_requested', true);
  end if;
  if v_order.status not in ('waiting','received') then
    raise exception using errcode = 'P0001', message = 'CANCEL_NOT_AVAILABLE', detail = 'order is not active';
  end if;
  if v_order.otp_count > 0 then
    raise exception using errcode = 'P0001', message = 'CANCEL_NOT_AVAILABLE', detail = 'OTP already received';
  end if;
  if v_order.can_cancel is not true then
    raise exception using errcode = 'P0001', message = 'CANCEL_NOT_AVAILABLE', detail = 'supplier does not allow cancellation yet';
  end if;

  update public.orders set cancel_requested_at = now() where id = p_order_id returning * into v_order;
  insert into public.order_events (order_id, event_type, from_status, to_status, source, actor_id, message)
  values (p_order_id, 'cancel_requested', v_order.status, v_order.status, 'user', p_user_id, 'Pengguna meminta pembatalan');

  return jsonb_build_object('order', to_jsonb(v_order), 'already_requested', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- MANUAL / RECONCILIATION REFUND (single shot, audited)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_refund_order(
  p_order_id uuid,
  p_reason   text,
  p_admin_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_amount numeric;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  if p_admin_id is not null then
    perform public._assert_admin(p_admin_id);
  end if;

  if v_order.refunded_at is not null then
    return jsonb_build_object('refunded', false, 'reason', 'already_refunded', 'order', to_jsonb(v_order));
  end if;
  if v_order.status not in ('cancelled','expired','failed','completed','needs_review') then
    raise exception using errcode = 'P0001', message = 'REFUND_NOT_ALLOWED', detail = 'order is still active';
  end if;
  if v_order.otp_count > 0 and v_order.status = 'completed' then
    raise exception using errcode = 'P0001', message = 'REFUND_NOT_ALLOWED', detail = 'order delivered an OTP';
  end if;
  if coalesce(p_reason, '') = '' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'refund reason required';
  end if;

  v_amount := v_order.total_price;
  perform public._wallet_apply(
    v_order.user_id, 'refund', 'credit', v_amount, 'order', v_order.id,
    left('Refund manual: ' || p_reason, 200), p_admin_id, jsonb_build_object('reason', p_reason)
  );
  update public.orders set refunded_at = now() where id = p_order_id returning * into v_order;

  insert into public.order_events (order_id, event_type, source, actor_id, message)
  values (p_order_id, 'order_refunded', case when p_admin_id is null then 'system' else 'admin' end,
          p_admin_id, left('Refund: ' || p_reason, 500));

  if p_admin_id is not null then
    perform public._audit(p_admin_id, 'order.refund', 'order', p_order_id::text, p_reason,
                          null, jsonb_build_object('amount', v_amount));
  end if;

  return jsonb_build_object('refunded', true, 'amount', v_amount, 'order', to_jsonb(v_order));
end;
$$;

-- ----------------------------------------------------------------------------
-- DEPOSITS
-- ----------------------------------------------------------------------------
create or replace function public.rpc_create_deposit(
  p_user_id     uuid,
  p_amount      numeric,
  p_proof_path  text,
  p_proof_mime  text,
  p_proof_size  integer,
  p_proof_sha256 text,
  p_user_note   text default null,
  p_min_amount  numeric default 10000,
  p_max_amount  numeric default 5000000,
  p_max_pending integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
  v_pending integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if p_amount < p_min_amount then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_BELOW_MINIMUM',
      detail = format('minimum deposit is %s', p_min_amount);
  end if;
  if p_amount > p_max_amount then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ABOVE_MAXIMUM',
      detail = format('maximum deposit is %s', p_max_amount);
  end if;
  if p_proof_path is null or p_proof_mime is null or p_proof_size is null then
    raise exception using errcode = 'P0001', message = 'PROOF_REQUIRED';
  end if;
  if p_proof_mime not in ('image/png','image/jpeg','image/webp','application/pdf') then
    raise exception using errcode = 'P0001', message = 'PROOF_INVALID_TYPE';
  end if;
  if p_proof_size <= 0 or p_proof_size > 5242880 then
    raise exception using errcode = 'P0001', message = 'PROOF_TOO_LARGE';
  end if;

  select count(*) into v_pending from public.deposits
   where user_id = p_user_id and status = 'pending';
  if v_pending >= coalesce(p_max_pending, 3) then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_PENDING_DEPOSITS';
  end if;

  insert into public.deposits
    (user_id, amount, method, status, proof_path, proof_mime, proof_size, proof_sha256, user_note)
  values
    (p_user_id, p_amount, 'manual_transfer', 'pending', p_proof_path, p_proof_mime, p_proof_size, p_proof_sha256,
     left(coalesce(p_user_note, ''), 500))
  returning * into v_deposit;

  return jsonb_build_object('deposit', to_jsonb(v_deposit));
end;
$$;

create or replace function public.rpc_approve_deposit(
  p_deposit_id      uuid,
  p_admin_id        uuid,
  p_approved_amount numeric default null,
  p_admin_note      text default null,
  p_ip              text default null,
  p_user_agent      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
  v_amount  numeric;
  v_ledger  jsonb;
begin
  perform public._assert_admin(p_admin_id);

  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND';
  end if;
  if v_deposit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED',
      detail = format('deposit status is %s', v_deposit.status);
  end if;

  v_amount := coalesce(p_approved_amount, v_deposit.amount);
  if v_amount <= 0 or v_amount > v_deposit.amount then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT',
      detail = 'approved amount must be > 0 and <= requested amount';
  end if;

  v_ledger := public._wallet_apply(
    v_deposit.user_id, 'deposit', 'credit', v_amount,
    'deposit', v_deposit.id, 'Deposit disetujui admin', p_admin_id,
    jsonb_build_object('requested_amount', v_deposit.amount)
  );

  update public.deposits
     set status = 'approved', approved_amount = v_amount, reviewed_by = p_admin_id,
         reviewed_at = now(), admin_note = left(coalesce(p_admin_note, ''), 500)
   where id = p_deposit_id
  returning * into v_deposit;

  perform public._audit(p_admin_id, 'deposit.approve', 'deposit', p_deposit_id::text,
                        p_admin_note, jsonb_build_object('status','pending'),
                        jsonb_build_object('status','approved','amount', v_amount), p_ip, p_user_agent);

  return jsonb_build_object('deposit', to_jsonb(v_deposit), 'balance', v_ledger->'balance');
end;
$$;

create or replace function public.rpc_reject_deposit(
  p_deposit_id uuid,
  p_admin_id   uuid,
  p_reason     text,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
begin
  perform public._assert_admin(p_admin_id);
  if coalesce(p_reason, '') = '' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'rejection reason required';
  end if;

  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND';
  end if;
  if v_deposit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED';
  end if;

  update public.deposits
     set status = 'rejected', reviewed_by = p_admin_id, reviewed_at = now(),
         admin_note = left(p_reason, 500)
   where id = p_deposit_id
  returning * into v_deposit;

  perform public._audit(p_admin_id, 'deposit.reject', 'deposit', p_deposit_id::text, p_reason,
                        jsonb_build_object('status','pending'), jsonb_build_object('status','rejected'), p_ip, p_user_agent);

  return jsonb_build_object('deposit', to_jsonb(v_deposit), 'balance', null);
end;
$$;

-- ----------------------------------------------------------------------------
-- ADMIN: manual balance adjustment (reason + reference mandatory, audited)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_admin_adjust_balance(
  p_user_id    uuid,
  p_admin_id   uuid,
  p_direction  text,
  p_amount     numeric,
  p_reason     text,
  p_reference  uuid,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ledger jsonb;
  v_dir public.wallet_tx_direction;
begin
  perform public._assert_admin(p_admin_id);
  if p_direction not in ('credit','debit') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'direction must be credit or debit';
  end if;
  if coalesce(p_reason, '') = '' or char_length(p_reason) < 5 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'reason of at least 5 characters is required';
  end if;
  if p_reference is null then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'reference is required for idempotency';
  end if;

  v_dir := p_direction::public.wallet_tx_direction;
  v_ledger := public._wallet_apply(
    p_user_id, 'adjustment', v_dir, p_amount, 'adjustment', p_reference,
    left('Penyesuaian admin: ' || p_reason, 200), p_admin_id, jsonb_build_object('reason', p_reason)
  );

  perform public._audit(p_admin_id, 'wallet.adjustment', 'wallet', p_user_id::text, p_reason,
                        null, jsonb_build_object('direction', p_direction, 'amount', p_amount, 'reference', p_reference),
                        p_ip, p_user_agent);

  return jsonb_build_object('balance', v_ledger->'balance', 'transaction_id', v_ledger->'transaction_id');
exception
  when others then
    if sqlerrm like '%DUPLICATE_LEDGER_ENTRY%' then
      raise exception using errcode = 'P0001', message = 'DUPLICATE_ADJUSTMENT',
        detail = 'this adjustment reference was already applied';
    end if;
    raise;
end;
$$;

create or replace function public.rpc_set_user_role(
  p_user_id    uuid,
  p_admin_id   uuid,
  p_role       text,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.profiles;
  v_after  public.profiles;
  v_admins integer;
begin
  perform public._assert_admin(p_admin_id);
  if p_role not in ('user','admin') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  select * into v_before from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'USER_NOT_FOUND';
  end if;

  if v_before.role = 'admin' and p_role = 'user' then
    select count(*) into v_admins from public.profiles where role = 'admin' and status = 'active';
    if v_admins <= 1 then
      raise exception using errcode = 'P0001', message = 'LAST_ADMIN', detail = 'cannot demote the last active admin';
    end if;
  end if;

  update public.profiles set role = p_role::public.user_role where id = p_user_id returning * into v_after;

  perform public._audit(p_admin_id, 'user.role_change', 'profile', p_user_id::text, null,
                        jsonb_build_object('role', v_before.role), jsonb_build_object('role', v_after.role), p_ip, p_user_agent);
  return jsonb_build_object('profile', to_jsonb(v_after));
end;
$$;

create or replace function public.rpc_set_user_status(
  p_user_id    uuid,
  p_admin_id   uuid,
  p_status     text,
  p_reason     text default null,
  p_ip         text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.profiles;
  v_after  public.profiles;
begin
  perform public._assert_admin(p_admin_id);
  if p_status not in ('active','suspended','banned') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  if p_user_id = p_admin_id and p_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN', detail = 'cannot change own status';
  end if;

  select * into v_before from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'USER_NOT_FOUND';
  end if;

  update public.profiles set status = p_status::public.account_status where id = p_user_id returning * into v_after;
  perform public._audit(p_admin_id, 'user.status_change', 'profile', p_user_id::text, p_reason,
                        jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status), p_ip, p_user_agent);
  return jsonb_build_object('profile', to_jsonb(v_after));
end;
$$;

-- ----------------------------------------------------------------------------
-- SYNC LEASES (distributed polling without duplicate processing)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_claim_orders_for_sync(
  p_limit         integer default 20,
  p_lease_seconds integer default 45,
  p_worker        text default 'worker'
)
returns setof public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'limit out of range';
  end if;
  if p_lease_seconds < 10 or p_lease_seconds > 600 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'lease out of range';
  end if;

  return query
  with candidates as (
    select o.id
      from public.orders o
     where o.status in ('pending','waiting','received','needs_review')
       and o.next_sync_at <= now()
       and (o.sync_lease_until is null or o.sync_lease_until < now())
     order by o.next_sync_at asc
     limit p_limit
     for update skip locked
  )
  update public.orders o
     set sync_lease_until = now() + make_interval(secs => p_lease_seconds),
         sync_owner = p_worker,
         sync_attempts = o.sync_attempts + 1
    from candidates c
   where o.id = c.id
  returning o.*;
end;
$$;

create or replace function public.rpc_release_order_lease(
  p_order_id    uuid,
  p_next_sync_at timestamptz default null,
  p_error_code  text default null,
  p_error_message text default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.orders
     set sync_lease_until = null,
         next_sync_at = coalesce(p_next_sync_at, now() + interval '30 seconds'),
         last_error_code = coalesce(p_error_code, last_error_code),
         last_error_message = left(coalesce(p_error_message, last_error_message), 500)
   where id = p_order_id;
$$;

-- Orders left in `pending` without a supplier reference by a crashed process.
-- They are NOT refunded automatically: we cannot know whether the supplier
-- created the purchase. They become needs_review for reconciliation.
create or replace function public.rpc_flag_orphan_pending_orders(p_age_seconds integer default 180)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_count integer := 0;
begin
  with stale as (
    select id from public.orders
     where status = 'pending'
       and supplier_order_id is null
       and created_at < now() - make_interval(secs => p_age_seconds)
       and (sync_lease_until is null or sync_lease_until < now())
     order by created_at
     limit 100
     for update skip locked
  ), upd as (
    update public.orders o
       set status = 'needs_review',
           next_sync_at = now(),
           last_error_code = 'ORPHAN_PENDING',
           last_error_message = 'Order tanpa referensi supplier; menunggu rekonsiliasi'
      from stale s
     where o.id = s.id
    returning o.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from upd;

  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count > 0 then
    insert into public.order_events (order_id, event_type, from_status, to_status, source, message)
    select unnest(v_ids), 'order_orphaned', 'pending', 'needs_review', 'system',
           'Order pending tanpa referensi supplier ditandai needs_review';
  end if;

  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- JOB LEASES (single global poller even with several PM2 instances)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_acquire_job_lease(
  p_name          text,
  p_owner         text,
  p_lease_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into public.job_leases (name, owner, locked_until, heartbeat_at)
  values (p_name, p_owner, now() + make_interval(secs => p_lease_seconds), now())
  on conflict (name) do update
    set owner = excluded.owner,
        locked_until = excluded.locked_until,
        heartbeat_at = now()
    where public.job_leases.locked_until < now() or public.job_leases.owner = p_owner;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.rpc_release_job_lease(p_name text, p_owner text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.job_leases set locked_until = now() where name = p_name and owner = p_owner;
$$;

-- ----------------------------------------------------------------------------
-- CATALOG SYNC (atomic upsert + deactivate rows removed upstream)
-- ----------------------------------------------------------------------------
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
       supplier_price, price, stock, is_active, price_synced_at)
    values
      (v_item->>'code', v_item->>'name', coalesce(p_provider,'telekos'), p_server,
       v_item->>'provider_app_id', v_item->>'app_name',
       (v_item->>'country_id')::integer, v_item->>'country_name', v_item->>'country_iso',
       v_item->>'country_calling_code',
       nullif(v_item->>'supplier_price','')::numeric,
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

-- ----------------------------------------------------------------------------
-- WEBHOOK INBOX (dedupe by delivery id)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_record_webhook_event(
  p_delivery_id text,
  p_event_type  text,
  p_payload     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into public.supplier_webhook_events (delivery_id, event_type, payload)
  values (p_delivery_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('inserted', false);
  end if;
  return jsonb_build_object('inserted', true, 'id', v_id);
end;
$$;

-- ----------------------------------------------------------------------------
-- PUBLIC SUMMARY (real data only, safe for anonymous callers)
-- ----------------------------------------------------------------------------
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
    'active_services', (select count(*) from public.services where is_active = true),
    'countries', (select count(distinct country_id) from public.services where is_active = true),
    'apps', (select count(distinct provider_app_id) from public.services where is_active = true),
    'last_catalog_sync', (select max(price_synced_at) from public.services),
    'generated_at', now()
  ) into v;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- ADMIN DASHBOARD AGGREGATES (computed from real transactions only)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_admin_dashboard(p_admin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public._assert_admin(p_admin_id);

  select jsonb_build_object(
    'generated_at', now(),
    'users', jsonb_build_object(
      'total', (select count(*) from public.profiles),
      'active', (select count(*) from public.profiles where status = 'active'),
      'suspended', (select count(*) from public.profiles where status <> 'active'),
      'admins', (select count(*) from public.profiles where role = 'admin')
    ),
    'orders', jsonb_build_object(
      'total', (select count(*) from public.orders),
      'today', (select count(*) from public.orders where created_at >= date_trunc('day', now())),
      'active', (select count(*) from public.orders where status in ('pending','waiting','received')),
      'completed', (select count(*) from public.orders where status = 'completed'),
      'refunded', (select count(*) from public.orders where refunded_at is not null),
      'needs_review', (select count(*) from public.orders where status = 'needs_review')
    ),
    'finance', jsonb_build_object(
      'gross_revenue', coalesce((select sum(total_price) from public.orders where status = 'completed'), 0),
      'supplier_cost', coalesce((select sum(supplier_price) from public.orders where status = 'completed'), 0),
      'net_profit', coalesce((select sum(total_price - supplier_price) from public.orders where status = 'completed'), 0),
      'refunded_total', coalesce((select sum(amount) from public.wallet_transactions where type = 'refund'), 0),
      'deposits_approved', coalesce((select sum(approved_amount) from public.deposits where status = 'approved'), 0),
      'deposits_pending_count', (select count(*) from public.deposits where status = 'pending'),
      'deposits_pending_amount', coalesce((select sum(amount) from public.deposits where status = 'pending'), 0),
      'wallet_liability', coalesce((select sum(balance) from public.wallets), 0)
    ),
    'recent_orders', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select o.id, o.status, o.total_price, o.created_at, p.email
          from public.orders o join public.profiles p on p.id = o.user_id
         order by o.created_at desc limit 10
      ) t
    ), '[]'::jsonb)
  ) into v;

  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- RELEASE A FAILED CANCEL ATTEMPT (so the user can retry later)
-- ----------------------------------------------------------------------------
create or replace function public.rpc_release_cancel(p_order_id uuid, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
begin
  update public.orders
     set cancel_requested_at = null,
         last_error_message = left(coalesce(p_message, last_error_message), 500),
         next_sync_at = now() + interval '20 seconds'
   where id = p_order_id
     and status in ('waiting', 'received')
  returning * into v_order;

  if not found then
    return jsonb_build_object('released', false);
  end if;
  return jsonb_build_object('released', true, 'order', to_jsonb(v_order));
end;
$$;

-- ----------------------------------------------------------------------------
-- GRANTS — mutating RPCs are server (service_role) only
-- ----------------------------------------------------------------------------
revoke all on function public._wallet_apply(uuid, public.wallet_tx_type, public.wallet_tx_direction, numeric, text, uuid, text, uuid, jsonb) from public;
revoke all on function public._assert_admin(uuid) from public;
revoke all on function public._audit(uuid, text, text, text, text, jsonb, jsonb, text, text) from public;
revoke all on function public._transition_allowed(public.order_status, public.order_status) from public;
revoke all on function public.ensure_user_profile(uuid, text, text) from public;
revoke all on function public.rpc_rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rpc_create_order(uuid, uuid, text, text, numeric, numeric, numeric, numeric, text, text, text, text, integer, text, text, text, integer) from public;
revoke all on function public.rpc_attach_supplier_order(uuid, text, text, text, timestamptz, boolean, timestamptz, text) from public;
revoke all on function public.rpc_apply_supplier_state(uuid, text, text, jsonb, boolean, timestamptz, timestamptz, text, text, text) from public;
revoke all on function public.rpc_fail_order(uuid, text, text, boolean, text) from public;
revoke all on function public.rpc_begin_cancel(uuid, uuid) from public;
revoke all on function public.rpc_release_cancel(uuid, text) from public;
revoke all on function public.rpc_refund_order(uuid, text, uuid) from public;
revoke all on function public.rpc_create_deposit(uuid, numeric, text, text, integer, text, text, numeric, numeric, integer) from public;
revoke all on function public.rpc_approve_deposit(uuid, uuid, numeric, text, text, text) from public;
revoke all on function public.rpc_reject_deposit(uuid, uuid, text, text, text) from public;
revoke all on function public.rpc_admin_adjust_balance(uuid, uuid, text, numeric, text, uuid, text, text) from public;
revoke all on function public.rpc_set_user_role(uuid, uuid, text, text, text) from public;
revoke all on function public.rpc_set_user_status(uuid, uuid, text, text, text, text) from public;
revoke all on function public.rpc_claim_orders_for_sync(integer, integer, text) from public;
revoke all on function public.rpc_release_order_lease(uuid, timestamptz, text, text) from public;
revoke all on function public.rpc_flag_orphan_pending_orders(integer) from public;
revoke all on function public.rpc_acquire_job_lease(text, text, integer) from public;
revoke all on function public.rpc_release_job_lease(text, text) from public;
revoke all on function public.rpc_sync_services(text, text, jsonb) from public;
revoke all on function public.rpc_record_webhook_event(text, text, jsonb) from public;
revoke all on function public.rpc_public_summary() from public;
revoke all on function public.rpc_admin_dashboard(uuid) from public;

grant execute on function public.ensure_user_profile(uuid, text, text) to service_role;
grant execute on function public.rpc_rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.rpc_create_order(uuid, uuid, text, text, numeric, numeric, numeric, numeric, text, text, text, text, integer, text, text, text, integer) to service_role;
grant execute on function public.rpc_attach_supplier_order(uuid, text, text, text, timestamptz, boolean, timestamptz, text) to service_role;
grant execute on function public.rpc_apply_supplier_state(uuid, text, text, jsonb, boolean, timestamptz, timestamptz, text, text, text) to service_role;
grant execute on function public.rpc_fail_order(uuid, text, text, boolean, text) to service_role;
grant execute on function public.rpc_begin_cancel(uuid, uuid) to service_role;
grant execute on function public.rpc_release_cancel(uuid, text) to service_role;
grant execute on function public.rpc_refund_order(uuid, text, uuid) to service_role;
grant execute on function public.rpc_create_deposit(uuid, numeric, text, text, integer, text, text, numeric, numeric, integer) to service_role;
grant execute on function public.rpc_approve_deposit(uuid, uuid, numeric, text, text, text) to service_role;
grant execute on function public.rpc_reject_deposit(uuid, uuid, text, text, text) to service_role;
grant execute on function public.rpc_admin_adjust_balance(uuid, uuid, text, numeric, text, uuid, text, text) to service_role;
grant execute on function public.rpc_set_user_role(uuid, uuid, text, text, text) to service_role;
grant execute on function public.rpc_set_user_status(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.rpc_claim_orders_for_sync(integer, integer, text) to service_role;
grant execute on function public.rpc_release_order_lease(uuid, timestamptz, text, text) to service_role;
grant execute on function public.rpc_flag_orphan_pending_orders(integer) to service_role;
grant execute on function public.rpc_acquire_job_lease(text, text, integer) to service_role;
grant execute on function public.rpc_release_job_lease(text, text) to service_role;
grant execute on function public.rpc_sync_services(text, text, jsonb) to service_role;
grant execute on function public.rpc_record_webhook_event(text, text, jsonb) to service_role;
grant execute on function public.rpc_admin_dashboard(uuid) to service_role;

-- public read only
grant execute on function public.rpc_public_summary() to anon, authenticated, service_role;


-- ============================================================================
-- BAGIAN 4/4 — MIGRASI 001: RPC PUBLIK & RATE LIMITER
-- ============================================================================
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



-- ============================================================================
-- HASIL PEMERIKSAAN — tidak mengubah apa pun, hanya membaca
-- ============================================================================
do $$
declare
  v_missing text := '';
  v_tables  int;
  v_funcs   int;
  v_settings int;
  v_public_settings int;
BEGIN
  with expected(name) as (
    values ('app_settings'),('profiles'),('wallets'),('wallet_transactions'),('deposits'),
           ('services'),('orders'),('order_events'),('admin_audit_logs'),('sessions'),
           ('idempotency_keys'),('supplier_webhook_events'),('rate_limits'),('job_leases'),
           ('catalog_sync_runs')
  )
  select string_agg(e.name, ', ')
    into v_missing
    from expected e
   where not exists (
     select 1 from information_schema.tables t
      where t.table_schema = 'public' and t.table_name = e.name
   );

  select count(*) into v_tables from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';

  select count(*) into v_funcs from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'rpc\_%';

  select count(*) into v_settings from public.app_settings;
  select count(*) into v_public_settings from public.app_settings where coalesce((value->>'public')::boolean, true);

  raise notice '----------------------------------------';
  if v_missing is null then
    raise notice 'TABEL: lengkap (% tabel di schema public)', v_tables;
  else
    raise notice 'TABEL HILANG: %', v_missing;
  end if;
  raise notice 'FUNGSI RPC: % fungsi', v_funcs;
  raise notice 'app_settings: % baris (% publik)', v_settings, v_public_settings;
  raise notice 'rpc_public_summary ada: %', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rpc_public_summary');
  raise notice 'rpc_rate_limit_hit ada: %', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rpc_rate_limit_hit');
  raise notice 'anon boleh baca services: %', has_table_privilege('anon','public.services','select');
  raise notice 'anon boleh baca app_settings: %', has_table_privilege('anon','public.app_settings','select');
  raise notice 'anon boleh hit rate limit: % (harus false)', has_function_privilege('anon','public.rpc_rate_limit_hit(text,int,int)','execute');
  raise notice 'anon boleh panggil summary: % (harus true)', has_function_privilege('anon','public.rpc_public_summary()','execute');
  raise notice 'services aktif: % baris', (select count(*) from public.services where is_active);
  raise notice '----------------------------------------';
  raise notice 'Langkah berikutnya: buka /api/cron/reconcile atau tunggu sinkronisasi katalog untuk mengisi services.';
end
$$;

notify pgrst, 'reload schema';
