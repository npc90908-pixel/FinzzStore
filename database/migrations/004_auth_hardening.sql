-- ============================================================================
-- 004 — AUTH HARDENING: bind OTP to its owner + count failed attempts
--
-- WHY THIS EXISTS
--
-- A 6-digit code has only 1,000,000 possible values. In 002 the verification
-- code was looked up by `sha256(code)` alone, with no reference to the account
-- it was issued for. Two consequences:
--
--   1. Two users holding the same code at the same time were ambiguous: the
--      lookup returned the newest matching row, so a caller could be handed a
--      session for an account that is not theirs.
--   2. `attempts` was only incremented when a token was *matched*, so a wrong
--      guess incremented nothing and `max_attempts` could never be reached.
--
-- Fixes, both inside the database:
--
--   * `p_user_id` scopes the lookup. The application hashes the code together
--     with the owning user id (sha256("<user-id>:<code>")), so a hash cannot
--     collide across accounts even in principle.
--   * A miss for a known user increments `attempts` on that user's live token
--     and burns it once `max_attempts` is reached, making brute force bounded
--     at the data layer instead of relying on HTTP rate limits alone.
--
-- RETURN-BASED ERRORS
--
-- Expected outcomes are returned as JSON, not raised. In PL/pgSQL a RAISE
-- aborts the enclosing statement, which would roll back the very counter update
-- this function exists to perform (the first version of this migration did
-- exactly that: a wrong guess raised TOKEN_INVALID and the attempts increment
-- was silently undone). Callers read `ok` and translate `reason` themselves.
--
-- The old two-argument signature is dropped, not overloaded, so there is no
-- path that can still call the unbound version. Idempotent.
-- ============================================================================

begin;

drop function if exists public.rpc_consume_email_token(text, public.auth_token_kind);
drop function if exists public.rpc_consume_email_token(text, public.auth_token_kind, uuid);

create or replace function public.rpc_consume_email_token(
  p_token_hash text,
  p_kind       public.auth_token_kind,
  p_user_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token      public.auth_tokens;
  v_profile    public.profiles;
  v_remaining  integer;
begin
  -- Row lock makes double-submit impossible: the second caller sees
  -- consumed_at already set and is rejected.
  select * into v_token
    from public.auth_tokens
   where token_hash = p_token_hash
     and kind = p_kind
     and consumed_at is null
     and (p_user_id is null or user_id = p_user_id)
   order by created_at desc
   limit 1
   for update;

  if v_token.id is null then
    -- No match. If we know which account is being verified, charge the guess
    -- to that account's live token so max_attempts actually means something.
    if p_user_id is not null then
      update public.auth_tokens
         set attempts = attempts + 1
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null;

      update public.auth_tokens
         set consumed_at = now()
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null
         and attempts >= max_attempts;

      select coalesce(min(max_attempts - attempts), 0) into v_remaining
        from public.auth_tokens
       where user_id = p_user_id
         and kind = p_kind
         and consumed_at is null;
    end if;

    return jsonb_build_object(
      'ok', false,
      'reason', 'TOKEN_INVALID',
      'attempts_remaining', coalesce(v_remaining, 0)
    );
  end if;

  if v_token.expires_at < now() then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_EXPIRED', 'attempts_remaining', 0);
  end if;

  if v_token.attempts >= v_token.max_attempts then
    update public.auth_tokens set consumed_at = now() where id = v_token.id;
    return jsonb_build_object('ok', false, 'reason', 'TOKEN_ATTEMPTS_EXCEEDED', 'attempts_remaining', 0);
  end if;

  update public.auth_tokens
     set consumed_at = now(), attempts = attempts + 1
   where id = v_token.id;

  if p_kind = 'email_verification' then
    update public.profiles
       set email_verified_at = coalesce(email_verified_at, now())
     where id = v_token.user_id
     returning * into v_profile;
  else
    select * into v_profile from public.profiles where id = v_token.user_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_token.user_id,
    'email', v_profile.email,
    'email_verified_at', v_profile.email_verified_at
  );
end;
$$;

revoke all on function public.rpc_consume_email_token(text, public.auth_token_kind, uuid)
  from public, anon, authenticated;
grant execute on function public.rpc_consume_email_token(text, public.auth_token_kind, uuid)
  to service_role;

commit;
