-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 9 Nov 2026, after the
-- settings-fixes front end was live on main (dbb7552); every verification
-- column true and all manual tests passed.
-- =============================================================================
-- 0053 — WHO MAY CHANGE app_settings
--
-- Run after 0052_retire_customer_signin_email.sql (applied).
--
-- THE PROBLEM
-- 0001 gave app_settings one write policy, app_settings_staff_write:
-- FOR ALL to authenticated using/with check (is_staff()). So ANY console
-- account could change ANY setting through the API — including
-- 'onlinePayments', which switches online payment on and off and sets the
-- deposit and hold time the database charges (online_payments_config(),
-- 0046). The Settings page is gated per page in the app, but the database
-- did not care.
--
-- THE FIX
-- public.can_write_app_setting(p_key text) decides, from the caller's own
-- JWT (auth.uid()) and their staff row:
--   'onlinePayments'  -> Super Admin only
--   any other key     -> Super Admin, or active console staff whose
--                        permissions include the 'settings' page (the same
--                        rule as canAccessPage() in src/utils/adminAccess.ts)
-- app_settings_staff_write is replaced by three policies (insert, update,
-- delete) that all use it. For UPDATE it is checked on the old row (USING)
-- and the new row (WITH CHECK), so a row cannot be renamed into or out of
-- 'onlinePayments' either.
--
-- UNCHANGED
--   app_settings_public_read: everyone (anon included) still reads every
--     setting — the customer site needs them.
--   SECURITY DEFINER functions (online_payments_config() and friends) and the
--     service role / SQL Editor are not subject to RLS.
--
-- WHAT THE APP SEES
-- A refused UPDATE or DELETE matches no rows (RLS filters it); the app's
-- writes are upserts (db.appSettings.put), and a refused upsert raises
-- "new row violates row-level security policy", which the Settings page now
-- shows as an error. The front end hides the Online Payments card from
-- non–Super Admins (branch settings-fixes, merged to main in dbb7552).
--
-- ROLLBACK
--   drop policy if exists app_settings_insert on public.app_settings;
--   drop policy if exists app_settings_update on public.app_settings;
--   drop policy if exists app_settings_delete on public.app_settings;
--   create policy app_settings_staff_write on public.app_settings
--     for all to authenticated using (public.is_staff()) with check (public.is_staff());
--   drop function if exists public.can_write_app_setting(text);
-- =============================================================================

-- Pre-flight.
do $$
begin
  if to_regprocedure('public.is_staff()') is null or to_regprocedure('public.is_super_admin()') is null then
    raise exception '0053 aborted: is_staff() / is_super_admin() missing';
  end if;
  if to_regclass('public.app_settings') is null then
    raise exception '0053 aborted: public.app_settings missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings'
                   and policyname = 'app_settings_public_read') then
    raise exception '0053 aborted: app_settings_public_read is missing — compare the live policies first';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- The rule, in one place.
-- -----------------------------------------------------------------------------
create or replace function public.can_write_app_setting(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_key is null then false
    when p_key = 'onlinePayments' then public.is_super_admin()
    else public.is_super_admin() or exists (
      select 1 from public.staff s
       where s.user_id = auth.uid()
         and s.has_console_access = true
         and s.status not in ('Inactive', 'Former Staff')
         and 'settings' = any (s.permissions)
    )
  end;
$$;

revoke all on function public.can_write_app_setting(text) from public, anon;
grant execute on function public.can_write_app_setting(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Policies. The public read policy is left exactly as 0001 made it.
-- -----------------------------------------------------------------------------
drop policy if exists app_settings_staff_write on public.app_settings;

drop policy if exists app_settings_insert on public.app_settings;
create policy app_settings_insert on public.app_settings
  for insert to authenticated
  with check (public.can_write_app_setting(id));

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.can_write_app_setting(id))
  with check (public.can_write_app_setting(id));

drop policy if exists app_settings_delete on public.app_settings;
create policy app_settings_delete on public.app_settings
  for delete to authenticated
  using (public.can_write_app_setting(id));

-- Verification — every column must be true.
select
  to_regprocedure('public.can_write_app_setting(text)') is not null                    as rule_fn,
  (select prosecdef from pg_proc where oid = 'public.can_write_app_setting(text)'::regprocedure)
                                                                                        as rule_security_definer,
  not has_function_privilege('anon', 'public.can_write_app_setting(text)', 'execute')  as rule_not_anon,
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings'
                and policyname = 'app_settings_staff_write')                            as old_write_policy_gone,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'app_settings'
     and policyname in ('app_settings_insert', 'app_settings_update', 'app_settings_delete')) = 3
                                                                                        as three_write_policies,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings'
            and policyname = 'app_settings_public_read' and cmd = 'SELECT')             as public_read_kept,
  (select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass)     as rls_on;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0053 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use TEST-0053-* ids. The Super Admin case changes the real
-- onlinePayments row INSIDE the test's transaction; the final RAISE rolls it
-- back.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor  text := current_user;
  v_err     text;
  v_count   int;
  v_value   jsonb;
  v_before  jsonb;
  c_super   constant text := '{"sub":"00000000-0000-4000-8000-0000000053a1","role":"authenticated"}';
  c_setts   constant text := '{"sub":"00000000-0000-4000-8000-0000000053b1","role":"authenticated"}';
  c_staff   constant text := '{"sub":"00000000-0000-4000-8000-0000000053b2","role":"authenticated"}';
  c_cust    constant text := '{"sub":"00000000-0000-4000-8000-0000000053c1","role":"authenticated"}';
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000053a1', 'authenticated', 'authenticated', now(), now()), -- Super Admin
    ('00000000-0000-4000-8000-0000000053b1', 'authenticated', 'authenticated', now(), now()), -- staff WITH Settings
    ('00000000-0000-4000-8000-0000000053b2', 'authenticated', 'authenticated', now(), now()), -- staff WITHOUT Settings
    ('00000000-0000-4000-8000-0000000053c1', 'authenticated', 'authenticated', now(), now()); -- customer
  INSERT INTO public.staff (id, user_id, name, has_console_access, status, role, permissions) VALUES
    ('TEST-0053-SA', '00000000-0000-4000-8000-0000000053a1', 'Super 0053',    true, 'Active', 'Super Admin', '{}'),
    ('TEST-0053-ST', '00000000-0000-4000-8000-0000000053b1', 'Settings 0053', true, 'Active', 'Admin', ARRAY['settings','dashboard']),
    ('TEST-0053-NS', '00000000-0000-4000-8000-0000000053b2', 'NoSettings 0053', true, 'Active', 'Admin', ARRAY['dashboard','queue']);
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0053-CU', '00000000-0000-4000-8000-0000000053c1', 'Customer 0053', '+966500000953', '+966500000953', '500000953', true);
  INSERT INTO public.app_settings (id, value) VALUES ('TEST-0053-key', '{"n":1}'::jsonb);
  -- onlinePayments is seeded by 0046; make sure it exists for these cases.
  INSERT INTO public.app_settings (id, value)
       VALUES ('onlinePayments', '{"enabled": false, "holdMinutes": 15, "workshop": {"mode": "deposit", "depositAmount": 100}, "birthday": {"mode": "full"}}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
  SELECT value INTO v_before FROM public.app_settings WHERE id = 'onlinePayments';

  -- 1. Reads still work for everyone.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO v_count FROM public.app_settings WHERE id IN ('onlinePayments', 'TEST-0053-key');
  ASSERT v_count = 2, format('Case 1a: anon must read settings, saw %s of 2', v_count);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT count(*) INTO v_count FROM public.app_settings WHERE id IN ('onlinePayments', 'TEST-0053-key');
  ASSERT v_count = 2, format('Case 1b: a customer must read settings, saw %s of 2', v_count);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  SELECT count(*) INTO v_count FROM public.app_settings WHERE id IN ('onlinePayments', 'TEST-0053-key');
  ASSERT v_count = 2, format('Case 1c: staff without Settings must read settings, saw %s of 2', v_count);
  PERFORM set_config('role', v_editor, true);

  -- 2. Staff WITH Settings (not Super Admin) cannot change onlinePayments.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_setts, true);
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 2a: settings staff updated onlinePayments (%s rows)', v_count);
  BEGIN
    -- What the app sends: an upsert.
    INSERT INTO public.app_settings (id, value) VALUES ('onlinePayments', '{"enabled": true}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET value = excluded.value;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%row-level security%', format('Case 2b: settings staff upsert of onlinePayments must be refused, got %s', coalesce(v_err, 'no error'));
  DELETE FROM public.app_settings WHERE id = 'onlinePayments';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 2c: settings staff deleted onlinePayments (%s rows)', v_count);
  -- Renaming another row INTO onlinePayments is refused too (WITH CHECK).
  BEGIN
    UPDATE public.app_settings SET id = 'onlinePayments' WHERE id = 'TEST-0053-key';
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 2d: renaming a row into onlinePayments must be refused';
  PERFORM set_config('role', v_editor, true);
  SELECT value INTO v_value FROM public.app_settings WHERE id = 'onlinePayments';
  ASSERT v_value = v_before, 'Case 2: onlinePayments must be unchanged after the refused writes';

  -- 3. Staff WITH Settings can write other keys.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_setts, true);
  UPDATE public.app_settings SET value = '{"n":2}'::jsonb WHERE id = 'TEST-0053-key';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 1, format('Case 3a: settings staff must update another key, %s rows', v_count);
  INSERT INTO public.app_settings (id, value) VALUES ('TEST-0053-new', '{"n":1}'::jsonb)
  ON CONFLICT (id) DO UPDATE SET value = excluded.value;
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.app_settings WHERE id = 'TEST-0053-new';
  ASSERT v_count = 1, 'Case 3b: settings staff must insert a new key';

  -- 4. Staff WITHOUT Settings cannot write any key.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  UPDATE public.app_settings SET value = '{"n":99}'::jsonb WHERE id = 'TEST-0053-key';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 4a: staff without Settings updated a key (%s rows)', v_count);
  BEGIN
    INSERT INTO public.app_settings (id, value) VALUES ('TEST-0053-ns', '{}'::jsonb);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%row-level security%', format('Case 4b: staff without Settings insert must be refused, got %s', coalesce(v_err, 'no error'));
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 4c: staff without Settings updated onlinePayments (%s rows)', v_count);
  DELETE FROM public.app_settings WHERE id = 'TEST-0053-key';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 4d: staff without Settings deleted a key (%s rows)', v_count);
  PERFORM set_config('role', v_editor, true);
  SELECT value INTO v_value FROM public.app_settings WHERE id = 'TEST-0053-key';
  ASSERT v_value = '{"n":2}'::jsonb, format('Case 4: TEST-0053-key must still be {"n":2}, is %s', v_value);

  -- 5. Customers and guests cannot write anything.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  UPDATE public.app_settings SET value = '{"n":5}'::jsonb WHERE id = 'TEST-0053-key';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 0, format('Case 5a: a customer updated a key (%s rows)', v_count);
  BEGIN
    INSERT INTO public.app_settings (id, value) VALUES ('TEST-0053-cu', '{}'::jsonb);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%row-level security%', format('Case 5b: a customer insert must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    UPDATE public.app_settings SET value = '{"n":6}'::jsonb WHERE id = 'TEST-0053-key';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_count := 0;  -- no grant, or no policy: either way refused
  END;
  ASSERT v_count = 0, format('Case 5c: a guest updated a key (%s rows)', v_count);
  BEGIN
    INSERT INTO public.app_settings (id, value) VALUES ('TEST-0053-anon', '{}'::jsonb);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 5d: a guest insert must be refused';
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.app_settings WHERE id IN ('TEST-0053-cu', 'TEST-0053-anon', 'TEST-0053-ns');
  ASSERT v_count = 0, format('Case 5: refused inserts must leave no rows, found %s', v_count);

  -- 6. A Super Admin can change onlinePayments (and any other key).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_super, true);
  UPDATE public.app_settings SET value = jsonb_set(value, '{holdMinutes}', '20') WHERE id = 'onlinePayments';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 1, format('Case 6a: Super Admin must update onlinePayments, %s rows', v_count);
  INSERT INTO public.app_settings (id, value) VALUES ('onlinePayments', v_before)
  ON CONFLICT (id) DO UPDATE SET value = excluded.value;   -- the app's upsert
  UPDATE public.app_settings SET value = '{"n":3}'::jsonb WHERE id = 'TEST-0053-key';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  ASSERT v_count = 1, format('Case 6b: Super Admin must update other keys, %s rows', v_count);
  PERFORM set_config('role', v_editor, true);
  SELECT value INTO v_value FROM public.app_settings WHERE id = 'onlinePayments';
  ASSERT v_value = v_before, 'Case 6c: the Super Admin upsert must have written onlinePayments';

  -- 7. The rule function directly.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_setts, true);
  ASSERT NOT public.can_write_app_setting('onlinePayments'), 'Case 7a: settings staff must not be allowed onlinePayments';
  ASSERT public.can_write_app_setting('eventsSettings'), 'Case 7b: settings staff must be allowed eventsSettings';
  ASSERT NOT public.can_write_app_setting(NULL), 'Case 7c: a null key must be refused';
  PERFORM set_config('request.jwt.claims', c_super, true);
  ASSERT public.can_write_app_setting('onlinePayments'), 'Case 7d: Super Admin must be allowed onlinePayments';
  PERFORM set_config('role', v_editor, true);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0053 TESTS PASSED — rolled back';
END $$;
*/
