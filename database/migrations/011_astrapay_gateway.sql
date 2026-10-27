-- ============================================================================
-- MIGRATION 011 — AstraPay QRIS/payment-link deposits.
--
-- Gateway invoices stay in the existing deposits ledger. Wallet credit only
-- occurs in rpc_confirm_astrapay_deposit, after a signed callback or scheduled
-- server-side lookup has verified AstraPay's final order details. Redirects
-- and browser-supplied payment status never reach this RPC.
-- ============================================================================
begin;

alter table public.deposits
  add column if not exists provider_reference text,
  add column if not exists provider_order_id text,
  add column if not exists checkout_url text,
  add column if not exists qris_payload text,
  add column if not exists pay_amount numeric(18,2),
  add column if not exists fee_amount numeric(18,2) not null default 0,
  add column if not exists provider_status text,
  add column if not exists expires_at timestamptz,
  add column if not exists paid_at timestamptz;

alter table public.deposits drop constraint if exists deposits_review_consistency;
alter table public.deposits add constraint deposits_review_consistency check (
  (status = 'pending' and reviewed_at is null and reviewed_by is null)
  or (status in ('approved','rejected') and reviewed_at is not null
      and (reviewed_by is not null or (status = 'approved' and method = 'gateway')))
  or status = 'cancelled'
);
alter table public.deposits drop constraint if exists deposits_gateway_amounts_valid;
alter table public.deposits add constraint deposits_gateway_amounts_valid check (
  fee_amount >= 0
  and (pay_amount is null or pay_amount >= amount)
  and (method <> 'gateway' or provider_reference is not null)
);

create unique index if not exists deposits_provider_reference_unique
  on public.deposits (provider_reference) where provider_reference is not null;
create unique index if not exists deposits_provider_order_unique
  on public.deposits (provider_order_id) where provider_order_id is not null;
create index if not exists deposits_gateway_pending_idx
  on public.deposits (created_at) where method = 'gateway' and status = 'pending';

create table if not exists public.payment_webhook_events (
  event_id           text primary key,
  event_type         text not null,
  provider_order_id  text not null,
  provider_reference text not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  constraint payment_webhook_event_id_format check (event_id ~ '^[a-f0-9]{64}$'),
  constraint payment_webhook_type_length check (char_length(event_type) between 1 and 80)
);
create index if not exists payment_webhook_events_received_idx
  on public.payment_webhook_events (received_at desc);

alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_webhook_events from anon, authenticated;

-- An intent is inserted before the external API call so even an unusually fast
-- webhook has a stable, unique merchant reference to match.
create or replace function public.rpc_create_astrapay_deposit(
  p_user_id uuid,
  p_amount numeric,
  p_reference text,
  p_min_amount numeric default 1000,
  p_max_amount numeric default 5000000,
  p_max_pending integer default 3,
  p_expires_in integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
  v_min_amount numeric := greatest(coalesce(p_min_amount, 1000), 1000);
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  if p_amount < v_min_amount then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_BELOW_MINIMUM';
  end if;
  if p_max_amount is null or p_amount > p_max_amount or p_amount > 100000000 then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ABOVE_MAXIMUM';
  end if;
  if p_reference is null or p_reference !~ '^[A-Za-z0-9_-]{8,100}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'invalid merchant reference';
  end if;
  if coalesce(p_max_pending, 3) < 1 or coalesce(p_expires_in, 600) not between 300 and 600 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT', detail = 'invalid pending or expiry policy';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if (select count(*) from public.deposits where user_id = p_user_id and status = 'pending') >= coalesce(p_max_pending, 3) then
    raise exception using errcode = 'P0001', message = 'TOO_MANY_PENDING_DEPOSITS';
  end if;

  insert into public.deposits
    (user_id, amount, method, status, provider_reference, provider_status, expires_at)
  values
    (p_user_id, p_amount, 'gateway', 'pending', p_reference, 'creating', now() + make_interval(secs => coalesce(p_expires_in, 600)))
  returning * into v_deposit;

  return jsonb_build_object('deposit', to_jsonb(v_deposit));
end;
$$;

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
     or p_fee_amount <> 0 or p_checkout_url is null
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
  if p_pay_amount < v_deposit.amount or p_pay_amount <> trunc(p_pay_amount) then
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

-- The only gateway wallet-credit boundary. The application calls this after
-- validating the signed callback and independently fetching the final order.
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
     or p_fee_amount <> 0
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

create or replace function public.rpc_close_astrapay_deposit(
  p_deposit_id uuid,
  p_provider_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
begin
  if p_provider_status is null or p_provider_status not in ('expired','cancelled','canceled') then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found or v_deposit.method <> 'gateway' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND';
  end if;
  if v_deposit.status = 'pending' then
    update public.deposits
       set status = 'cancelled', provider_status = p_provider_status,
           checkout_url = null, qris_payload = null
     where id = p_deposit_id
    returning * into v_deposit;
  end if;
  return jsonb_build_object('deposit', to_jsonb(v_deposit));
end;
$$;

-- Manual-review RPCs must never credit/reject an AstraPay invoice; gateway
-- status changes are driven only by the verified payment RPC above.
create or replace function public.rpc_approve_deposit(
  p_deposit_id uuid,
  p_admin_id uuid,
  p_approved_amount numeric default null,
  p_admin_note text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deposit public.deposits;
  v_amount numeric;
  v_ledger jsonb;
begin
  perform public._assert_admin(p_admin_id);
  select * into v_deposit from public.deposits where id = p_deposit_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND'; end if;
  if v_deposit.method = 'gateway' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AUTO_REVIEW';
  end if;
  if v_deposit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED';
  end if;
  v_amount := coalesce(p_approved_amount, v_deposit.amount);
  if v_amount <= 0 or v_amount > v_deposit.amount then
    raise exception using errcode = 'P0001', message = 'INVALID_AMOUNT';
  end if;
  v_ledger := public._wallet_apply(
    v_deposit.user_id, 'deposit', 'credit', v_amount, 'deposit', v_deposit.id,
    'Deposit disetujui admin', p_admin_id,
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
  p_admin_id uuid,
  p_reason text,
  p_ip text default null,
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
  if not found then raise exception using errcode = 'P0001', message = 'DEPOSIT_NOT_FOUND'; end if;
  if v_deposit.method = 'gateway' then
    raise exception using errcode = 'P0001', message = 'PAYMENT_AUTO_REVIEW';
  end if;
  if v_deposit.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'DEPOSIT_ALREADY_REVIEWED';
  end if;
  update public.deposits
     set status = 'rejected', admin_note = left(p_reason, 500), reviewed_by = p_admin_id,
         reviewed_at = now()
   where id = p_deposit_id
  returning * into v_deposit;
  perform public._audit(p_admin_id, 'deposit.reject', 'deposit', p_deposit_id::text,
      p_reason, jsonb_build_object('status','pending'), jsonb_build_object('status','rejected'), p_ip, p_user_agent);
  return jsonb_build_object('deposit', to_jsonb(v_deposit));
end;
$$;

revoke all on public.payment_webhook_events from public, anon, authenticated;
revoke all on function public.rpc_create_astrapay_deposit(uuid, numeric, text, numeric, numeric, integer, integer) from public, anon, authenticated;
revoke all on function public.rpc_store_astrapay_invoice(uuid, text, text, numeric, numeric, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.rpc_confirm_astrapay_deposit(text, text, text, text, numeric, numeric, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.rpc_close_astrapay_deposit(uuid, text) from public, anon, authenticated;
revoke all on function public.rpc_approve_deposit(uuid, uuid, numeric, text, text, text) from public, anon, authenticated;
revoke all on function public.rpc_reject_deposit(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.rpc_create_astrapay_deposit(uuid, numeric, text, numeric, numeric, integer, integer) to service_role;
grant execute on function public.rpc_store_astrapay_invoice(uuid, text, text, numeric, numeric, text, text, timestamptz, text) to service_role;
grant execute on function public.rpc_confirm_astrapay_deposit(text, text, text, text, numeric, numeric, numeric, timestamptz) to service_role;
grant execute on function public.rpc_close_astrapay_deposit(uuid, text) to service_role;
grant execute on function public.rpc_approve_deposit(uuid, uuid, numeric, text, text, text) to service_role;
grant execute on function public.rpc_reject_deposit(uuid, uuid, text, text, text) to service_role;

commit;
