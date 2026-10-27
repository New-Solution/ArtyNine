-- STATUS: APPLIED
-- =============================================================================
-- 0044 — SIGNED-IN CUSTOMERS' BOOKINGS ALWAYS USE THEIR OWN RECORD
--
-- Run after 0042_no_empty_customer_insert.sql. Independent of 0043, which may
-- still be unapplied.
--
-- THE PROBLEM
-- book_session_seats() and book_birthday_slot() insert whatever customer_id the
-- browser puts in p_booking. For a signed-in customer the browser used to get
-- it from resolveCustomer() by the phone number typed at checkout, so a booking
-- made with someone else's number landed on THAT person's record and showed in
-- their My Bookings (bookings RLS matches on customer_id).
--
-- THE FIX
-- When the caller is a signed-in NON-staff user (auth.uid() is not null and
-- not public.is_staff()), the passed customer_id is ignored and replaced with
-- public.current_customer_id() — the record whose user_id is the caller. If the
-- caller has no record, the booking is refused with a clear error.
--   - Staff (is_staff()) keep today's behaviour: they book for any customer.
--   - Signed-out guests (auth.uid() is null) keep today's behaviour: the record
--     comes from resolve_customer_record() by phone/email, as before.
-- The booking's customer_name / customer_email / customer_phone are NOT
-- changed — someone may book for a friend under their own account; only which
-- record it is filed under is fixed.
--
-- WHAT CHANGED vs THE LIVE DEFINITION
-- Each function below is copied verbatim from
-- 0029_booking_rpc_defaults_and_session_guard.sql (the latest definition of
-- both; nothing after 0029 redefines them) with exactly two additions: one
-- declared variable (v_own_customer) and the guard block marked "0044", placed
-- right after the defaults merge so every later step (idempotency lookup,
-- capacity/slot checks, insert) sees the corrected payload.
-- Same signatures. `create or replace` keeps the existing ACL
-- ({postgres, anon, authenticated, service_role}, per 0029) — no grant/revoke
-- here; the verification query at the end checks it.
--
-- The pre-flight block refuses to run unless the live functions contain 0029's
-- text, so this cannot silently overwrite a different version.
--
-- DEPLOY ORDER — deploy the app change "fix(booking): signed-in customers book
-- on their own record" first. Applying this before it is still correct for a
-- normally signed-in customer (the database replaces the id either way); the
-- one difference is a signed-in session with no linked customer record, which
-- today quietly books on the record matched by phone and would be refused.
-- =============================================================================

-- Pre-flight: the expected functions exist and the booking functions are the
-- 0029 version (or this file, re-run). Anything else: stop and compare first.
do $$
begin
  if to_regprocedure('public.book_session_seats(jsonb,text)') is null
     or to_regprocedure('public.book_birthday_slot(jsonb,boolean)') is null
     or to_regprocedure('public.current_customer_id()') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception '0044 aborted: an expected function is missing';
  end if;

  if pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
       not like '%not linked to a workshop session, so its seats cannot be checked%'
     or pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%A birthday booking cannot be linked to a workshop session%' then
    raise exception '0044 aborted: the live booking functions are not the 0029 version — compare them before applying';
  end if;
end $$;

create or replace function public.book_session_seats(
  p_booking  jsonb,
  p_session_id text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity   integer;
  v_taken      integer;
  v_wanted     integer;
  v_booking_id text;
  v_session_id text;
  v_own_customer text;
begin
  -- DUPLICATED FROM 0001_init.sql. These are the defaults declared on
  -- public.bookings, restated because jsonb_populate_record cannot see them.
  -- If a default changes in the table it must change here too, in both
  -- functions, or the two disagree silently.
  p_booking := jsonb_build_object(
    'participants',   1,
    'total_price',    0,
    'source',         'Website',
    'status',         'Pending',
    'payment_status', 'Unpaid',
    'timeline',       '[]'::jsonb,
    'created_at',     now()
  ) || coalesce(p_booking, '{}'::jsonb);

  -- 0044 — a signed-in customer always books on their own record. The
  -- customer_id in the payload is only the browser's guess (it used to come from
  -- the phone number typed at checkout, which may be someone else's) and is
  -- ignored for them. Staff (is_staff()) and signed-out guests (auth.uid() is
  -- null) are unchanged.
  if auth.uid() is not null and not public.is_staff() then
    v_own_customer := public.current_customer_id();
    if v_own_customer is null then
      raise exception 'Your account is not linked to a customer record, so this booking cannot be saved. Please sign out and back in, or contact the studio.';
    end if;
    p_booking := p_booking || jsonb_build_object('customer_id', v_own_customer);
  end if;

  v_wanted     := coalesce((p_booking->>'participants')::integer, 1);
  v_booking_id := p_booking->>'id';

  if v_wanted < 1 then
    raise exception 'A booking needs at least one participant';
  end if;

  -- The session may arrive as the parameter or inside the payload. Resolving
  -- both means the capacity check cannot be skipped by omitting the parameter.
  v_session_id := coalesce(p_session_id, p_booking->>'session_id');

  if v_session_id is null then
    raise exception 'This booking is not linked to a workshop session, so its seats cannot be checked'
      using errcode = 'check_violation';
  end if;

  -- Already written by an earlier attempt whose reply never arrived. Nothing to
  -- do, and reporting success is accurate: the booking exists. Checked before
  -- the capacity rule because a booking already on the table is already counted
  -- by session_seats_taken, so testing capacity first would count it against
  -- itself and refuse the retry as an overbooking.
  if v_booking_id is not null
     and exists (select 1 from public.bookings where id = v_booking_id) then
    return v_booking_id;
  end if;

  -- Unconditional from here down. Lock the session for the rest of this
  -- transaction, so two callers taking the last seat serialise.
  select s.capacity into v_capacity
    from public.workshop_sessions s
   where s.id = v_session_id
     for update;

  if v_capacity is null then
    raise exception 'That session is no longer available';
  end if;

  v_taken := public.session_seats_taken(v_session_id);

  if v_taken + v_wanted > v_capacity then
    raise exception 'Only % seat(s) left on this session', greatest(0, v_capacity - v_taken)
      using errcode = 'check_violation';
  end if;

  insert into public.bookings
  select * from jsonb_populate_record(null::public.bookings, p_booking);

  return v_booking_id;
end;
$$;


create or replace function public.book_birthday_slot(
  p_booking        jsonb,
  p_allow_override boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Kept in step with BIRTHDAY_DAILY_MAX / BIRTHDAY_SAME_SLOT_MAX in
  -- src/utils/queueUtils.ts.
  c_daily_max     constant integer := 5;
  c_slot_max      constant integer := 2;

  v_booking_id    text;
  v_date          date;
  v_time          text;
  v_override      boolean;
  v_on_date       integer;
  v_at_slot       integer;
  v_own_customer  text;
begin
  -- DUPLICATED FROM 0001_init.sql — see the note in book_session_seats above.
  -- Change both functions together.
  p_booking := jsonb_build_object(
    'participants',   1,
    'total_price',    0,
    'source',         'Website',
    'status',         'Pending',
    'payment_status', 'Unpaid',
    'timeline',       '[]'::jsonb,
    'created_at',     now()
  ) || coalesce(p_booking, '{}'::jsonb);

  -- 0044 — a signed-in customer always books on their own record. The
  -- customer_id in the payload is only the browser's guess (it used to come from
  -- the phone number typed at checkout, which may be someone else's) and is
  -- ignored for them. Staff (is_staff()) and signed-out guests (auth.uid() is
  -- null) are unchanged.
  if auth.uid() is not null and not public.is_staff() then
    v_own_customer := public.current_customer_id();
    if v_own_customer is null then
      raise exception 'Your account is not linked to a customer record, so this booking cannot be saved. Please sign out and back in, or contact the studio.';
    end if;
    p_booking := p_booking || jsonb_build_object('customer_id', v_own_customer);
  end if;

  v_booking_id := p_booking->>'id';
  v_date       := (p_booking->>'date')::date;
  v_time       := coalesce(p_booking->>'time', '');
  v_override   := coalesce(p_allow_override, false) and public.is_staff();

  if v_date is null then
    raise exception 'A birthday booking needs a date';
  end if;

  -- A birthday party has no workshop session. A payload carrying one would
  -- consume seats on that session — session_seats_taken counts by session_id
  -- and does not filter on workshop_id — through a function that checks only
  -- dates and slots. There is no case where honouring it is correct.
  if p_booking->>'session_id' is not null then
    raise exception 'A birthday booking cannot be linked to a workshop session'
      using errcode = 'check_violation';
  end if;

  -- Same as above: an id already on the table is a reply that went missing, not
  -- a second party.
  if v_booking_id is not null
     and exists (select 1 from public.bookings where id = v_booking_id) then
    return v_booking_id;
  end if;

  -- Serialise every booking for this date for the rest of the transaction.
  perform pg_advisory_xact_lock(hashtext('birthday_slot:' || v_date::text));

  if not v_override then
    select
      count(*),
      count(*) filter (where coalesce(b.time, '') = v_time)
      into v_on_date, v_at_slot
    from public.bookings b
    where b.date = v_date
      and (
        b.workshop_id = 'birthday-party-event'
        or coalesce(b.workshop_title, '') ilike '%birthday%'
      )
      and lower(coalesce(b.status, '')) not in ('cancelled','auto-cancelled','draft','no show','no-show')
      and lower(coalesce(b.payment_status, '')) not in ('failed','payment failed','declined','draft')
      and (v_booking_id is null or b.id <> v_booking_id);

    if v_on_date >= c_daily_max then
      raise exception 'That date is fully booked for birthday celebrations'
        using errcode = 'check_violation';
    end if;

    if v_at_slot >= c_slot_max then
      raise exception 'That time slot is fully booked for birthday celebrations'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into public.bookings
  select * from jsonb_populate_record(null::public.bookings, p_booking);

  return v_booking_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%current_customer_id()%' as seats_guarded,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%current_customer_id()%' as birthday_guarded,
  has_function_privilege('anon',          'public.book_session_seats(jsonb,text)',    'execute') as seats_anon,
  has_function_privilege('authenticated', 'public.book_session_seats(jsonb,text)',    'execute') as seats_authenticated,
  has_function_privilege('anon',          'public.book_birthday_slot(jsonb,boolean)', 'execute') as birthday_anon,
  has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute') as birthday_authenticated;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0044 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0044-* ids, so they cannot collide with
-- real bookings, and are rolled back with everything else.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_id     text;
  v_cust   text;
  v_count  int;
  v_err    text;
  v_has    boolean;
  -- A workshop booking and a birthday booking, both claiming record B.
  v_seats  jsonb := jsonb_build_object(
    'customer_id', 'TEST-0044-B', 'customer_name', 'Booked for B', 'customer_phone', '+966500000942',
    'workshop_id', 'TEST-0044-W', 'session_id', 'TEST-0044-S', 'workshop_title', 'Test 0044 workshop',
    'date', '2099-01-01', 'time', '10:00', 'participants', 1);
  v_bday   jsonb := jsonb_build_object(
    'customer_id', 'TEST-0044-B', 'customer_name', 'Booked for B', 'customer_phone', '+966500000942',
    'workshop_id', 'birthday-party-event', 'workshop_title', 'Birthday Party',
    'date', '2099-01-02', 'time', '4:00 PM', 'participants', 10);
BEGIN
  -- Fixtures, as the editor's own role (no JWT, so auth.uid() is null).
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000044a1', 'authenticated', 'authenticated', now(), now()), -- A: customer with a record
    ('00000000-0000-4000-8000-0000000044b1', 'authenticated', 'authenticated', now(), now()), -- N: signed in, no customer record
    ('00000000-0000-4000-8000-0000000044c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0044-A', '00000000-0000-4000-8000-0000000044a1', 'Customer A', '+966500000941', '+966500000941', '500000941', true),
    ('TEST-0044-B', NULL, 'Someone Else B', '+966500000942', '+966500000942', '500000942', false);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0044-STAFF', '00000000-0000-4000-8000-0000000044c1', 'Staff 0044', true, 'Active');
  INSERT INTO public.workshops (id, title) VALUES ('TEST-0044-W', 'Test 0044 workshop');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0044-S', 'TEST-0044-W', '2099-01-01', '10:00', 20);

  -- 1. Signed-in customer A, payload claims B -> filed under A (both functions).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000044a1","role":"authenticated"}', true);
  PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0044-1"}', 'TEST-0044-S');
  PERFORM public.book_birthday_slot(v_bday  || '{"id":"TEST-0044-2"}');
  -- 2. ...and with no customer_id at all -> A.
  PERFORM public.book_session_seats((v_seats - 'customer_id') || '{"id":"TEST-0044-3"}', 'TEST-0044-S');
  -- 3. A retry of booking 1 still returns its id and writes nothing new (0028 idempotency kept).
  v_id := public.book_session_seats(v_seats || '{"id":"TEST-0044-1"}', 'TEST-0044-S');
  ASSERT v_id = 'TEST-0044-1', format('Case 3 retry: expected TEST-0044-1, got %s', v_id);
  -- 4. 0029's session guard is still there.
  BEGIN
    PERFORM public.book_session_seats((v_seats - 'session_id') || '{"id":"TEST-0044-4"}', NULL);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%not linked to a workshop session%', format('Case 4 session guard: expected the 0029 refusal, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);

  SELECT customer_id INTO v_cust FROM public.bookings WHERE id = 'TEST-0044-1';
  ASSERT v_cust = 'TEST-0044-A', format('Case 1 workshop: expected TEST-0044-A, got %s', v_cust);
  SELECT customer_id INTO v_cust FROM public.bookings WHERE id = 'TEST-0044-2';
  ASSERT v_cust = 'TEST-0044-A', format('Case 1 birthday: expected TEST-0044-A, got %s', v_cust);
  SELECT customer_id INTO v_cust FROM public.bookings WHERE id = 'TEST-0044-3';
  ASSERT v_cust = 'TEST-0044-A', format('Case 2 no customer_id: expected TEST-0044-A, got %s', v_cust);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id = 'TEST-0044-1';
  ASSERT v_count = 1, format('Case 3 retry: expected 1 row, got %s', v_count);
  SELECT customer_name INTO v_cust FROM public.bookings WHERE id = 'TEST-0044-1';
  ASSERT v_cust = 'Booked for B', format('Case 1 name kept: expected the typed name, got %s', v_cust);
  SELECT count(*) INTO v_count FROM public.bookings WHERE customer_id = 'TEST-0044-B';
  ASSERT v_count = 0, format('Case 1: expected nothing filed under B, got %s rows', v_count);

  -- 5. Signed in with NO customer record -> refused, nothing written (both functions).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000044b1","role":"authenticated"}', true);
  BEGIN
    PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0044-5"}', 'TEST-0044-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%not linked to a customer record%', format('Case 5 workshop: expected the no-record refusal, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0044-6"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%not linked to a customer record%', format('Case 5 birthday: expected the no-record refusal, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0044-5', 'TEST-0044-6');
  ASSERT v_count = 0, format('Case 5: expected no rows written, got %s', v_count);

  -- 6. Staff, payload claims B -> stays B (both functions).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000044c1","role":"authenticated"}', true);
  PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0044-7"}', 'TEST-0044-S');
  PERFORM public.book_birthday_slot(v_bday  || '{"id":"TEST-0044-8","time":"6:00 PM"}');
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0044-7', 'TEST-0044-8') AND customer_id = 'TEST-0044-B';
  ASSERT v_count = 2, format('Case 6 staff: expected both filed under B, got %s', v_count);

  -- 7. Signed-out guest (anon), payload claims B -> stays B (both functions).
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0044-9"}', 'TEST-0044-S');
  PERFORM public.book_birthday_slot(v_bday  || '{"id":"TEST-0044-10","date":"2099-01-03"}');
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0044-9', 'TEST-0044-10') AND customer_id = 'TEST-0044-B';
  ASSERT v_count = 2, format('Case 7 guest: expected both filed under B, got %s', v_count);

  -- 8. Grants unchanged: anon and signed-in users may still call both.
  v_has := has_function_privilege('anon', 'public.book_session_seats(jsonb,text)', 'execute')
       AND has_function_privilege('authenticated', 'public.book_session_seats(jsonb,text)', 'execute')
       AND has_function_privilege('anon', 'public.book_birthday_slot(jsonb,boolean)', 'execute')
       AND has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute');
  ASSERT v_has, 'Case 8 grants: expected anon and authenticated execute on both functions';

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0044 TESTS PASSED — rolled back';
END $$;
*/
