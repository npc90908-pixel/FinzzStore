-- ============================================================================
-- 006 — KUNCI HAK EKSEKUSI RPC
--
-- TEMUAN (26 Okt 2026, database produksi):
--   `npm run db:verify` melaporkan 24 fungsi `rpc_*` dapat dieksekusi oleh
--   peran `anon`, `authenticated`, dan PUBLIC:
--
--     rpc_admin_adjust_balance, rpc_set_user_role, rpc_approve_deposit,
--     rpc_refund_order, rpc_create_order, rpc_cron_claim, … (24 fungsi)
--
--   Di project Supabase, fungsi baru di schema `public` mewarisi EXECUTE untuk
--   peran Supabase lewat default privileges. `revoke` per-fungsi di
--   functions.sql tidak menutup fungsi yang ditambahkan kemudian
--   (rpc_cron_* dari 003, rpc_sync_services, rpc_flag_orphan_pending_orders,
--   rpc_record_webhook_event), jadi celahnya tumbuh tanpa terlihat.
--
-- KENAPA INI PENTING:
--   Kunci `anon` Supabase bersifat publik (ia memang dirancang untuk browser).
--   Selama fungsi uang bisa dipanggil `anon`, siapa pun yang tahu URL project
--   dapat mencoba memanggil rpc_admin_adjust_balance lewat PostgREST. Aplikasi
--   ini tidak lagi memakai PostgREST, tetapi URL itu tetap hidup di project
--   Supabase sampai dimatikan — jadi izin database harus benar dengan sendirinya,
--   bukan bergantung pada "tidak ada yang tahu URL-nya".
--
-- YANG DILAKUKAN:
--   · mencabut EXECUTE dari PUBLIC, anon, authenticated untuk SEMUA rpc_*;
--   · mengecualikan rpc_public_summary (memang publik: hanya agregat katalog
--     untuk landing page) — diberi ke anon/authenticated secara eksplisit;
--   · memberi service_role akses ke semuanya (server memakai satu role).
--
-- SIFAT: idempoten, aditif, tidak menghapus data, tidak mematikan RLS.
-- Setiap fungsi baru di masa depan otomatis ikut terkunci karena loopnya
-- membaca pg_proc, bukan daftar nama yang ditulis tangan.
-- ============================================================================

do $$
declare
  fn record;
  locked integer := 0;
begin
  for fn in
    select p.oid::regprocedure as signature, p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'rpc\_%'
       and p.proname <> 'rpc_public_summary'
  loop
    execute format('revoke all on function %s from public', fn.signature);
    execute format('revoke all on function %s from anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
    locked := locked + 1;
  end loop;

  raise notice '006: % fungsi rpc_* dikunci untuk service_role', locked;

  -- Satu-satunya pengecualian yang disengaja.
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rpc_public_summary'
  loop
    execute format('revoke all on function %s from public', fn.signature);
    execute format('grant execute on function %s to anon, authenticated, service_role', fn.signature);
    raise notice '006: rpc_public_summary tetap publik (agregat katalog untuk landing page)';
  end loop;
end
$$;

-- Tabel yang tidak boleh dibaca peran publik sama sekali.
do $$
declare t text;
begin
  foreach t in array array['auth_tokens', 'sessions', 'cron_locks', 'idempotency_keys',
                           'supplier_webhook_events', 'admin_audit_logs']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------- DIAGNOSTIK --
do $$
declare
  bad integer;
begin
  select count(*) into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'rpc\_%'
     and p.proname <> 'rpc_public_summary'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  raise notice '----------------------------------------';
  raise notice 'rpc_* masih bisa dipanggil anon : % (harus 0)', bad;
  raise notice 'rpc_public_summary bisa anon    : % (harus t)',
    has_function_privilege('anon', 'public.rpc_public_summary()'::regprocedure, 'EXECUTE');
end
$$;
