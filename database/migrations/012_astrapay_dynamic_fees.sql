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
