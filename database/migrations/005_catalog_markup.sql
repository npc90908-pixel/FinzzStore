-- ============================================================================
-- 005 — CATALOGUE MARKUP PERSISTENCE
--
-- `rpc_sync_services` originally stored supplier_price and the final price but
-- dropped the markup that connected them, so services.markup_bps kept its
-- column default (1500) no matter what the admin configured. The catalogue then
-- displayed one price while the checkout recomputed another from the stale
-- markup.
--
-- The function now persists markup_bps as part of the sync payload. Existing
-- rows keep their stored price until the next successful sync, which is the
-- correct behaviour: a price shown to a customer is only replaced by a fresh
-- quote from the supplier.
--
-- Idempotent (CREATE OR REPLACE). The same definition is in database/functions.sql
-- so a fresh install never needs to run this file.
-- ============================================================================

begin;

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

commit;
