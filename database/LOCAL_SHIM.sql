-- ============================================================================
-- LOCAL SHIM — prasyarat Supabase untuk PostgreSQL biasa
--
-- Skema FINZZ ditulis untuk Supabase, jadi ia memakai tiga hal yang TIDAK ada
-- di PostgreSQL polos:
--
--   · role  anon / authenticated / service_role   (dipakai GRANT dan RLS)
--   · schema `auth` dengan fungsi auth.uid()
--   · tabel  auth.users                          (dirujuk FK profiles.id)
--
-- File ini membuat tiruan minimum dari ketiganya supaya `npm run db:bootstrap`
-- bisa diuji di laptop, CI, atau VPS — tanpa Supabase.
--
-- JANGAN dijalankan di project Supabase sungguhan: di sana ketiga hal itu sudah
-- ada dan dikelola Supabase sendiri. Runner migrasi hanya memakai file ini
-- ketika mendeteksi bahwa role `anon` dan schema `auth` belum ada.
--
-- Catatan keamanan: auth.uid() di sini SELALU null. Itu disengaja. RLS pada
-- deploy ini bukan lapisan otorisasi — server terhubung sebagai satu role
-- database dan setiap fungsi RPC memeriksa p_actor/p_user_id sendiri. RLS tetap
-- diaktifkan agar tidak ada tabel yang terbuka bila kelak ada jalur PostgREST.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $body$ select null::uuid $body$;
    $fn$;
  end if;
  if to_regprocedure('auth.role()') is null then
    execute $fn$
      create function auth.role() returns text
      language sql stable
      as $body$ select 'authenticated'::text $body$;
    $fn$;
  end if;
  if to_regprocedure('auth.jwt()') is null then
    execute $fn$
      create function auth.jwt() returns jsonb
      language sql stable
      as $body$ select '{}'::jsonb $body$;
    $fn$;
  end if;
end
$$;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

comment on table auth.users is
  'Tiruan lokal. Pada deploy ini kredensial disimpan di public.profiles.password_hash, bukan di sini.';
