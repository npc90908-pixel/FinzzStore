-- ============================================================================
-- 008 — NOTIFIKASI PENGGUNA (hanya dari peristiwa yang benar-benar terjadi)
--
-- ATURAN: tidak ada notifikasi karangan. Setiap baris di tabel ini dibuat oleh
-- TRIGGER di dalam database, tepat pada saat baris sumbernya berubah:
--
--   · public.orders.status        -> order dibuat / nomor terbit / OTP masuk /
--                                    selesai / dibatalkan / kedaluwarsa / ditinjau
--   · public.orders.refunded_at   -> saldo dikembalikan
--   · public.deposits.status      -> deposit disetujui / ditolak
--
-- Konsekuensinya: job poller, webhook supplier, aksi admin, dan RPC order
-- semuanya memakai jalur yang sama, dan tidak ada satu pun kode aplikasi yang
-- bisa "lupa" mengirim notifikasi — atau memalsukannya. Kalau baris sumbernya
-- tidak berubah, tidak ada notifikasi.
--
-- Tabel ini tidak pernah menyimpan OTP, nomor telepon lengkap, atau token:
-- hanya judul/ringkasan dan rujukan id order/deposit.
-- ============================================================================

create table if not exists public.notifications (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  type        text not null,
  severity    text not null default 'info',
  title       text not null,
  body        text,
  order_id    uuid references public.orders (id) on delete cascade,
  deposit_id  uuid references public.deposits (id) on delete cascade,
  meta        jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint notifications_type_format check (type ~ '^[a-z][a-z0-9_]{2,39}(\.[a-z][a-z0-9_]{1,39})?$'),
  constraint notifications_severity_valid check (severity in ('info', 'success', 'warning', 'danger')),
  constraint notifications_title_length check (char_length(title) between 3 and 120),
  constraint notifications_body_length check (body is null or char_length(body) <= 600),
  -- A notification must point at a real subject, never at both at once.
  constraint notifications_subject check (num_nonnulls(order_id, deposit_id) <= 1)
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc, id desc);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- Trigger order. Satu fungsi untuk INSERT dan UPDATE supaya pemetaan status
-- hanya ada di satu tempat.
-- ---------------------------------------------------------------------------
create or replace function public.fn_notifications_on_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  subject text;
  kind    text;
  title   text;
  body    text;
  level   text := 'info';
begin
  subject := coalesce(NEW.provider_app_name, 'Layanan') || ' ' || coalesce(NEW.provider_country_name, '');

  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, type, severity, title, body, order_id, meta)
    values (
      NEW.user_id,
      'order.created',
      'info',
      'Order dibuat',
      format('Order %s sedang diproses. Nomor dan OTP muncul otomatis di halaman Order & OTP.', subject),
      NEW.id,
      jsonb_build_object('status', NEW.status, 'totalPrice', NEW.total_price)
    );
    return NEW;
  end if;

  -- Pengembalian saldo adalah peristiwa tersendiri (uang kembali ke dompet),
  -- jadi ia punya notifikasinya sendiri di samping notifikasi status.
  if NEW.refunded_at is not null and OLD.refunded_at is null then
    insert into public.notifications (user_id, type, severity, title, body, order_id, meta)
    values (
      NEW.user_id,
      'wallet.refund',
      'success',
      'Saldo dikembalikan',
      format('Saldo untuk order %s sudah kembali ke dompet Anda. Lihat rinciannya di halaman Saldo.', subject),
      NEW.id,
      jsonb_build_object('status', NEW.status, 'refundedAt', NEW.refunded_at)
    );
  end if;

  if NEW.status is not distinct from OLD.status then
    return NEW;
  end if;

  case NEW.status
    when 'waiting' then
      kind := 'order.waiting'; title := 'Nomor sudah terbit'; level := 'info';
      body := format('Nomor virtual untuk %s sudah aktif. OTP akan masuk otomatis.', subject);
    when 'received' then
      kind := 'order.received'; title := 'Kode OTP diterima'; level := 'success';
      body := format('Kode OTP untuk %s sudah masuk. Buka halaman Order & OTP untuk melihatnya.', subject);
    when 'completed' then
      kind := 'order.completed'; title := 'Order selesai'; level := 'success';
      body := format('Order %s selesai. Terima kasih sudah memakai FINZZ Store.', subject);
    when 'cancelled' then
      kind := 'order.cancelled'; title := 'Order dibatalkan'; level := 'warning';
      body := format('Order %s dibatalkan. Jika saldo sudah terpotong, saldo dikembalikan otomatis.', subject);
    when 'expired' then
      kind := 'order.expired'; title := 'Order kedaluwarsa'; level := 'warning';
      body := format('Order %s kedaluwarsa sebelum OTP diterima.', subject);
    when 'needs_review' then
      kind := 'order.needs_review'; title := 'Order perlu ditinjau'; level := 'danger';
      body := format('Order %s sedang ditinjau admin. Kami tidak akan menutupnya sebelum statusnya jelas.', subject);
    else
      return NEW;
  end case;

  insert into public.notifications (user_id, type, severity, title, body, order_id, meta)
  values (
    NEW.user_id, kind, level, title, body, NEW.id,
    jsonb_build_object('from', OLD.status, 'to', NEW.status)
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notifications_on_order on public.orders;
create trigger trg_notifications_on_order
  after insert or update of status, refunded_at on public.orders
  for each row
  execute function public.fn_notifications_on_order();

-- ---------------------------------------------------------------------------
-- Trigger deposit: hanya dua status akhir yang memberi kabar ke pengguna.
-- ---------------------------------------------------------------------------
create or replace function public.fn_notifications_on_deposit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  amount_text text := to_char(coalesce(NEW.approved_amount, NEW.amount), 'FM999G999G999G999');
begin
  if tg_op <> 'UPDATE' or NEW.status is not distinct from OLD.status then
    return NEW;
  end if;

  if NEW.status = 'approved' then
    insert into public.notifications (user_id, type, severity, title, body, deposit_id, meta)
    values (
      NEW.user_id, 'deposit.approved', 'success', 'Deposit disetujui',
      format('Deposit Rp%s sudah masuk ke saldo Anda.', amount_text),
      NEW.id, jsonb_build_object('amount', NEW.approved_amount)
    );
  elsif NEW.status = 'rejected' then
    insert into public.notifications (user_id, type, severity, title, body, deposit_id, meta)
    values (
      NEW.user_id, 'deposit.rejected', 'danger', 'Deposit ditolak',
      coalesce('Alasan: ' || nullif(NEW.admin_note, '') || '. ', '') ||
      'Ajukan deposit ulang dengan bukti transfer yang jelas.',
      NEW.id, jsonb_build_object('amount', NEW.amount)
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_notifications_on_deposit on public.deposits;
create trigger trg_notifications_on_deposit
  after update of status on public.deposits
  for each row
  execute function public.fn_notifications_on_deposit();

-- ---------------------------------------------------------------------------
-- Hak akses. Tabel ini berisi riwayat pribadi: tidak ada peran publik yang
-- boleh membacanya lewat PostgREST. Server aplikasi memakai service_role.
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;
grant select, insert, update, delete on public.notifications to service_role;
grant usage, select on sequence public.notifications_id_seq to service_role;

revoke all on function public.fn_notifications_on_order() from public, anon, authenticated;
revoke all on function public.fn_notifications_on_deposit() from public, anon, authenticated;
