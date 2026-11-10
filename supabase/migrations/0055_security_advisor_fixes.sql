-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 9 Nov 2026; all six verification
-- columns true and the test block below passed ("ALL 0055 TESTS PASSED").
-- =============================================================================
-- 0055 — SECURITY ADVISOR FIXES
--
-- Run after 0054_in_app_refunds.sql (applied). One transaction: if any check
-- below fails, NOTHING is changed.
--
-- 1. resolve_customer_record: no longer executable by anon.
--    Who still needs it signed out? Nobody on the live site. With phone
--    sign-in on (VITE_PHONE_AUTH=true, production), a signed-out visitor only
--    ever gets the phone-code flow: the checkout form that would register them
--    renders only once signed in (CheckoutInfoSection showGuestPhoneFlow), and
--    the email/password register form renders only when phone sign-in is OFF
--    (AuthSection). The other caller, resolveCustomerForAuthUser(), runs after
--    a successful sign-in (authenticated).
--    The ONLY signed-out caller left is the dormant fallback: phone sign-in
--    OFF and email confirmation ON, where registerCustomer() calls it before a
--    session exists. If that fallback is ever switched back on, registration
--    would show a permission error at that step; the account still exists,
--    and the customer record is created and attached on the first sign-in by
--    resolveCustomerForAuthUser()'s heal path.
--    Closes: a signed-out direct API call could look up a customer's id by
--    phone/email and create unlimited unattached customer rows.
--
-- 2. normalize_customer_phone: search_path pinned to '' (it only calls
--    pg_catalog built-ins, which are always found).
--
-- 3. public-media bucket: public_media_read (SELECT for everyone) is replaced
--    by public_media_staff_read (SELECT for staff only). A public bucket serves
--    files by URL without any policy, so every image URL keeps working; the
--    SELECT policy only allowed anyone to LIST the bucket through the API.
--    Staff keep SELECT because Storage's remove() (mediaUpload.ts) needs SELECT
--    as well as DELETE — dropping it outright would break photo clean-up.
--
-- 4. customers_self_select / _update / _insert: auth.uid() becomes
--    (select auth.uid()) so Postgres evaluates it once per query, not once per
--    row (advisor: auth_rls_initplan). Same logic, same roles; ALTER POLICY
--    keeps each policy in place with no gap.
--
-- Not included: pg_net (schema net). Its grants to anon/authenticated are made
-- by supabase_admin, so postgres cannot revoke them, and the net schema is not
-- exposed through the API. (A first version of 0055 tried and aborted safely.)
--
-- ROLLBACK
--   grant execute on function public.resolve_customer_record(text, text, text, uuid, text) to anon;
--   alter function public.normalize_customer_phone(text) reset search_path;
--   drop policy if exists public_media_staff_read on storage.objects;
--   create policy public_media_read on storage.objects for select to public using (bucket_id = 'public-media');
--   alter policy customers_self_select on public.customers using (user_id = auth.uid());
--   alter policy customers_self_update on public.customers using (user_id = auth.uid()) with check (user_id = auth.uid());
--   alter policy customers_self_insert on public.customers with check (user_id = auth.uid());
--
-- TESTS: the commented-out block at the end of this file, run AFTER it. It
-- ends with an error on purpose ("ALL 0055 TESTS PASSED — rolled back") so
-- nothing is kept.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Pre-flight.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.resolve_customer_record(text,text,text,uuid,text)') is null then
    raise exception '0055 aborted: resolve_customer_record(text,text,text,uuid,text) missing (0042)';
  end if;
  if to_regprocedure('public.normalize_customer_phone(text)') is null then
    raise exception '0055 aborted: normalize_customer_phone(text) missing';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'customers'
        and policyname in ('customers_self_select', 'customers_self_update', 'customers_self_insert')) <> 3 then
    raise exception '0055 aborted: customers_self_select / _update / _insert are not all present — compare the live policies first';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. resolve_customer_record: signed-in callers only.
-- -----------------------------------------------------------------------------
revoke execute on function public.resolve_customer_record(text, text, text, uuid, text) from public, anon;
grant execute on function public.resolve_customer_record(text, text, text, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. normalize_customer_phone: fixed search_path.
-- -----------------------------------------------------------------------------
alter function public.normalize_customer_phone(text) set search_path = '';

-- -----------------------------------------------------------------------------
-- 3. public-media: no public listing; staff keep SELECT for remove().
-- -----------------------------------------------------------------------------
drop policy if exists public_media_read on storage.objects;

drop policy if exists public_media_staff_read on storage.objects;
create policy public_media_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'public-media' and public.is_staff());

-- -----------------------------------------------------------------------------
-- 4. customers self policies: (select auth.uid()), same logic.
-- -----------------------------------------------------------------------------
alter policy customers_self_select on public.customers
  using (user_id = (select auth.uid()));

alter policy customers_self_update on public.customers
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter policy customers_self_insert on public.customers
  with check (user_id = (select auth.uid()));

commit;

-- -----------------------------------------------------------------------------
-- Verification — every column must be true.
-- -----------------------------------------------------------------------------
select
  not has_function_privilege('anon', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute')
                                                                                   as resolve_not_anon,
  has_function_privilege('authenticated', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute')
                                                                                   as resolve_authenticated,
  (select proconfig @> array['search_path=""'] from pg_proc
     where oid = 'public.normalize_customer_phone(text)'::regprocedure)            as normalize_search_path,
  not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                and policyname = 'public_media_read')                              as public_media_read_gone,
  exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'public_media_staff_read' and cmd = 'SELECT'
            and roles = '{authenticated}' and qual like '%is_staff()%')            as public_media_staff_read,
  -- Every auth.uid() in the three policies is inside a (SELECT …).
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'customers'
     and policyname in ('customers_self_select', 'customers_self_update', 'customers_self_insert')
     and coalesce(qual, '') || coalesce(with_check, '') like '%SELECT auth.uid()%'
     and replace(coalesce(qual, '') || coalesce(with_check, ''), 'SELECT auth.uid()', '') not like '%auth.uid()%') = 3
                                                                                   as customers_policies_wrapped;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0055 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use TEST-0055-* ids.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor  text := current_user;
  v_err     text;
  v_count   int;
  v_total   int;
  v_id      text;
  v_text    text;
  c_u1      constant text := '{"sub":"00000000-0000-4000-8000-0000000055a1","role":"authenticated"}';
  c_u3      constant text := '{"sub":"00000000-0000-4000-8000-0000000055a3","role":"authenticated"}';
  c_u4      constant text := '{"sub":"00000000-0000-4000-8000-0000000055a4","role":"authenticated"}';
  c_staff   constant text := '{"sub":"00000000-0000-4000-8000-0000000055c1","role":"authenticated"}';
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000055a1', 'authenticated', 'authenticated', now(), now()), -- U1: customer A
    ('00000000-0000-4000-8000-0000000055a2', 'authenticated', 'authenticated', now(), now()), -- U2: customer B
    ('00000000-0000-4000-8000-0000000055a3', 'authenticated', 'authenticated', now(), now()), -- U3: no record yet (insert)
    ('00000000-0000-4000-8000-0000000055a4', 'authenticated', 'authenticated', now(), now()), -- U4: no record yet (resolve)
    ('00000000-0000-4000-8000-0000000055c1', 'authenticated', 'authenticated', now(), now()); -- staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0055-A', '00000000-0000-4000-8000-0000000055a1', 'Customer A 0055', '+966500000551', '+966500000551', '500000551', true),
    ('TEST-0055-B', '00000000-0000-4000-8000-0000000055a2', 'Customer B 0055', '+966500000552', '+966500000552', '500000552', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status, role, permissions) VALUES
    ('TEST-0055-STAFF', '00000000-0000-4000-8000-0000000055c1', 'Staff 0055', true, 'Active', 'Admin', ARRAY['bookings']);

  -- ---------------------------------------------------------------------------
  -- 1. resolve_customer_record: anon refused, signed-in customers unchanged.
  -- ---------------------------------------------------------------------------
  ASSERT NOT has_function_privilege('anon', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute'),
    'Case 1a: anon must not execute resolve_customer_record';
  ASSERT has_function_privilege('authenticated', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute'),
    'Case 1b: authenticated must still execute resolve_customer_record';
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.resolve_customer_record('Probe', '+966500000551', null, null, 'Website Registration');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%permission denied%', format('Case 1c: an anon lookup by phone must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.resolve_customer_record('Junk', '+966500000559', null, null, 'Website Registration');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%permission denied%', format('Case 1d: an anon insert of a junk customer must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.customers WHERE normalized_phone = '500000559';
  ASSERT v_count = 0, format('Case 1e: no junk customer row may exist, found %s', v_count);

  -- A signed-in customer creating their own record still works (the live
  -- phone-sign-in / heal path).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_u4, true);
  v_id := public.resolve_customer_record('Customer D 0055', '+966500000554', null,
                                          '00000000-0000-4000-8000-0000000055a4', 'Website Registration');
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.customers
   WHERE id = v_id AND user_id = '00000000-0000-4000-8000-0000000055a4' AND normalized_phone = '500000554';
  ASSERT v_count = 1, format('Case 1f: a signed-in customer must still get their own attached record (got id %s)', coalesce(v_id, 'null'));

  -- ---------------------------------------------------------------------------
  -- 2. normalize_customer_phone: pinned search_path, same results.
  -- ---------------------------------------------------------------------------
  ASSERT (SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc
           WHERE oid = 'public.normalize_customer_phone(text)'::regprocedure),
    'Case 2a: normalize_customer_phone must have search_path=""';
  ASSERT public.normalize_customer_phone('+966 50 123 4567') = '501234567', 'Case 2b: +966 form';
  ASSERT public.normalize_customer_phone('00966501234567') = '501234567', 'Case 2c: 00966 form';
  ASSERT public.normalize_customer_phone('0501234567') = '501234567', 'Case 2d: leading 0';
  ASSERT public.normalize_customer_phone('(050) 123-4567') = '501234567', 'Case 2e: punctuation stripped';
  ASSERT public.normalize_customer_phone(NULL) = '' AND public.normalize_customer_phone('abc') = '', 'Case 2f: empty input -> empty string';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_u1, true);
  ASSERT public.normalize_customer_phone('+966500000551') = '500000551', 'Case 2g: works for an API caller too';
  PERFORM set_config('role', v_editor, true);

  -- ---------------------------------------------------------------------------
  -- 3. public-media: nobody but staff can list it.
  -- ---------------------------------------------------------------------------
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                      AND policyname = 'public_media_read'),
    'Case 3a: public_media_read must be gone';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                      AND cmd IN ('SELECT', 'ALL') AND qual LIKE '%public-media%'
                      AND (roles && ARRAY['public', 'anon']::name[] OR qual NOT LIKE '%is_staff()%')),
    'Case 3b: no SELECT policy may open public-media to everyone';
  SELECT count(*) INTO v_total FROM storage.objects WHERE bucket_id = 'public-media';

  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    SELECT count(*) INTO v_count FROM storage.objects WHERE bucket_id = 'public-media';
  EXCEPTION WHEN insufficient_privilege THEN v_count := 0;   -- no grant at all: also not listable
  END;
  ASSERT v_count = 0, format('Case 3c: anon must list nothing in public-media, saw %s of %s', v_count, v_total);

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_u1, true);
  SELECT count(*) INTO v_count FROM storage.objects WHERE bucket_id = 'public-media';
  ASSERT v_count = 0, format('Case 3d: a customer must list nothing in public-media, saw %s of %s', v_count, v_total);

  PERFORM set_config('request.jwt.claims', c_staff, true);
  SELECT count(*) INTO v_count FROM storage.objects WHERE bucket_id = 'public-media';
  ASSERT v_count = v_total, format('Case 3e: staff must still see every public-media object (needed by remove()), saw %s of %s', v_count, v_total);
  PERFORM set_config('role', v_editor, true);

  -- ---------------------------------------------------------------------------
  -- 4. customers self policies: wrapped, same behaviour.
  -- ---------------------------------------------------------------------------
  SELECT string_agg(coalesce(qual, '') || ' ' || coalesce(with_check, ''), ' | ') INTO v_text
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers'
     AND policyname IN ('customers_self_select', 'customers_self_update', 'customers_self_insert');
  ASSERT v_text LIKE '%SELECT auth.uid()%' AND replace(v_text, 'SELECT auth.uid()', '') NOT LIKE '%auth.uid()%',
    format('Case 4a: every auth.uid() must be wrapped in (select …): %s', v_text);
  ASSERT (SELECT roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_self_select') = '{authenticated}'
     AND (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_self_update') = 'UPDATE'
     AND (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_self_insert') = 'INSERT',
    'Case 4b: roles and commands unchanged';

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_u1, true);
  SELECT count(*) INTO v_count FROM public.customers WHERE id IN ('TEST-0055-A', 'TEST-0055-B');
  ASSERT v_count = 1, format('Case 4c: customer A must see only their own row, saw %s', v_count);
  SELECT count(*) INTO v_count FROM public.customers WHERE id = 'TEST-0055-A';
  ASSERT v_count = 1, 'Case 4d: customer A must see their own row';
  UPDATE public.customers SET name = 'Customer A renamed' WHERE id = 'TEST-0055-A';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 1, format('Case 4e: customer A must update their own row, %s rows', v_count);
  UPDATE public.customers SET name = 'Hijacked' WHERE id = 'TEST-0055-B';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 4f: customer A must not update B, %s rows', v_count);
  BEGIN
    UPDATE public.customers SET user_id = '00000000-0000-4000-8000-0000000055a2' WHERE id = 'TEST-0055-A';
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%row-level security%', format('Case 4g: giving their row to another user must be refused, got %s', coalesce(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_u3, true);
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account)
  VALUES ('TEST-0055-C', '00000000-0000-4000-8000-0000000055a3', 'Customer C 0055', '+966500000553', '+966500000553', '500000553', true);
  BEGIN
    INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account)
    VALUES ('TEST-0055-X', '00000000-0000-4000-8000-0000000055a2', 'Forged 0055', '+966500000558', '+966500000558', '500000558', true);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%row-level security%', format('Case 4h: inserting a row for another user must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.customers WHERE id = 'TEST-0055-C';
  ASSERT v_count = 1, 'Case 4i: a customer must still insert their own row';
  SELECT name INTO v_text FROM public.customers WHERE id = 'TEST-0055-B';
  ASSERT v_text = 'Customer B 0055', format('Case 4j: B must be unchanged, is %s', v_text);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0055 TESTS PASSED — rolled back';
END $$;
*/
