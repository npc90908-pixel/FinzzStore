-- TeleKos webhook retries must recover failed deliveries instead of becoming no-ops.
-- Success sets processed_at; failures store error while leaving processed_at NULL.
create or replace function public.rpc_record_webhook_event(
  p_delivery_id text,
  p_event_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
  v_retried boolean := false;
begin
  insert into public.supplier_webhook_events (delivery_id, event_type, payload)
  values (p_delivery_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- A failed delivery has processed_at=NULL and a non-null error. Permit a
    -- signed provider retry to reclaim it, but never re-run a successful event.
    update public.supplier_webhook_events
       set error = null
     where delivery_id = p_delivery_id
       and processed_at is null
       and error is not null
    returning id into v_id;
    v_retried := v_id is not null;
  end if;

  if v_id is null then
    return jsonb_build_object('inserted', false);
  end if;
  return jsonb_build_object('inserted', true, 'id', v_id, 'retried', v_retried);
end;
$$;
