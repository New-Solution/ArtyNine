-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 8 Nov 2026; every verification
-- column true and all manual tests passed.
-- =============================================================================
-- 0049 — BOOKINGS NEED A SIGNED-IN CALLER (NO GUEST customer_id)
--
-- Run after 0048_enforce_online_payment_hold.sql (applied). The pre-flight
-- block checks the live booking functions are the 0048 / 0046 versions.
--
-- THE PROBLEM
-- book_session_seats / book_birthday_slot are executable by anon. 0044
-- replaces the payload's customer_id with the caller's own record only for a
-- SIGNED-IN customer; for a signed-out caller (auth.uid() null) it keeps
-- whatever customer_id was sent. So a direct call could attach a booking to
-- any existing customer, and it would appear in that customer's My Bookings.
-- Payment was never bypassable this way: with payments on it is still a hold.
--
-- CAN A SIGNED-OUT GUEST BOOK THROUGH THE LIVE SITE? No.
--   Phone sign-in on (VITE_PHONE_AUTH, live): the checkout details step shows
--   only the phone-code flow until the visitor is signed in; the form that
--   continues to the payment step renders only for a signed-in customer.
--   Phone sign-in off (fallback): "Continue" first registers an account; if
--   that leaves no session (email confirmation) it stops with "check your
--   email" and does not advance. So the payment step — the only place
--   addBooking() is called for a customer — is reached signed in.
--   The only signed-out callers are direct API calls, or a session that ends
--   between the details step and pressing Pay (signed out in another tab).
--
-- THE FIX (recommended option: refuse, rather than resolve a customer)
-- Both functions now refuse a signed-out API caller before doing anything:
--   'Please sign in to complete your booking.' (insufficient_privilege)
-- Why refuse instead of resolving/creating a customer from the phone number:
--   - No legitimate flow needs it (above).
--   - Resolving by phone would itself be the hole: anyone typing another
--     person's phone number would file a booking on THEIR record, visible in
--     their My Bookings — the same problem with an extra step. The phone is
--     only trustworthy once verified, i.e. once the caller is signed in.
--   - Creating records for unverified phones would add the empty / duplicate
--     customer records 0042 was written to stop.
-- The checkout shows a "please sign in again" message for this error.
--
-- WHO IS UNAFFECTED
--   signed-in customers   unchanged (0044: always their own record)
--   staff                 unchanged (always signed in; book for any customer)
--   service_role / SQL Editor   unchanged (not the anon API role). Nothing in
--                         the Edge Functions or scripts calls these RPCs.
-- Grants are unchanged; the refusal is in the function body.
--
-- NOTE FOR OLDER TEST BLOCKS
-- The manual tests of 0046 (cases 1-4, 7) and 0048 (cases 5, 7d) book as a
-- signed-out guest. After 0049 those cases are refused by design, so those
-- blocks will stop at the first guest case if re-run. This file's tests
-- cover the same ground for signed-in callers.
-- =============================================================================

-- Pre-flight: the live functions are the versions this file was written from.
do $$
begin
  if to_regprocedure('public.book_session_seats(jsonb,text)') is null
     or to_regprocedure('public.book_birthday_slot(jsonb,boolean)') is null
     or to_regprocedure('public.current_customer_id()') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception '0049 aborted: an expected function is missing';
  end if;

  if pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
       not like '%0048 — a non-staff booking is filed%' then
    raise exception '0049 aborted: the live book_session_seats is not the 0048 version — apply 0048 first';
  end if;

  if pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%online_payment_terms%'
     or pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%current_customer_id()%' then
    raise exception '0049 aborted: the live book_birthday_slot is not the 0046 version';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- book_session_seats — the live 0048 definition plus the block marked "0049".
-- -----------------------------------------------------------------------------
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
  v_terms      record;
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

  -- 0049 — a website booking needs a signed-in caller. A signed-out caller
  -- (the anon API role, auth.uid() null) used to keep whatever customer_id it
  -- sent, so it could file a booking under ANY existing customer and make it
  -- appear in their My Bookings. The site never books signed out (checkout
  -- signs the customer in before the payment step), so it is refused here,
  -- before anything else — including the "already exists" retry shortcut, so
  -- a guest cannot probe booking ids either. Staff (always signed in), the
  -- service role and the SQL Editor are not API anon callers and are
  -- unaffected; signed-in customers continue to the 0044 rule below.
  if auth.uid() is null
     and coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
    raise exception 'Please sign in to complete your booking.'
      using errcode = 'insufficient_privilege';
  end if;

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

  -- 0046 — the payment columns are the server's to write, never a customer's.
  if not public.is_staff() then
    p_booking := p_booking - array[
      'payment_mode', 'online_amount', 'online_amount_halalas',
      'payment_expires_at', 'moyasar_payment_id', 'paid_at'
    ];
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

  -- 0048 — a non-staff booking is filed on the session whose seats were just
  -- checked and whose price online_payment_terms charges, whatever the
  -- payload's session_id says. Before this, p_session_id = a cheap session
  -- with payload session_id = a dearer one checked and priced the cheap
  -- session but saved the row on the dear one. Staff are unchanged.
  if not public.is_staff() then
    p_booking := p_booking || jsonb_build_object('session_id', v_session_id);
  end if;

  -- 0046 — a retry of a hold that has since expired must not be reported as a
  -- success: its seat is gone and it can no longer be paid.
  if v_booking_id is not null and exists (
       select 1 from public.bookings b
        where b.id = v_booking_id
          and (b.payment_status = 'Expired'
               or (b.payment_status = 'Awaiting Payment' and b.payment_expires_at <= now()))
     ) then
    raise exception 'This booking hold has expired. Please start your booking again.';
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

  -- 0046 — online payment on: a customer's booking is a hold until paid, at a
  -- price the database computes.
  if not public.is_staff() and (public.online_payments_config()->>'enabled')::boolean then
    select * into v_terms
      from public.online_payment_terms(p_booking || jsonb_build_object('session_id', v_session_id), false);

    p_booking := p_booking || jsonb_build_object(
      'status',                'Pending',
      'payment_status',        'Awaiting Payment',
      'total_price',           v_terms.total_price,
      'payment_mode',          v_terms.payment_mode,
      'online_amount',         v_terms.online_amount,
      'online_amount_halalas', round(v_terms.online_amount * 100)::integer,
      'payment_expires_at',    now() + make_interval(mins => (public.online_payments_config()->>'holdMinutes')::integer)
    );
  end if;

  insert into public.bookings
  select * from jsonb_populate_record(null::public.bookings, p_booking);

  return v_booking_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- book_birthday_slot — the live 0046 definition plus the block marked "0049".
-- -----------------------------------------------------------------------------
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
  -- src/utils/queueUtils.ts, and with confirm_booking_payment below.
  c_daily_max     constant integer := 5;
  c_slot_max      constant integer := 2;

  v_booking_id    text;
  v_date          date;
  v_time          text;
  v_override      boolean;
  v_on_date       integer;
  v_at_slot       integer;
  v_own_customer  text;
  v_terms         record;
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

  -- 0049 — a website booking needs a signed-in caller. A signed-out caller
  -- (the anon API role, auth.uid() null) used to keep whatever customer_id it
  -- sent, so it could file a booking under ANY existing customer and make it
  -- appear in their My Bookings. The site never books signed out (checkout
  -- signs the customer in before the payment step), so it is refused here,
  -- before anything else — including the "already exists" retry shortcut, so
  -- a guest cannot probe booking ids either. Staff (always signed in), the
  -- service role and the SQL Editor are not API anon callers and are
  -- unaffected; signed-in customers continue to the 0044 rule below.
  if auth.uid() is null
     and coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
    raise exception 'Please sign in to complete your booking.'
      using errcode = 'insufficient_privilege';
  end if;

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

  -- 0046 — the payment columns are the server's to write, never a customer's.
  if not public.is_staff() then
    p_booking := p_booking - array[
      'payment_mode', 'online_amount', 'online_amount_halalas',
      'payment_expires_at', 'moyasar_payment_id', 'paid_at'
    ];
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

  -- 0046 — see book_session_seats.
  if v_booking_id is not null and exists (
       select 1 from public.bookings b
        where b.id = v_booking_id
          and (b.payment_status = 'Expired'
               or (b.payment_status = 'Awaiting Payment' and b.payment_expires_at <= now()))
     ) then
    raise exception 'This booking hold has expired. Please start your booking again.';
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
      and lower(coalesce(b.payment_status, '')) not in ('failed','payment failed','declined','draft','expired')
      -- 0046: an unpaid hold past its expiry no longer holds the slot.
      and not (b.payment_status = 'Awaiting Payment'
               and b.payment_expires_at is not null
               and b.payment_expires_at <= now())
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

  -- 0046 — online payment on: see book_session_seats.
  if not public.is_staff() and (public.online_payments_config()->>'enabled')::boolean then
    select * into v_terms from public.online_payment_terms(p_booking, true);

    p_booking := p_booking || jsonb_build_object(
      'status',                'Pending',
      'payment_status',        'Awaiting Payment',
      'total_price',           v_terms.total_price,
      'payment_mode',          v_terms.payment_mode,
      'online_amount',         v_terms.online_amount,
      'online_amount_halalas', round(v_terms.online_amount * 100)::integer,
      'payment_expires_at',    now() + make_interval(mins => (public.online_payments_config()->>'holdMinutes')::integer)
    );
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
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0049 — a website booking needs a signed-in caller%' as seats_0049,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%0049 — a website booking needs a signed-in caller%' as birthday_0049,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0048 — a non-staff booking is filed%' as seats_0048_kept,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%online_payment_terms%' as seats_0046_kept,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%online_payment_terms%' as birthday_0046_kept,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%current_customer_id()%' as seats_0044_kept,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%current_customer_id()%' as birthday_0044_kept,
  -- Grants are unchanged (create or replace keeps the ACL); the refusal is in
  -- the function body, so it holds even if a grant is changed later.
  has_function_privilege('authenticated', 'public.book_session_seats(jsonb,text)',    'execute') as seats_authenticated,
  has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute') as birthday_authenticated,
  exists (select 1 from pg_trigger where tgname = 'bookings_online_payment_guard'
            and tgrelid = 'public.bookings'::regclass and tgenabled = 'O') as guard_trigger_kept;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0049 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0049-* ids. The test sets onlinePayments
-- inside its own transaction; the rollback puts the live value back.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_err    text;
  v_count  int;
  r        record;
  c_cust   constant text := '{"sub":"00000000-0000-4000-8000-0000000049a1","role":"authenticated"}';
  c_noacct constant text := '{"sub":"00000000-0000-4000-8000-0000000049b1","role":"authenticated"}';
  c_staff  constant text := '{"sub":"00000000-0000-4000-8000-0000000049c1","role":"authenticated"}';
  -- What the website checkout sends.
  v_web    jsonb := jsonb_build_object(
    'customer_name', 'Customer 0049', 'customer_phone', '+966500000949',
    'workshop_id', 'TEST-0049-W', 'session_id', 'TEST-0049-S', 'workshop_title', 'Test 0049 workshop',
    'date', '2099-06-01', 'time', '10:00', 'participants', 1,
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Unpaid', 'total_price', 150,
    'timeline', '[]'::jsonb, 'created_at', '2099-01-01T00:00:00Z');
  v_bday   jsonb := jsonb_build_object(
    'customer_name', 'Customer 0049', 'customer_phone', '+966500000949',
    'workshop_id', 'birthday-party-event', 'workshop_title', 'Birthday Party',
    'date', '2099-06-02', 'time', '4:00 PM', 'participants', 10,
    'birthday_details', jsonb_build_object('packageId', 'TEST-0049-PKG'),
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Unpaid', 'total_price', 1200,
    'timeline', '[]'::jsonb, 'created_at', '2099-01-01T00:00:00Z');
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000049a1', 'authenticated', 'authenticated', now(), now()), -- A: customer
    ('00000000-0000-4000-8000-0000000049b1', 'authenticated', 'authenticated', now(), now()), -- N: signed in, no customer record
    ('00000000-0000-4000-8000-0000000049c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0049-A', '00000000-0000-4000-8000-0000000049a1', 'Customer A', '+966500000949', '+966500000949', '500000949', true),
    ('TEST-0049-V', NULL, 'Victim V', '+966500000950', '+966500000950', '500000950', false);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0049-STAFF', '00000000-0000-4000-8000-0000000049c1', 'Staff 0049', true, 'Active');
  INSERT INTO public.workshops (id, title, price, pricing_type) VALUES
    ('TEST-0049-W', 'Test 0049 workshop', 150, 'Per person');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0049-S', 'TEST-0049-W', '2099-06-01', '10:00', 50);
  INSERT INTO public.birthday_packages (id, name, price, pricing_type, status) VALUES
    ('TEST-0049-PKG', 'Test 0049 package', 120, 'Per child', 'Published');
  -- An existing booking a guest might try to probe by id.
  INSERT INTO public.bookings (id, customer_id, workshop_title, date, participants, status, payment_status)
  VALUES ('TEST-0049-EXISTING', 'TEST-0049-V', 'Test 0049 existing', '2099-06-01', 1, 'Pending', 'Unpaid');

  -- A known setting, OFF (rolled back at the end).
  INSERT INTO public.app_settings (id, value) VALUES ('onlinePayments',
    '{"enabled": false, "holdMinutes": 15, "workshop": {"mode": "deposit", "depositAmount": 100}, "birthday": {"mode": "full"}}')
  ON CONFLICT (id) DO UPDATE SET value = excluded.value;

  -- 1. Signed-out guest, payments OFF: refused, both RPCs, even with a victim's customer_id.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-1a","customer_id":"TEST-0049-V"}', 'TEST-0049-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 1a: guest workshop booking must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0049-1b","customer_id":"TEST-0049-V"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 1b: guest birthday booking must be refused, got %s', coalesce(v_err, 'no error'));
  -- 1c. No customer_id at all: still refused.
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-1c"}', 'TEST-0049-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 1c: guest booking without customer_id must be refused, got %s', coalesce(v_err, 'no error'));
  -- 1d. Probing an existing booking id: refused, not "success".
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-EXISTING"}', 'TEST-0049-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 1d: guest retry of an existing id must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0049-1a', 'TEST-0049-1b', 'TEST-0049-1c');
  ASSERT v_count = 0, format('Case 1: no guest booking may be saved, found %s', v_count);
  SELECT count(*) INTO v_count FROM public.bookings WHERE customer_id = 'TEST-0049-V';
  ASSERT v_count = 1, format('Case 1: the victim must still have only their own booking, has %s', v_count);

  -- 2. Signed-out guest, payments ON: refused too.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-2a","customer_id":"TEST-0049-V"}', 'TEST-0049-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 2a: guest booking (payments on) must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0049-2b"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 2b: guest birthday (payments on) must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0049-2a', 'TEST-0049-2b');
  ASSERT v_count = 0, format('Case 2: no guest booking may be saved, found %s', v_count);

  -- 3. Signed-in customer, payments ON: works as before; a forged customer_id
  --    is replaced by their own (0044), and it is a payment hold (0046).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-3a","customer_id":"TEST-0049-V"}', 'TEST-0049-S');
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0049-3b","customer_id":"TEST-0049-V"}');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0049-3a';
  ASSERT r.customer_id = 'TEST-0049-A' AND r.payment_status = 'Awaiting Payment' AND r.online_amount = 100,
    format('Case 3a: expected A / Awaiting Payment / 100, got %s / %s / %s', r.customer_id, r.payment_status, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0049-3b';
  ASSERT r.customer_id = 'TEST-0049-A' AND r.payment_status = 'Awaiting Payment' AND r.online_amount = 1200,
    format('Case 3b: expected A / Awaiting Payment / 1200, got %s / %s / %s', r.customer_id, r.payment_status, r.online_amount);
  -- 3c. Their own retry (same id) still returns the booking, as before.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  ASSERT public.book_session_seats(v_web || '{"id":"TEST-0049-3a"}', 'TEST-0049-S') = 'TEST-0049-3a',
    'Case 3c: a signed-in retry of the same id must return it';
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id = 'TEST-0049-3a';
  ASSERT v_count = 1, format('Case 3c: the retry must not write a second row, found %s', v_count);

  -- 4. Signed-in customer, payments OFF: a normal booking on their own record.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-4","customer_id":"TEST-0049-V"}', 'TEST-0049-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0049-4';
  ASSERT r.customer_id = 'TEST-0049-A' AND r.payment_status = 'Unpaid' AND r.payment_expires_at IS NULL,
    format('Case 4: expected A / Unpaid / no hold, got %s / %s / %s', r.customer_id, r.payment_status, r.payment_expires_at);

  -- 5. Signed in but no customer record: the existing 0044 refusal, unchanged.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_noacct, true);
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-5"}', 'TEST-0049-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM set_config('role', v_editor, true);
  ASSERT v_err LIKE '%not linked to a customer record%', format('Case 5: expected the 0044 message, got %s', coalesce(v_err, 'no error'));

  -- 6. Staff: unchanged — may book for any customer, as sent (payments on).
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0049-6a","source":"Admin","customer_id":"TEST-0049-V"}', 'TEST-0049-S');
  PERFORM public.book_birthday_slot((v_bday - 'source') || '{"id":"TEST-0049-6b","source":"Admin","customer_id":"TEST-0049-V","date":"2099-06-03"}', true);
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings
   WHERE id IN ('TEST-0049-6a', 'TEST-0049-6b') AND customer_id = 'TEST-0049-V' AND payment_status = 'Unpaid' AND payment_expires_at IS NULL;
  ASSERT v_count = 2, format('Case 6 staff: expected 2 Unpaid bookings filed for V as sent, got %s', v_count);

  -- 7. Service role and the SQL Editor (no anon API role): unchanged.
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-7a"}', 'TEST-0049-S');
  PERFORM set_config('role', v_editor, true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0049-7b"}', 'TEST-0049-S');
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0049-7a', 'TEST-0049-7b');
  ASSERT v_count = 2, format('Case 7: service_role / editor bookings must still be saved, got %s', v_count);

  -- 8. Grants unchanged: the refusal is in the body, not a revoked grant.
  ASSERT has_function_privilege('anon', 'public.book_session_seats(jsonb,text)', 'execute')
     AND has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute'),
    'Case 8: EXECUTE grants must be unchanged';

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0049 TESTS PASSED — rolled back';
END $$;
*/
