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
  p_min_amount  numeric default 1000,
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
  v_min_amount numeric := greatest(coalesce(p_min_amount, 1000), 1000);
begin
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if p_amount < v_min_amount then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_BELOW_MINIMUM',
      detail = format('minimum deposit is %s', v_min_amount);
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
