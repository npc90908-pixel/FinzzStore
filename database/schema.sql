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
create trigger trg_app_settings_updated_at
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
create trigger trg_profiles_updated_at
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
create trigger trg_wallets_updated_at
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
create trigger trg_deposits_updated_at
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
create trigger trg_services_updated_at
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
create trigger trg_orders_updated_at
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
  ('deposit_policy', '{"min_amount":1000,"max_amount":5000000,"instructions":"Transfer ke rekening resmi yang tertera. Sertakan nominal unik pada berita transfer.","bank_accounts":[],"expiry_hours":24}'::jsonb, 'Manual deposit policy; bank_accounts must be filled by the owner', true),
  ('pricing_policy', '{"default_markup_bps":1500,"tax_bps":0,"tax_label":"PPN"}'::jsonb, 'Markup & tax configuration applied to supplier price', false),
  ('operations', '{"sales_open":true,"maintenance_message":"","order_poll_interval_ms":4000,"server_poll_interval_ms":15000,"order_expiry_seconds":1260,"max_active_orders_per_user":5}'::jsonb, 'Operational switches and polling cadence', true),
  ('refund_policy', '{"summary":"Refund otomatis hanya jika nomor tidak pernah menerima OTP dan supplier mengonfirmasi order selesai tanpa OTP. Refund dicatat pada ledger dan hanya terjadi satu kali."}'::jsonb, 'Customer facing refund policy summary', true),
  ('legal', '{"terms_version":"2026-10-01","privacy_version":"2026-10-01"}'::jsonb, 'Legal document versions', true),
  ('supplier', '{"provider":"telekos","server":"server1","app_allowlist":[],"sync_enabled":true}'::jsonb, 'Supplier integration switches (no secrets here)', false)
on conflict (key) do nothing;
