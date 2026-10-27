-- ============================================================================
-- MIGRATION 009 — explicit Google identity linking (custom FINZZ auth remains)
--
-- Google OIDC subjects are unique external identifiers. Existing FINZZ profiles
-- are NOT auto-merged by matching email. New Google registrations are marked
-- as having no local password until the user completes password recovery.
-- ============================================================================
begin;

alter table public.profiles
  add column if not exists password_auth_enabled boolean not null default true;

-- A legacy row without a password hash cannot authenticate with a local
-- password, so it must not be counted as a safe alternative for unlinking.
update public.profiles
   set password_auth_enabled = false
 where password_hash is null and password_auth_enabled is distinct from false;

comment on column public.profiles.password_auth_enabled is
  'Whether the account has a user-known local password. OAuth-created random hashes are disabled until password reset.';

create or replace function public.fn_enable_password_auth_after_password_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.password_hash is not null and old.password_hash is distinct from new.password_hash then
    new.password_auth_enabled := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enable_password_auth_after_password_change on public.profiles;
create trigger trg_enable_password_auth_after_password_change
  before update of password_hash on public.profiles
  for each row execute function public.fn_enable_password_auth_after_password_change();

create table if not exists public.oauth_identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  provider         text not null check (provider in ('google')),
  provider_subject text not null,
  provider_email   text not null,
  provider_name    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint oauth_identity_subject_length check (char_length(provider_subject) between 1 and 255),
  constraint oauth_identity_email_length check (char_length(provider_email) between 3 and 254),
  constraint oauth_identity_name_length check (provider_name is null or char_length(provider_name) <= 80),
  constraint oauth_identity_provider_subject_unique unique (provider, provider_subject),
  constraint oauth_identity_user_provider_unique unique (user_id, provider)
);

create index if not exists oauth_identities_user_idx on public.oauth_identities (user_id, created_at);
create index if not exists oauth_identities_subject_idx on public.oauth_identities (provider, provider_subject);

alter table public.oauth_identities enable row level security;
revoke all on public.oauth_identities from public, anon, authenticated;
grant select, insert, update, delete on public.oauth_identities to service_role;

-- Link a verified Google subject to the currently authenticated FINZZ user.
-- Both uniqueness conflicts are recorded as audit events; no email-based merge
-- or user reassignment is ever attempted.
create or replace function public.rpc_link_google_identity(
  p_user_id          uuid,
  p_provider_subject text,
  p_provider_email   text,
  p_provider_name    text default null,
  p_ip               text default null,
  p_user_agent       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_subject public.oauth_identities;
  v_user_identity public.oauth_identities;
begin
  if p_user_id is null or p_provider_subject is null or char_length(p_provider_subject) not between 1 and 255
     or p_provider_email is null or p_provider_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('linked', false, 'reason', 'INVALID_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtext('finzz-google:' || p_provider_subject));
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('linked', false, 'reason', 'USER_NOT_FOUND');
  end if;
  if v_profile.status <> 'active' then
    return jsonb_build_object('linked', false, 'reason', 'ACCOUNT_INACTIVE');
  end if;

  select * into v_subject
    from public.oauth_identities
   where provider = 'google' and provider_subject = p_provider_subject
   for update;
  if found and v_subject.user_id <> p_user_id then
    perform public._audit(
      null, 'oauth.google.link_conflict', 'user', p_user_id::text,
      'Google subject is already linked to another FINZZ account', null,
      jsonb_build_object('provider', 'google', 'email', lower(p_provider_email)),
      left(p_ip, 64), left(p_user_agent, 300)
    );
    return jsonb_build_object('linked', false, 'conflict', true);
  end if;

  select * into v_user_identity
    from public.oauth_identities
   where user_id = p_user_id and provider = 'google'
   for update;
  if found and v_user_identity.provider_subject <> p_provider_subject then
    perform public._audit(
      null, 'oauth.google.link_conflict', 'user', p_user_id::text,
      'A different Google subject is already linked to this FINZZ account', null,
      jsonb_build_object('provider', 'google', 'email', lower(p_provider_email)),
      left(p_ip, 64), left(p_user_agent, 300)
    );
    return jsonb_build_object('linked', false, 'conflict', true);
  end if;

  if found then
    update public.oauth_identities
       set provider_email = lower(p_provider_email),
           provider_name = left(nullif(p_provider_name, ''), 80),
           updated_at = now()
     where id = v_user_identity.id;
    return jsonb_build_object('linked', true, 'alreadyLinked', true);
  end if;

  insert into public.oauth_identities
    (user_id, provider, provider_subject, provider_email, provider_name)
  values
    (p_user_id, 'google', p_provider_subject, lower(p_provider_email), left(nullif(p_provider_name, ''), 80));

  perform public._audit(
    null, 'oauth.google.link', 'user', p_user_id::text,
    'Google identity linked by authenticated user', null,
    jsonb_build_object('provider', 'google', 'email', lower(p_provider_email)),
    left(p_ip, 64), left(p_user_agent, 300)
  );
  return jsonb_build_object('linked', true, 'alreadyLinked', false);
end;
$$;

-- Atomic first-time Google registration + identity insert. The advisory locks
-- serialize both email and subject to avoid orphan profiles in concurrent
-- callbacks. Existing email collisions return a signal for explicit linking.
create or replace function public.rpc_create_google_account(
  p_email            text,
  p_password_hash    text,
  p_username         text,
  p_provider_subject  text,
  p_provider_email    text,
  p_provider_name     text default null,
  p_ip                text default null,
  p_user_agent        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_profile public.profiles;
  v_link jsonb;
begin
  if p_email is null or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or p_provider_email is null or lower(p_email) <> lower(p_provider_email)
     or p_provider_subject is null or char_length(p_provider_subject) not between 1 and 255
     or p_password_hash is null or char_length(p_password_hash) < 20 then
    return jsonb_build_object('created', false, 'reason', 'INVALID_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtext('finzz-google:' || p_provider_subject));
  -- Share the same email lock key used by rpc_register_user so a concurrent
  -- local sign-up cannot race the explicit collision check below.
  perform pg_advisory_xact_lock(hashtext(lower(p_email)));

  if exists (select 1 from public.oauth_identities where provider = 'google' and provider_subject = p_provider_subject) then
    return jsonb_build_object('created', false, 'subjectConflict', true);
  end if;
  if exists (select 1 from public.profiles where lower(email) = lower(p_email)) then
    return jsonb_build_object('created', false, 'emailConflict', true);
  end if;

  -- Reuse the existing custom-auth profile + wallet registration RPC.
  perform public.rpc_register_user(lower(p_email), p_password_hash, p_username);
  select id into v_user_id from public.profiles where lower(email) = lower(p_email);
  if v_user_id is null then
    raise exception using errcode = 'P0001', message = 'OAUTH_PROFILE_CREATE_FAILED';
  end if;

  update public.profiles
     set email_verified_at = coalesce(email_verified_at, now()),
         password_auth_enabled = false,
         full_name = left(nullif(p_provider_name, ''), 80),
         updated_at = now()
   where id = v_user_id;

  v_link := public.rpc_link_google_identity(
    v_user_id, p_provider_subject, p_provider_email, p_provider_name, p_ip, p_user_agent
  );
  if coalesce((v_link->>'linked')::boolean, false) is not true then
    raise exception using errcode = 'P0001', message = 'OAUTH_IDENTITY_CONFLICT';
  end if;

  select * into v_profile from public.profiles where id = v_user_id;
  return jsonb_build_object('created', true, 'profile', to_jsonb(v_profile) - 'password_hash');
end;
$$;

-- A linked identity may be removed only if a known local password or a second
-- provider remains. This DB invariant is repeated even though the app also asks
-- the user to re-enter their current password.
create or replace function public.rpc_unlink_google_identity(
  p_user_id   uuid,
  p_ip        text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_identity public.oauth_identities;
  v_other_count integer;
begin
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then return jsonb_build_object('unlinked', false, 'reason', 'USER_NOT_FOUND'); end if;

  select * into v_identity from public.oauth_identities
   where user_id = p_user_id and provider = 'google' for update;
  if not found then return jsonb_build_object('unlinked', false, 'reason', 'NOT_LINKED'); end if;

  select count(*) into v_other_count from public.oauth_identities
   where user_id = p_user_id and provider <> 'google';
  if not v_profile.password_auth_enabled and v_other_count = 0 then
    return jsonb_build_object('unlinked', false, 'reason', 'LAST_LOGIN_METHOD');
  end if;

  delete from public.oauth_identities where id = v_identity.id;
  perform public._audit(
    null, 'oauth.google.unlink', 'user', p_user_id::text,
    'Google identity unlinked by authenticated user',
    jsonb_build_object('provider', 'google', 'email', v_identity.provider_email), null,
    left(p_ip, 64), left(p_user_agent, 300)
  );
  return jsonb_build_object('unlinked', true);
end;
$$;

revoke all on public.oauth_identities from public, anon, authenticated;
revoke all on function public.fn_enable_password_auth_after_password_change() from public, anon, authenticated;
revoke all on function public.rpc_link_google_identity(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rpc_create_google_account(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rpc_unlink_google_identity(uuid, text, text) from public, anon, authenticated;
grant execute on function public.rpc_link_google_identity(uuid, text, text, text, text, text) to service_role;
grant execute on function public.rpc_create_google_account(text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.rpc_unlink_google_identity(uuid, text, text) to service_role;

commit;
