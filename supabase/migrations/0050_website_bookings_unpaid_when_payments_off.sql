-- STATUS: NOT APPLIED
-- Written 8 Nov 2026. Apply manually in the Supabase SQL Editor, then run the
-- MANUAL TESTS block at the bottom.
-- =============================================================================
-- 0050 — WEBSITE BOOKINGS ARE UNPAID WHEN ONLINE PAYMENTS ARE OFF
--
-- Run after 0049_bookings_require_signed_in_caller.sql (applied). The
-- pre-flight block checks the live functions are the 0049 / 0048 versions.
--
-- THE PROBLEM
-- With onlinePayments.enabled = false, the checkout still ran the pre-Moyasar
-- simulation: an 800ms timer, then the booking was written with
-- payment_status 'Paid' (birthdays 'Deposit Paid'). No money moved. The
-- database accepted it because, for payments OFF, book_session_seats /
-- book_birthday_slot wrote whatever payment_status the browser sent.
-- The front end is fixed in the same commit (it now sends 'Unpaid' and says
-- "Pay at the studio"); this file makes the database refuse to rely on that.
--
-- THE FIX
--   book_session_seats / book_birthday_slot: for a NON-STAFF caller with
--     online payments OFF, payment_status is forced to 'Unpaid', whatever is
--     sent. (The payment columns — moyasar_payment_id, paid_at, ... — were
--     already stripped for non-staff by 0046.)
--   bookings_online_payment_guard (the 0048 backstop trigger): for a website
--     (anon / authenticated) non-staff insert with payments OFF, the row must
--     be 'Unpaid' with no moyasar_payment_id / paid_at; anything else is
--     refused. Payments ON: unchanged (must be a proper hold).
--
-- UNCHANGED
--   Staff bookings (console, walk-ins): exactly as today — staff can still
--   record Paid / Deposit Paid at the desk.
--   Payments ON: the 0046 hold flow, unchanged.
--   0049: signed-out callers are still refused.
--   Existing bookings: NOT touched. Bookings already recorded 'Paid' by the
--   simulation stay as they are; see the read-only query in the commit notes /
--   docs/PROJECT_NOTES.md to list them.
--
-- WHAT THIS ADDS / CHANGES
--   book_session_seats              0049 + the "0050" block
--   book_birthday_slot              0049 + the "0050" block
--   bookings_online_payment_guard() 0048 + the "0050" payments-off check
-- =============================================================================

-- Pre-flight: the live functions are the versions this file was written from.
do $$
begin
  if to_regprocedure('public.book_session_seats(jsonb,text)') is null
     or to_regprocedure('public.book_birthday_slot(jsonb,boolean)') is null
     or to_regprocedure('public.bookings_online_payment_guard()') is null
     or to_regprocedure('public.online_payments_config()') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception '0050 aborted: an expected function is missing';
  end if;

  if pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
       not like '%0049 — a website booking needs a signed-in caller%'
     or pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%0049 — a website booking needs a signed-in caller%' then
    raise exception '0050 aborted: the live booking functions are not the 0049 version — apply 0049 first';
  end if;

  if pg_get_functiondef('public.bookings_online_payment_guard()'::regprocedure)
       not like '%must be paid online%' then
    raise exception '0050 aborted: the live bookings_online_payment_guard is not the 0048 version';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- book_session_seats — the live 0049 definition plus the block marked "0050".
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

  -- 0050 — online payments OFF: a customer's website booking is paid at the
  -- studio, so it is always saved Unpaid, whatever the browser sends (the old
  -- simulated checkout sent 'Paid' after an 800ms timer). The 0046 strip above
  -- already drops the payment columns for a non-staff caller. Staff are
  -- unchanged; with payments ON the 0046 hold block above has set
  -- 'Awaiting Payment' and this does not run.
  if not public.is_staff()
     and not coalesce((public.online_payments_config()->>'enabled')::boolean, false) then
    p_booking := p_booking || jsonb_build_object('payment_status', 'Unpaid');
  end if;

  insert into public.bookings
  select * from jsonb_populate_record(null::public.bookings, p_booking);

  return v_booking_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- book_birthday_slot — the live 0049 definition plus the block marked "0050".
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

  -- 0050 — online payments OFF: a customer's website booking is paid at the
  -- studio, so it is always saved Unpaid, whatever the browser sends (the old
  -- simulated checkout sent 'Paid' after an 800ms timer). The 0046 strip above
  -- already drops the payment columns for a non-staff caller. Staff are
  -- unchanged; with payments ON the 0046 hold block above has set
  -- 'Awaiting Payment' and this does not run.
  if not public.is_staff()
     and not coalesce((public.online_payments_config()->>'enabled')::boolean, false) then
    p_booking := p_booking || jsonb_build_object('payment_status', 'Unpaid');
  end if;

  insert into public.bookings
  select * from jsonb_populate_record(null::public.bookings, p_booking);

  return v_booking_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- bookings_online_payment_guard — the 0048 backstop, now also for payments OFF
-- (block marked "0050"). Same trigger; only the function body changes.
-- -----------------------------------------------------------------------------
create or replace function public.bookings_online_payment_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg  jsonb;
  v_hold integer;
begin
  -- Only website requests. PostgREST runs them as anon / authenticated; the
  -- Edge Functions as service_role; the SQL Editor as postgres.
  if coalesce(current_setting('role', true), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Staff bookings are staff bookings, as today.
  if public.is_staff() then
    return new;
  end if;

  v_cfg := public.online_payments_config();
  if not coalesce((v_cfg->>'enabled')::boolean, false) then
    -- 0050 — payments off: a website booking is pay-at-the-studio. Nothing
    -- but Unpaid, and no payment recorded.
    if new.payment_status is distinct from 'Unpaid'
       or new.moyasar_payment_id is not null
       or new.paid_at is not null then
      raise exception '0050: online payments are off, so a website booking is paid at the studio and must be saved Unpaid.'
        using errcode = 'check_violation',
              detail = format('payment_status=%s', new.payment_status);
    end if;
    return new;
  end if;

  v_hold := (v_cfg->>'holdMinutes')::integer;

  if new.status is distinct from 'Pending'
     or new.payment_status is distinct from 'Awaiting Payment'
     or new.payment_mode is null
     or new.online_amount is null
     or new.online_amount <= 0
     or new.online_amount > new.total_price
     or new.online_amount_halalas is null
     or new.online_amount_halalas <> round(new.online_amount * 100)::integer
     or new.payment_expires_at is null
     or new.payment_expires_at <= now()
     or new.payment_expires_at > now() + make_interval(mins => v_hold)
     or new.moyasar_payment_id is not null
     or new.paid_at is not null then
    raise exception '0048: online payments are on, so this booking must be paid online. Please start your booking again.'
      using errcode = 'check_violation',
            detail = format('status=%s payment_status=%s payment_mode=%s online_amount=%s expires=%s',
                            new.status, new.payment_status, new.payment_mode, new.online_amount, new.payment_expires_at);
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0050 — online payments OFF%' as seats_0050,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%0050 — online payments OFF%' as birthday_0050,
  pg_get_functiondef('public.bookings_online_payment_guard()'::regprocedure)   like '%0050 — payments off%' as guard_0050,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0049 — a website booking needs a signed-in caller%' as seats_0049_kept,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%0049 — a website booking needs a signed-in caller%' as birthday_0049_kept,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0048 — a non-staff booking is filed%' as seats_0048_kept,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%online_payment_terms%' as seats_0046_kept,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%online_payment_terms%' as birthday_0046_kept,
  (select prosecdef from pg_proc where oid = 'public.bookings_online_payment_guard()'::regprocedure) as guard_security_definer,
  not has_function_privilege('authenticated', 'public.bookings_online_payment_guard()', 'execute') as guard_not_callable,
  exists (select 1 from pg_trigger where tgname = 'bookings_online_payment_guard'
            and tgrelid = 'public.bookings'::regclass and tgenabled = 'O') as guard_trigger_kept,
  has_function_privilege('authenticated', 'public.book_session_seats(jsonb,text)', 'execute') as seats_authenticated;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0050 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0050-* ids. The test sets onlinePayments
-- inside its own transaction; the rollback puts the live value back.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_err    text;
  v_count  int;
  r        record;
  c_cust   constant text := '{"sub":"00000000-0000-4000-8000-0000000050a1","role":"authenticated"}';
  c_staff  constant text := '{"sub":"00000000-0000-4000-8000-0000000050c1","role":"authenticated"}';
  -- What the OLD simulated checkout sent with payments off.
  v_web    jsonb := jsonb_build_object(
    'customer_name', 'Customer 0050', 'customer_phone', '+966500000951',
    'workshop_id', 'TEST-0050-W', 'session_id', 'TEST-0050-S', 'workshop_title', 'Test 0050 workshop',
    'date', '2099-07-01', 'time', '10:00', 'participants', 1,
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Paid', 'total_price', 150,
    'timeline', '[]'::jsonb, 'created_at', '2099-01-01T00:00:00Z');
  v_bday   jsonb := jsonb_build_object(
    'customer_name', 'Customer 0050', 'customer_phone', '+966500000951',
    'workshop_id', 'birthday-party-event', 'workshop_title', 'Birthday Party',
    'date', '2099-07-02', 'time', '4:00 PM', 'participants', 10,
    'birthday_details', jsonb_build_object('packageId', 'TEST-0050-PKG'),
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Deposit Paid', 'total_price', 1200,
    'timeline', '[]'::jsonb, 'created_at', '2099-01-01T00:00:00Z');
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000050a1', 'authenticated', 'authenticated', now(), now()), -- A: customer
    ('00000000-0000-4000-8000-0000000050c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0050-A', '00000000-0000-4000-8000-0000000050a1', 'Customer A', '+966500000951', '+966500000951', '500000951', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0050-STAFF', '00000000-0000-4000-8000-0000000050c1', 'Staff 0050', true, 'Active');
  INSERT INTO public.workshops (id, title, price, pricing_type) VALUES
    ('TEST-0050-W', 'Test 0050 workshop', 150, 'Per person');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0050-S', 'TEST-0050-W', '2099-07-01', '10:00', 50);
  INSERT INTO public.birthday_packages (id, name, price, pricing_type, status) VALUES
    ('TEST-0050-PKG', 'Test 0050 package', 120, 'Per child', 'Published');

  -- A known setting, OFF (rolled back at the end).
  INSERT INTO public.app_settings (id, value) VALUES ('onlinePayments',
    '{"enabled": false, "holdMinutes": 15, "workshop": {"mode": "deposit", "depositAmount": 100}, "birthday": {"mode": "full"}}')
  ON CONFLICT (id) DO UPDATE SET value = excluded.value;

  -- 1. Customer + payments OFF: whatever payment_status is sent, saved Unpaid.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-1a"}', 'TEST-0050-S');                                   -- 'Paid'
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0050-1b"}');                                                -- 'Deposit Paid'
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-1c","payment_status":"Refunded"}', 'TEST-0050-S');
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-1d","payment_status":"Awaiting Payment","moyasar_payment_id":"forged-0050","paid_at":"2099-01-01T00:00:00Z","payment_mode":"full","online_amount":1,"online_amount_halalas":100}', 'TEST-0050-S');
  -- 1e. What the fixed checkout sends.
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-1e","payment_status":"Unpaid"}', 'TEST-0050-S');
  PERFORM set_config('role', v_editor, true);
  FOR r IN SELECT * FROM public.bookings WHERE id IN ('TEST-0050-1a','TEST-0050-1b','TEST-0050-1c','TEST-0050-1d','TEST-0050-1e') LOOP
    ASSERT r.payment_status = 'Unpaid',
      format('Case 1 %s: payments off, a customer booking must be Unpaid, got %s', r.id, r.payment_status);
    ASSERT r.status = 'Pending' AND r.customer_id = 'TEST-0050-A',
      format('Case 1 %s: expected Pending, filed under A; got %s / %s', r.id, r.status, r.customer_id);
    ASSERT r.moyasar_payment_id IS NULL AND r.paid_at IS NULL AND r.payment_mode IS NULL
       AND r.online_amount IS NULL AND r.payment_expires_at IS NULL,
      format('Case 1 %s: no payment columns and no hold when payments are off', r.id);
  END LOOP;
  SELECT count(*) INTO v_count FROM public.bookings WHERE id LIKE 'TEST-0050-1%';
  ASSERT v_count = 5, format('Case 1: expected 5 bookings, got %s', v_count);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-1a';
  ASSERT r.total_price = 150, format('Case 1a: total as sent (payments off), got %s', r.total_price);

  -- 2. Staff + payments OFF: unchanged — what staff record is what is saved.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0050-2a","source":"Walk-in"}', 'TEST-0050-S');            -- Paid at the desk
  PERFORM public.book_birthday_slot((v_bday - 'source') || '{"id":"TEST-0050-2b","source":"Admin","date":"2099-07-03"}', true);  -- Deposit Paid
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0050-2c","source":"Admin","payment_status":"Unpaid"}', 'TEST-0050-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-2a';
  ASSERT r.payment_status = 'Paid', format('Case 2a staff: Paid at the desk must be kept, got %s', r.payment_status);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-2b';
  ASSERT r.payment_status = 'Deposit Paid', format('Case 2b staff: Deposit Paid must be kept, got %s', r.payment_status);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-2c';
  ASSERT r.payment_status = 'Unpaid', format('Case 2c staff: Unpaid kept, got %s', r.payment_status);

  -- 3. Payments ON: unchanged — a customer gets the hold, staff as sent.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-3a"}', 'TEST-0050-S');
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0050-3b","date":"2099-07-04"}');
  PERFORM set_config('request.jwt.claims', c_staff, true);
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0050-3c","source":"Walk-in"}', 'TEST-0050-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-3a';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.payment_mode = 'deposit' AND r.online_amount = 100
     AND r.payment_expires_at IS NOT NULL,
    format('Case 3a ON: expected a 100 SAR deposit hold, got %s / %s / %s', r.payment_status, r.payment_mode, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-3b';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.payment_mode = 'full' AND r.online_amount = 1200,
    format('Case 3b ON: expected a 1200 SAR full hold, got %s / %s / %s', r.payment_status, r.payment_mode, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0050-3c';
  ASSERT r.payment_status = 'Paid' AND r.payment_expires_at IS NULL,
    format('Case 3c staff ON: expected Paid, no hold, got %s', r.payment_status);

  -- 4. The backstop trigger on its own (a stand-in for an insert path that
  --    forgot the block): a SECURITY DEFINER function inserting what it gets.
  CREATE FUNCTION public.test_0050_raw_insert(p jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public
    AS $f$ INSERT INTO public.bookings SELECT * FROM jsonb_populate_record(null::public.bookings, p) $f$;
  GRANT EXECUTE ON FUNCTION public.test_0050_raw_insert(jsonb) TO anon, authenticated;
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE id = 'onlinePayments';

  -- 4a. Customer, OFF, 'Paid' -> refused.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4a","customer_id":"TEST-0050-A"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%paid at the studio%', format('Case 4a: a customer Paid row with payments off must be refused, got %s', coalesce(v_err, 'no error'));
  -- 4b. Customer, OFF, 'Unpaid' but with a payment id -> refused.
  BEGIN
    PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4b","customer_id":"TEST-0050-A","payment_status":"Unpaid","moyasar_payment_id":"forged"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%paid at the studio%', format('Case 4b: an Unpaid row carrying a payment id must be refused, got %s', coalesce(v_err, 'no error'));
  -- 4c. Customer, OFF, plain Unpaid -> allowed.
  PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4c","customer_id":"TEST-0050-A","payment_status":"Unpaid"}');
  -- 4d. Staff, OFF, Paid -> allowed.
  PERFORM set_config('request.jwt.claims', c_staff, true);
  PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4d"}');
  -- 4e. service_role, OFF, Paid -> allowed (not a website caller).
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4e"}');
  -- 4f. The SQL Editor, OFF, Paid -> allowed.
  PERFORM set_config('role', v_editor, true);
  INSERT INTO public.bookings (id, workshop_title, date, participants, status, payment_status)
  VALUES ('TEST-0050-4f', 'Test 0050 editor', '2099-07-01', 1, 'Pending', 'Paid');
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0050-4c', 'TEST-0050-4d', 'TEST-0050-4e', 'TEST-0050-4f');
  ASSERT v_count = 4, format('Case 4c-f: allowed rows must be saved, got %s of 4', v_count);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0050-4a', 'TEST-0050-4b');
  ASSERT v_count = 0, format('Case 4a-b: refused rows must not exist, found %s', v_count);

  -- 4g. Payments ON: the 0048 rule still holds (an unpaid customer row is refused).
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM public.test_0050_raw_insert(v_web || '{"id":"TEST-0050-4g","customer_id":"TEST-0050-A","payment_status":"Unpaid"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM set_config('role', v_editor, true);
  ASSERT v_err LIKE '%must be paid online%', format('Case 4g: payments on, an unpaid customer row must still be refused (0048), got %s', coalesce(v_err, 'no error'));

  -- 5. A signed-out guest is still refused (0049), payments off.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.book_session_seats(v_web || '{"id":"TEST-0050-5"}', 'TEST-0050-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM set_config('role', v_editor, true);
  ASSERT v_err LIKE '%sign in to complete your booking%', format('Case 5: a guest must still be refused (0049), got %s', coalesce(v_err, 'no error'));

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0050 TESTS PASSED — rolled back';
END $$;
*/
