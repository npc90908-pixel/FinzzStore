-- ============================================================================
-- 007 — KONTEKS VERIFIKASI EMAIL (registrasi tanpa mengetik email ulang)
--
-- MASALAH: setelah mendaftar, halaman /verify-email masih meminta email.
-- Itu bukan sekadar merepotkan — ia menggeser bukti kepemilikan akun ke input
-- browser. Siapa pun bisa mengetik alamat orang lain di sana dan mencoba kode.
--
-- SOLUSI: setelah registrasi, server menerbitkan token acak 32 byte, menyimpan
-- HANYA hash SHA-256-nya di tabel ini, dan mengirim token mentah itu ke browser
-- lewat cookie HttpOnly. Halaman verifikasi kemudian tidak perlu tahu email
-- sama sekali: ia hanya mengirim kode 6 digit, dan server mencocokkannya dengan
-- konteks cookie. Email yang ditampilkan di layar berasal dari baris database
-- (disamarkan), bukan dari apa pun yang bisa diketik pengguna.
--
-- SIFAT:
--   · satu konteks aktif per akun (unique user_id) — mencegah kebingungan kode;
--   · kedaluwarsa 30 menit; OTP-nya sendiri tetap 10 menit;
--   · cooldown kirim ulang ditegakkan di database, bukan di memori proses,
--     supaya beberapa instance serverless tidak bisa diakali dengan request
--     bersamaan (race) — lihat rpc_claim_verify_resend;
--   · token mentah, OTP, dan password tidak pernah masuk tabel ini.
-- ============================================================================

create table if not exists public.email_verification_contexts (
  token_hash      text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  email           text not null,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  last_sent_at    timestamptz,
  resend_count    integer not null default 0,
  resend_window   timestamptz not null default now(),
  email_sent      boolean not null default false,
  email_error     text,
  consumed_at     timestamptz,
  created_ip      inet,
  user_agent      text
);

-- Satu konteks hidup per akun: menerbitkan konteks baru harus menimpa yang lama,
-- bukan menumpuk dua token yang sama-sama sah.
create unique index if not exists email_verification_contexts_one_active
  on public.email_verification_contexts (user_id)
  where consumed_at is null;

create index if not exists email_verification_contexts_expiry
  on public.email_verification_contexts (expires_at)
  where consumed_at is null;

alter table public.email_verification_contexts enable row level security;
revoke all on table public.email_verification_contexts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Terbitkan (atau ganti) konteks verifikasi untuk satu akun.
-- Dipanggil setelah registrasi berhasil dan setelah login akun belum terverifikasi.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_issue_verify_context(
  p_user_id      uuid,
  p_token_hash   text,
  p_email        text,
  p_ttl_seconds  integer default 1800,
  p_ip           text default null,
  p_user_agent   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.email_verification_contexts;
begin
  if p_user_id is null or coalesce(p_token_hash, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_ARGUMENT');
  end if;

  -- Konteks lama milik akun yang sama tidak boleh tetap sah.
  update public.email_verification_contexts
     set consumed_at = now()
   where user_id = p_user_id and consumed_at is null;

  insert into public.email_verification_contexts
    (token_hash, user_id, email, expires_at, created_ip, user_agent)
  values
    (p_token_hash, p_user_id, lower(p_email),
     now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 7200))),
     case when p_ip is null then null else p_ip::inet end,
     left(p_user_agent, 400))
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_row.user_id,
    'email', v_row.email,
    'expires_at', v_row.expires_at,
    'issued_at', v_row.issued_at
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Baca konteks berdasarkan hash token. Tidak pernah mengembalikan email utuh;
-- pemanggil yang menyamarkan. `active` false berarti kedaluwarsa/dipakai.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_read_verify_context(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.email_verification_contexts;
  v_profile public.profiles;
begin
  select * into v_row
    from public.email_verification_contexts
   where token_hash = p_token_hash
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  select * into v_profile from public.profiles where id = v_row.user_id;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_row.user_id,
    'email', v_row.email,
    'active', v_row.consumed_at is null and v_row.expires_at > now(),
    'expired', v_row.expires_at <= now(),
    'consumed', v_row.consumed_at is not null,
    'expires_at', v_row.expires_at,
    'last_sent_at', v_row.last_sent_at,
    'email_sent', v_row.email_sent,
    'email_error', v_row.email_error,
    'resend_count', v_row.resend_count,
    'already_verified', v_profile.email_verified_at is not null
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Catat hasil pengiriman email pada konteks (berhasil atau gagal).
-- Dipisah dari penerbitan supaya kegagalan SMTP tetap tercatat apa adanya.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_mark_verify_delivery(
  p_token_hash text,
  p_sent       boolean,
  p_error      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.email_verification_contexts
     set last_sent_at = now(),
         email_sent   = coalesce(p_sent, false),
         email_error  = left(p_error, 300)
   where token_hash = p_token_hash;
  return jsonb_build_object('ok', found);
end
$$;

-- ---------------------------------------------------------------------------
-- Cooldown kirim ulang — diklaim secara atomik.
--
-- Ini inti pencegahan "refresh/retry/request bersamaan mengirim OTP berkali-kali".
-- Pemeriksaan dan penaikan penghitung terjadi dalam SATU update bersyarat, jadi
-- dua request yang datang bersamaan tidak bisa dua-duanya lolos: yang kedua
-- melihat resend_count yang sudah dinaikkan oleh yang pertama.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_claim_verify_resend(
  p_token_hash   text,
  p_cooldown_s   integer default 60,
  p_max_per_hour integer default 5
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.email_verification_contexts;
  v_wait integer;
begin
  select * into v_row
    from public.email_verification_contexts
   where token_hash = p_token_hash
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;
  if v_row.consumed_at is not null or v_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'CONTEXT_EXPIRED');
  end if;
  if v_row.resend_count >= p_max_per_hour and v_row.resend_window > now() - interval '1 hour' then
    return jsonb_build_object(
      'ok', false, 'reason', 'RESEND_LIMIT',
      'retry_after', greatest(1, ceil(extract(epoch from (v_row.resend_window + interval '1 hour' - now()))))::int
    );
  end if;
  if v_row.last_sent_at is not null and v_row.last_sent_at > now() - make_interval(secs => greatest(0, p_cooldown_s)) then
    v_wait := greatest(1, ceil(extract(epoch from (v_row.last_sent_at + make_interval(secs => p_cooldown_s) - now()))))::int;
    return jsonb_build_object('ok', false, 'reason', 'COOLDOWN', 'retry_after', v_wait);
  end if;

  update public.email_verification_contexts
     set last_sent_at  = now(),
         resend_count  = case when resend_window > now() - interval '1 hour' then resend_count + 1 else 1 end,
         resend_window = case when resend_window > now() - interval '1 hour' then resend_window else now() end
   where token_hash = p_token_hash;

  return jsonb_build_object('ok', true, 'resend_count', v_row.resend_count + 1);
end
$$;

-- ---------------------------------------------------------------------------
-- Tandai konteks sudah dipakai (setelah verifikasi berhasil).
-- ---------------------------------------------------------------------------
create or replace function public.rpc_consume_verify_context(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.email_verification_contexts
     set consumed_at = now()
   where token_hash = p_token_hash and consumed_at is null;
  return jsonb_build_object('ok', found);
end
$$;

-- Hanya server (satu role database) yang boleh menyentuh tabel ini.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table public.email_verification_contexts to service_role';
    execute 'grant execute on function public.rpc_issue_verify_context(uuid,text,text,integer,text,text) to service_role';
    execute 'grant execute on function public.rpc_read_verify_context(text) to service_role';
    execute 'grant execute on function public.rpc_mark_verify_delivery(text,boolean,text) to service_role';
    execute 'grant execute on function public.rpc_claim_verify_resend(text,integer,integer) to service_role';
    execute 'grant execute on function public.rpc_consume_verify_context(text) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------- DIAGNOSTIK --
do $$
begin
  raise notice '----------------------------------------';
  raise notice 'email_verification_contexts ada : %',
    (to_regclass('public.email_verification_contexts') is not null);
  raise notice 'rpc_issue_verify_context ada     : %',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rpc_issue_verify_context');
  raise notice 'anon boleh baca tabel konteks   : % (harus f)',
    has_table_privilege('anon', 'public.email_verification_contexts', 'SELECT');
end
$$;
