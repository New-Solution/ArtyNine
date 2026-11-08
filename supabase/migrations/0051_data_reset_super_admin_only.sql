-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 8 Nov 2026; every verification
-- column true and all manual tests passed.
-- =============================================================================
-- 0051 — DATA RESET IS SUPER ADMIN ONLY, ENFORCED IN THE DATABASE
--
-- Run after 0050_website_bookings_unpaid_when_payments_off.sql (applied).
--
-- THE PROBLEM
-- Settings → Data Reset ran nine `DELETE FROM <table> WHERE id IS NOT NULL`
-- statements from the browser, as the signed-in staff member. Since 8 Nov
-- the button is shown only to a Super Admin and needs "DELETE EVERYTHING"
-- typed — but that is the UI. The tables' RLS lets staff write (e.g.
-- bookings_staff_all), so ANY console account could wipe a table through
-- the API, with or without the button.
--
-- THE FIX
-- 1. public.reset_all_data(p_confirm text) — the ONLY way the app resets data
--    now. SECURITY DEFINER; refuses unless is_super_admin() AND p_confirm is
--    exactly 'DELETE EVERYTHING'. Deletes, in one transaction, the same nine
--    tables the button always deleted (piece_history, notifications, queue,
--    pieces, bookings, workshop_sessions, workshops, events, customers),
--    returns how many rows each lost, and leaves one staff notification
--    saying who ran it. Kept, as before: staff, studio configuration
--    (pipeline stages, packages, option lists, resources, settings), and the
--    payment evidence (booking_payments, moyasar_payment_events keep their
--    rows; booking_id is set to null by their foreign keys).
--    Executable by authenticated only (not anon).
-- 2. A guard on the core tables — bookings, customers, pieces, workshops,
--    workshop_sessions, events, queue: an AFTER DELETE statement trigger
--    refuses a delete from a website caller (anon / authenticated) that is
--    not a Super Admin, when ONE statement removes 2 or more rows AND leaves
--    the table empty. That is exactly the "delete everything" shape; normal
--    staff work (deleting one booking, a workshop's sessions, merging a
--    duplicate customer) never empties a table and is unaffected.
--    Super Admins, the service role and the SQL Editor are not affected.
--
-- WHAT IT DOES NOT DO
--   - It does not stop a staff account from deleting rows one at a time, or
--     all-but-one. Blocking that would mean taking DELETE away from staff on
--     each table, which the console needs today.
--   - notifications and piece_history are not guarded: staff can
--     legitimately empty them ("clear all staff notifications"; deleting a
--     piece cascades its history). They are still only wiped wholesale by a
--     Super Admin through reset_all_data.
--   - Edge case: if a table holds only rows that one legitimate action
--     removes together (e.g. the last workshop, whose sessions cascade), a
--     non–Super Admin gets the refusal; a Super Admin can do it.
--   - Customers' sign-in accounts (auth.users) are not deleted by a reset, as
--     before; a reset customer who signs in has no customer record.
--
-- WHAT THIS ADDS
--   reset_all_data(text)          SECURITY DEFINER, authenticated only
--   refuse_table_wipe()           trigger function (not callable by API roles)
--   trigger refuse_table_wipe     on the seven tables above
-- The front end (same commit) calls reset_all_data instead of deleting
-- tables, and no longer has any code that empties a table.
-- =============================================================================

-- Pre-flight.
do $$
begin
  if to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception '0051 aborted: is_super_admin() / is_staff() missing';
  end if;
  if to_regclass('public.piece_history') is null or to_regclass('public.notifications') is null
     or to_regclass('public.queue') is null or to_regclass('public.pieces') is null
     or to_regclass('public.bookings') is null or to_regclass('public.workshop_sessions') is null
     or to_regclass('public.workshops') is null or to_regclass('public.events') is null
     or to_regclass('public.customers') is null then
    raise exception '0051 aborted: an expected table is missing';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- reset_all_data — Settings → Data Reset.
-- -----------------------------------------------------------------------------
create or replace function public.reset_all_data(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
  v_who    text;
begin
  if not public.is_super_admin() then
    raise exception 'Only a Super Admin can reset all data.'
      using errcode = 'insufficient_privilege';
  end if;

  if btrim(coalesce(p_confirm, '')) <> 'DELETE EVERYTHING' then
    raise exception 'Type DELETE EVERYTHING to confirm the reset.'
      using errcode = 'check_violation';
  end if;

  -- Children before parents (every foreign key into these is cascade or
  -- set null, so the order only keeps the counts honest).
  delete from public.piece_history     where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('piece_history', v_n);
  delete from public.notifications     where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  delete from public.queue             where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('queue', v_n);
  delete from public.pieces            where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('pieces', v_n);
  delete from public.bookings          where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('bookings', v_n);
  delete from public.workshop_sessions where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('workshop_sessions', v_n);
  delete from public.workshops         where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('workshops', v_n);
  delete from public.events            where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('events', v_n);
  delete from public.customers         where true; get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('customers', v_n);

  -- Who did it, for whoever opens the console next.
  select s.name into v_who from public.staff s where s.user_id = auth.uid() limit 1;
  insert into public.notifications (id, type, title, message, "timestamp", is_read, highlighted)
  values (
    'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
             || '-' || floor(random() * 1000)::int::text || '-reset',
    'staff',
    'Data Reset',
    'All website data was deleted by ' || coalesce(v_who, 'a Super Admin') || ' (Settings → Data Reset). '
      || 'Rows removed: ' || v_counts::text,
    now(), false, true
  );

  return v_counts;
end;
$$;

revoke all on function public.reset_all_data(text) from public, anon;
grant execute on function public.reset_all_data(text) to authenticated;

-- -----------------------------------------------------------------------------
-- refuse_table_wipe — the guard. Statement-level, after the delete, so it sees
-- every deleted row (wiped_rows) and whether anything is left. SECURITY
-- DEFINER so "is anything left?" counts every row, not only those the
-- caller's RLS shows. current_setting('role') is the website caller even
-- inside SECURITY DEFINER functions (see 0048).
-- -----------------------------------------------------------------------------
create or replace function public.refuse_table_wipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
  v_left    boolean;
begin
  if coalesce(current_setting('role', true), '') not in ('anon', 'authenticated') then
    return null;
  end if;

  if public.is_super_admin() then
    return null;
  end if;

  select count(*) into v_deleted from wiped_rows;
  if v_deleted < 2 then
    return null;
  end if;

  execute format('select exists (select 1 from %I.%I)', tg_table_schema, tg_table_name) into v_left;
  if not v_left then
    raise exception 'Only a Super Admin can delete all % at once (Settings → Data Reset).', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;

  return null;
end;
$$;

revoke all on function public.refuse_table_wipe() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['bookings', 'customers', 'pieces', 'workshops', 'workshop_sessions', 'events', 'queue'] loop
    execute format('drop trigger if exists refuse_table_wipe on public.%I', t);
    execute format(
      'create trigger refuse_table_wipe after delete on public.%I '
      'referencing old table as wiped_rows for each statement '
      'execute function public.refuse_table_wipe()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  to_regprocedure('public.reset_all_data(text)') is not null as reset_fn,
  (select prosecdef from pg_proc where oid = 'public.reset_all_data(text)'::regprocedure) as reset_security_definer,
  has_function_privilege('authenticated', 'public.reset_all_data(text)', 'execute') as reset_authenticated,
  not has_function_privilege('anon', 'public.reset_all_data(text)', 'execute') as reset_not_anon,
  (select prosecdef from pg_proc where oid = 'public.refuse_table_wipe()'::regprocedure) as guard_security_definer,
  not has_function_privilege('authenticated', 'public.refuse_table_wipe()', 'execute') as guard_not_callable,
  (select count(*) from pg_trigger
    where tgname = 'refuse_table_wipe' and not tgisinternal and tgenabled = 'O'
      and tgrelid in ('public.bookings'::regclass, 'public.customers'::regclass, 'public.pieces'::regclass,
                      'public.workshops'::regclass, 'public.workshop_sessions'::regclass,
                      'public.events'::regclass, 'public.queue'::regclass)) = 7 as guard_on_7_tables,
  not exists (select 1 from pg_trigger where tgname = 'refuse_table_wipe'
               and tgrelid in ('public.notifications'::regclass, 'public.piece_history'::regclass)) as notifications_history_unguarded,
  exists (select 1 from pg_trigger where tgname = 'bookings_online_payment_guard'
            and tgrelid = 'public.bookings'::regclass and tgenabled = 'O') as payment_guard_kept;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0051 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Some cases delete whole tables (the last runs the real reset) INSIDE the
-- test's transaction; the final RAISE rolls all of it back. Run it at a quiet
-- time: the rows stay locked while the block runs.
-- Fixtures use dates in 2099 and TEST-0051-* ids.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor  text := current_user;
  v_err     text;
  v_count   int;
  v_staff   int;
  v_settings int;
  v_evidence int;
  v_result  jsonb;
  c_super   constant text := '{"sub":"00000000-0000-4000-8000-0000000051a1","role":"authenticated"}';
  c_staff   constant text := '{"sub":"00000000-0000-4000-8000-0000000051b1","role":"authenticated"}';
  c_cust    constant text := '{"sub":"00000000-0000-4000-8000-0000000051c1","role":"authenticated"}';
BEGIN
  -- NOTE: some cases below delete whole tables INSIDE this transaction (and the
  -- last one runs the real reset). Everything is rolled back by the final
  -- RAISE, pass or fail — but the rows are locked while the block runs, so run
  -- it at a quiet time.

  -- Fixtures, as the editor's own role. At least 2 rows in every table the
  -- staff "wipe" cases touch, so a wipe really is 2+ rows.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000051a1', 'authenticated', 'authenticated', now(), now()), -- SA: Super Admin
    ('00000000-0000-4000-8000-0000000051b1', 'authenticated', 'authenticated', now(), now()), -- ST: staff
    ('00000000-0000-4000-8000-0000000051c1', 'authenticated', 'authenticated', now(), now()); -- CU: customer
  INSERT INTO public.staff (id, user_id, name, has_console_access, status, role) VALUES
    ('TEST-0051-SA', '00000000-0000-4000-8000-0000000051a1', 'Super 0051', true, 'Active', 'Super Admin'),
    ('TEST-0051-ST', '00000000-0000-4000-8000-0000000051b1', 'Staff 0051', true, 'Active', 'Staff');
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0051-CU', '00000000-0000-4000-8000-0000000051c1', 'Customer 0051', '+966500000952', '+966500000952', '500000952', true);
  INSERT INTO public.workshops (id, title, price, pricing_type) VALUES
    ('TEST-0051-W1', 'Test 0051 workshop 1', 100, 'Per person'),
    ('TEST-0051-W2', 'Test 0051 workshop 2', 100, 'Per person');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0051-S1', 'TEST-0051-W1', '2099-08-01', '10:00', 10),
    ('TEST-0051-S2', 'TEST-0051-W1', '2099-08-02', '10:00', 10),
    ('TEST-0051-S3', 'TEST-0051-W2', '2099-08-03', '10:00', 10);
  INSERT INTO public.bookings (id, workshop_title, date, participants, status, payment_status) VALUES
    ('TEST-0051-B1', 'Test 0051', '2099-08-01', 1, 'Pending', 'Unpaid'),
    ('TEST-0051-B2', 'Test 0051', '2099-08-01', 1, 'Pending', 'Unpaid'),
    ('TEST-0051-B3', 'Test 0051', '2099-08-01', 1, 'Pending', 'Unpaid');
  INSERT INTO public.events (id, title) VALUES ('TEST-0051-E1', 'Test 0051 event 1'), ('TEST-0051-E2', 'Test 0051 event 2');
  INSERT INTO public.queue (id, name, date) VALUES ('TEST-0051-Q1', 'Test 0051 a', '2099-08-01'), ('TEST-0051-Q2', 'Test 0051 b', '2099-08-01');
  INSERT INTO public.notifications (id, type, title, message, "timestamp", is_read, highlighted) VALUES
    ('TEST-0051-N1', 'staff', 'Test 0051', 'x', now(), false, false),
    ('TEST-0051-N2', 'staff', 'Test 0051', 'y', now(), false, false);

  -- 1. reset_all_data: refused for staff, a customer and a guest.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  BEGIN
    PERFORM public.reset_all_data('DELETE EVERYTHING');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can reset all data%', format('Case 1a: staff reset must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM public.reset_all_data('DELETE EVERYTHING');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can reset all data%', format('Case 1b: customer reset must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.reset_all_data('DELETE EVERYTHING');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;   -- permission denied (no grant) or the super-admin check
  END;
  ASSERT v_err IS NOT NULL, 'Case 1c: a guest reset must be refused';
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id LIKE 'TEST-0051-B%';
  ASSERT v_count = 3, format('Case 1: nothing may be deleted, fixture bookings left %s of 3', v_count);

  -- 2. Super Admin with the wrong phrase: refused.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_super, true);
  BEGIN
    PERFORM public.reset_all_data('delete everything');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Type DELETE EVERYTHING%', format('Case 2a: wrong phrase must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.reset_all_data(NULL);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Type DELETE EVERYTHING%', format('Case 2b: no phrase must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);

  -- 3. A staff member wiping a guarded table directly: refused, nothing lost.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  BEGIN
    DELETE FROM public.bookings WHERE id IS NOT NULL;   -- what the old button sent
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can delete all bookings%', format('Case 3a: staff bookings wipe must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    DELETE FROM public.workshop_sessions WHERE true;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can delete all workshop_sessions%', format('Case 3b: staff sessions wipe must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    DELETE FROM public.workshops WHERE true;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can delete all%', format('Case 3c: staff workshops wipe must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    DELETE FROM public.events WHERE true;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can delete all events%', format('Case 3d: staff events wipe must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    DELETE FROM public.queue WHERE true;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%Only a Super Admin can delete all queue%', format('Case 3e: staff queue wipe must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT (SELECT count(*) FROM public.bookings WHERE id LIKE 'TEST-0051-B%')
       + (SELECT count(*) FROM public.workshop_sessions WHERE id LIKE 'TEST-0051-S%')
       + (SELECT count(*) FROM public.workshops WHERE id LIKE 'TEST-0051-W%')
       + (SELECT count(*) FROM public.events WHERE id LIKE 'TEST-0051-E%')
       + (SELECT count(*) FROM public.queue WHERE id LIKE 'TEST-0051-Q%') INTO v_count;
  ASSERT v_count = 12, format('Case 3: refused wipes must delete nothing, fixtures left %s of 12', v_count);

  -- 4. Normal staff work still works: one row, and several that leave others.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  DELETE FROM public.bookings WHERE id = 'TEST-0051-B1';
  DELETE FROM public.workshop_sessions WHERE id IN ('TEST-0051-S1', 'TEST-0051-S2');   -- S3 (and any real sessions) remain
  DELETE FROM public.events WHERE id = 'TEST-0051-E1';
  -- "Clear all staff notifications": notifications are not guarded.
  DELETE FROM public.notifications WHERE type = 'staff';
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id = 'TEST-0051-B1';
  ASSERT v_count = 0, 'Case 4a: a single booking delete must work';
  SELECT count(*) INTO v_count FROM public.workshop_sessions WHERE id IN ('TEST-0051-S1', 'TEST-0051-S2');
  ASSERT v_count = 0, 'Case 4b: deleting some sessions (not all) must work';
  SELECT count(*) INTO v_count FROM public.notifications WHERE id LIKE 'TEST-0051-N%';
  ASSERT v_count = 0, 'Case 4c: clearing staff notifications must work';

  -- 5. A Super Admin may wipe a guarded table directly.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_super, true);
  DELETE FROM public.queue WHERE true;
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.queue;
  ASSERT v_count = 0, format('Case 5: a Super Admin queue wipe must work, %s rows left', v_count);

  -- 6. The SQL Editor and the service role are not website callers: allowed.
  DELETE FROM public.events WHERE true;
  SELECT count(*) INTO v_count FROM public.events;
  ASSERT v_count = 0, format('Case 6a: an editor events wipe must work, %s rows left', v_count);
  INSERT INTO public.events (id, title) VALUES ('TEST-0051-E3', 'a'), ('TEST-0051-E4', 'b');
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  DELETE FROM public.events WHERE true;
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.events;
  ASSERT v_count = 0, format('Case 6b: a service-role events wipe must work, %s rows left', v_count);

  -- 7. The real reset, by a Super Admin with the phrase.
  SELECT count(*) INTO v_staff FROM public.staff;
  SELECT count(*) INTO v_settings FROM public.app_settings;
  SELECT (SELECT count(*) FROM public.booking_payments) + (SELECT count(*) FROM public.moyasar_payment_events) INTO v_evidence;
  INSERT INTO public.events (id, title) VALUES ('TEST-0051-E5', 'c');
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_super, true);
  v_result := public.reset_all_data('  DELETE EVERYTHING  ');   -- surrounding spaces allowed, as in the UI
  PERFORM set_config('role', v_editor, true);
  ASSERT v_result ?& array['piece_history','notifications','queue','pieces','bookings','workshop_sessions','workshops','events','customers'],
    format('Case 7a: expected a count for each of the nine tables, got %s', v_result);
  SELECT (SELECT count(*) FROM public.piece_history) + (SELECT count(*) FROM public.queue)
       + (SELECT count(*) FROM public.pieces)        + (SELECT count(*) FROM public.bookings)
       + (SELECT count(*) FROM public.workshop_sessions) + (SELECT count(*) FROM public.workshops)
       + (SELECT count(*) FROM public.events)        + (SELECT count(*) FROM public.customers) INTO v_count;
  ASSERT v_count = 0, format('Case 7b: all reset tables must be empty, %s rows left', v_count);
  SELECT count(*) INTO v_count FROM public.notifications;
  ASSERT v_count = 1, format('Case 7c: only the audit notification may remain, found %s', v_count);
  SELECT count(*) INTO v_count FROM public.notifications WHERE type = 'staff' AND title = 'Data Reset' AND message LIKE '%Super 0051%';
  ASSERT v_count = 1, 'Case 7c: the audit notification must name who ran the reset';
  SELECT count(*) INTO v_count FROM public.staff;
  ASSERT v_count = v_staff, format('Case 7d: staff must be kept (%s before, %s after)', v_staff, v_count);
  SELECT count(*) INTO v_count FROM public.app_settings;
  ASSERT v_count = v_settings, format('Case 7d: settings must be kept (%s before, %s after)', v_settings, v_count);
  SELECT (SELECT count(*) FROM public.booking_payments) + (SELECT count(*) FROM public.moyasar_payment_events) INTO v_count;
  ASSERT v_count = v_evidence, format('Case 7e: payment evidence must be kept (%s before, %s after)', v_evidence, v_count);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0051 TESTS PASSED — rolled back';
END $$;
*/
