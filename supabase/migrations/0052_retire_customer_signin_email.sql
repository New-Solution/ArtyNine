-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 8 Nov 2026, after front-end
-- commit f6b4206 was live; every verification column true, all manual tests
-- passed, and phone sign-in plus the wrong-password message checked on the
-- live site (EN + AR).
-- =============================================================================
-- 0052 — RETIRE customer_signin_email() AND ITS THROTTLE TABLE
--
-- Run after 0051_data_reset_super_admin_only.sql (applied).
--
-- ⚠️ DEPLOY ORDER: the front-end commit that stops calling this function and
-- removes its startup probe (src/lib/migrationCheck.ts), f6b4206, must be LIVE
-- first. An older build still probes it on every page load; once it is dropped
-- that probe reports "migration 0005 not applied" to every visitor, and a
-- failed phone sign-in shows "Could not sign you in right now".
--
-- WHAT IT WAS (0005)
-- customer_signin_email(p_identifier, p_password) took a phone number (or an
-- email) and a password, checked the password itself against
-- auth.users.encrypted_password, and returned the account's email so the
-- browser could call signInWithPassword(email). It let accounts that live at
-- an email address sign in by typing their phone number.
--
-- WHY IT GOES
--   - It checked passwords outside Supabase Auth: none of Auth's rate
--     limiting, and no CAPTCHA (Turnstile is enforced by Auth, not here).
--   - Its own throttle (public.signin_attempts: 5 failures -> 15 minutes) was
--     keyed on lower(btrim(p_identifier)), but the lookup normalised the phone
--     (normalize_customer_phone). '0501234567', '+966501234567',
--     '966 50 123 4567', ... were separate throttle keys for the same account,
--     so the limit could be sidestepped by varying the format: an unthrottled
--     password-guessing endpoint, callable by anon.
--   - Nobody needs it: with VITE_PHONE_AUTH on, phone accounts sign in
--     through Supabase's own phone sign-in. Checked on the live database
--     before writing this: 1 customer account, its phone confirmed in Auth;
--     0 accounts that are email-only, 0 that relied on this function.
--
-- WHAT THIS DOES
--   1. revoke EXECUTE on customer_signin_email(text, text) from public, anon,
--      authenticated (closes it at once, even if the drop below were to fail)
--   2. drop function public.customer_signin_email(text, text)
--   3. drop table public.signin_attempts (used by nothing else)
-- No CASCADE anywhere: if anything still depends on either object, the drop
-- fails and nothing is lost. The pre-flight also refuses if another function
-- in the public schema still mentions either name.
--
-- UNTOUCHED
--   customer_signin_route(), customer_claim_email_matches() (0005; EXECUTE
--   already revoked from the website by 0043), normalize_customer_phone(),
--   link_customer_by_verified_phone() (0041), Supabase Auth itself.
--
-- ROLLBACK
-- Re-run the customer_signin_email section of
-- 0005_signin_by_phone_or_email.sql (the signin_attempts table, the function,
-- and its revoke/grant lines) — and restore the front-end call. Not
-- recommended: it re-opens the throttle bypass above.
-- =============================================================================

-- Pre-flight.
do $$
declare
  v_fn text;
begin
  if to_regprocedure('public.normalize_customer_phone(text)') is null then
    raise exception '0052 aborted: normalize_customer_phone(text) missing — is this the right database?';
  end if;

  -- Nothing else may still use what is being dropped. (The function itself is
  -- excluded; it is the thing going.)
  select p.oid::regprocedure::text into v_fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.oid is distinct from to_regprocedure('public.customer_signin_email(text,text)')
     and (p.prosrc ilike '%customer_signin_email%' or p.prosrc ilike '%signin_attempts%')
   limit 1;
  if v_fn is not null then
    raise exception '0052 aborted: % still refers to customer_signin_email / signin_attempts', v_fn;
  end if;

  if to_regprocedure('public.customer_signin_email(text,text)') is null
     and to_regclass('public.signin_attempts') is null then
    raise notice '0052: already applied — nothing to do';
  end if;
end $$;

-- 1. Revoke (skipped if the function is already gone).
do $$
begin
  if to_regprocedure('public.customer_signin_email(text,text)') is not null then
    revoke execute on function public.customer_signin_email(text, text) from public, anon, authenticated;
  end if;
end $$;

-- 2. Drop the function. No CASCADE.
drop function if exists public.customer_signin_email(text, text);

-- 3. Drop its throttle table. No CASCADE.
drop table if exists public.signin_attempts;

-- Verification — every column must be true.
select
  to_regprocedure('public.customer_signin_email(text,text)') is null       as signin_email_fn_dropped,
  to_regclass('public.signin_attempts') is null                            as signin_attempts_dropped,
  to_regprocedure('public.customer_signin_route(text)') is not null        as route_fn_kept,
  not has_function_privilege('anon', 'public.customer_signin_route(text)', 'execute')
                                                                           as route_fn_still_revoked,
  to_regprocedure('public.link_customer_by_verified_phone(text)') is not null
                                                                           as phone_link_fn_kept,
  to_regprocedure('public.normalize_customer_phone(text)') is not null     as normalize_phone_kept;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0052 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- It writes nothing; the final RAISE is there for the same habit as earlier
-- test blocks.
-- =============================================================================
/*
DO $$
DECLARE
  v_fn     text;
  v_called boolean;
BEGIN
  -- 1. The function and its throttle table are gone.
  ASSERT to_regprocedure('public.customer_signin_email(text,text)') IS NULL,
    'Case 1a: customer_signin_email(text,text) still exists';
  ASSERT NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'customer_signin_email'),
    'Case 1b: a customer_signin_email overload with another signature still exists';
  ASSERT to_regclass('public.signin_attempts') IS NULL,
    'Case 1c: public.signin_attempts still exists';

  -- 2. A website caller (anon, as PostgREST runs it) can no longer reach it.
  --    SET LOCAL inside this sub-block is undone when the expected error rolls
  --    the sub-block back.
  v_called := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.customer_signin_email('0501234567', 'not-a-password');
    v_called := true;
    RESET ROLE;
  EXCEPTION WHEN undefined_function THEN
    NULL;  -- expected
  END;
  ASSERT NOT v_called, 'Case 2a: anon could still call customer_signin_email';

  v_called := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.customer_signin_email('0501234567', 'not-a-password');
    v_called := true;
    RESET ROLE;
  EXCEPTION WHEN undefined_function THEN
    NULL;  -- expected
  END;
  ASSERT NOT v_called, 'Case 2b: authenticated could still call customer_signin_email';

  -- 3. Nothing left in the public schema refers to either name.
  SELECT p.oid::regprocedure::text INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.prosrc ILIKE '%customer_signin_email%' OR p.prosrc ILIKE '%signin_attempts%')
   LIMIT 1;
  ASSERT v_fn IS NULL, format('Case 3: %s still refers to customer_signin_email / signin_attempts', v_fn);

  -- 4. The 0005 siblings are untouched: still there, still closed to the
  --    website (0043).
  ASSERT to_regprocedure('public.customer_signin_route(text)') IS NOT NULL,
    'Case 4a: customer_signin_route(text) was dropped — 0052 must not touch it';
  ASSERT to_regprocedure('public.customer_claim_email_matches(text,text)') IS NOT NULL,
    'Case 4b: customer_claim_email_matches(text,text) was dropped — 0052 must not touch it';
  ASSERT NOT has_function_privilege('anon', 'public.customer_signin_route(text)', 'execute')
     AND NOT has_function_privilege('authenticated', 'public.customer_signin_route(text)', 'execute'),
    'Case 4c: customer_signin_route is executable by the website again (0043 revoked it)';
  ASSERT NOT has_function_privilege('anon', 'public.customer_claim_email_matches(text,text)', 'execute')
     AND NOT has_function_privilege('authenticated', 'public.customer_claim_email_matches(text,text)', 'execute'),
    'Case 4d: customer_claim_email_matches is executable by the website again (0043 revoked it)';

  -- 5. What phone sign-in still needs is intact.
  ASSERT to_regprocedure('public.normalize_customer_phone(text)') IS NOT NULL,
    'Case 5a: normalize_customer_phone(text) is missing';
  ASSERT public.normalize_customer_phone('+966 50 123 4567') = '501234567',
    'Case 5b: normalize_customer_phone no longer normalises a Saudi number';
  ASSERT to_regprocedure('public.link_customer_by_verified_phone(text)') IS NOT NULL,
    'Case 5c: link_customer_by_verified_phone(text) is missing';
  ASSERT has_function_privilege('authenticated', 'public.link_customer_by_verified_phone(text)', 'execute'),
    'Case 5d: authenticated can no longer execute link_customer_by_verified_phone';

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0052 TESTS PASSED — rolled back';
END $$;
*/
