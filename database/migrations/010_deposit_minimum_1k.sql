-- ============================================================================
-- MIGRATION 010 — set the default minimum top-up to IDR 1,000.
--
-- Lower the old seeded default (IDR 10,000) to IDR 1,000, retain any other
-- operator-configured minimum at or above IDR 1,000, and raise a numeric legacy
-- maximum only if it is below the effective minimum. No deposit or wallet ledger
-- rows are changed. The RPC also enforces a hard IDR 1,000 floor.
-- ============================================================================
begin;

with deposit_config as (
  select key, value,
    case
      when jsonb_typeof(value->'min_amount') = 'number' then
        case
          when (value->>'min_amount')::numeric = 10000 then 1000
          when (value->>'min_amount')::numeric < 1000 then 1000
          else (value->>'min_amount')::numeric
        end
      else 1000
    end as effective_min
  from public.app_settings
  where key = 'deposit_policy' and jsonb_typeof(value) = 'object'
)
update public.app_settings as settings
   set value = case
         when jsonb_typeof(settings.value->'max_amount') = 'number'
           and (settings.value->>'max_amount')::numeric < deposit_config.effective_min
         then jsonb_set(
           jsonb_set(settings.value, '{min_amount}', to_jsonb(deposit_config.effective_min), true),
           '{max_amount}', to_jsonb(deposit_config.effective_min), true
         )
         else jsonb_set(settings.value, '{min_amount}', to_jsonb(deposit_config.effective_min), true)
       end,
       updated_at = now()
  from deposit_config
 where settings.key = deposit_config.key;

-- Enforce the minimum at the database boundary even if a future caller passes
-- a lower p_min_amount. Existing higher configured minimums remain respected.
create or replace function public.rpc_create_deposit(
  p_user_id      uuid,
  p_amount       numeric,
  p_proof_path   text,
  p_proof_mime   text,
  p_proof_size   integer,
  p_proof_sha256 text,
  p_user_note    text default null,
  p_min_amount   numeric default 1000,
  p_max_amount   numeric default 5000000,
  p_max_pending  integer default 3
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

commit;
