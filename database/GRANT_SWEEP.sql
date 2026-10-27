-- ============================================================================
-- GRANT SWEEP — dijalankan OTOMATIS setelah setiap `npm run db:migrate`.
--
-- Kenapa file terpisah dari migrasi 006: di Supabase, SETIAP fungsi baru di
-- schema `public` mewarisi EXECUTE untuk `anon`/`authenticated` lewat default
-- privileges. Migrasi 006 mengunci semua RPC yang ada SAAT ITU, tetapi migrasi
-- 007 yang menambah lima RPC baru langsung membukanya lagi — terbukti pada
-- 26 Okt 2026: `db:verify` menolak lolos dengan 5 RPC baru yang bisa dipanggil
-- `anon`.
--
-- Karena itu penguncian bukan sebuah migrasi satu kali, melainkan langkah
-- sapu bersih yang selalu dijalankan di akhir rangkaian migrasi. Isinya
-- idempoten dan tidak menghapus data.
--
-- Isi file ini identik dengan migrasi 006 (yang tetap disimpan sebagai catatan
-- sejarah); sumber kebenarannya sekarang file ini.
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
