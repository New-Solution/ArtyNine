-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 8 Nov 2026; every verification
-- column true and all manual tests passed. notify-own-booking was deployed
-- first, as the DEPLOY ORDER below requires.
-- =============================================================================
-- 0048 — ONLINE PAYMENT HOLD: A DATABASE BACKSTOP FOR EVERY WEBSITE BOOKING;
--        CUSTOMER CANCELLATION NEVER MARKS AN UNPAID BOOKING REFUNDED
--
-- Run after 0047_moyasar_payment_events.sql. Requires the 0046 versions of
-- book_session_seats / book_birthday_slot / cancel_own_booking; the
-- pre-flight block checks.
--
-- WHAT HAPPENED
-- On the live site, with onlinePayments.enabled = true, website bookings were
-- saved as ordinary pay-at-studio bookings (payment_mode NULL, Unpaid, no
-- hold). The browser was signed in as STAFF, and both booking RPCs treat an
-- is_staff() caller as a staff booking. That is by design and is unchanged.
--
-- HOW 0046 DECIDES (the analysis behind this file)
-- book_session_seats(p_booking, p_session_id) and
-- book_birthday_slot(p_booking, p_allow_override) take the decision from ONE
-- thing: the result of
--     not public.is_staff() and online_payments_config()->>'enabled'
-- evaluated inside the function. Neither is an argument:
--   - is_staff() looks up public.staff by auth.uid(), which comes from the
--     caller's signed JWT. Only a super admin can insert into staff (RLS).
--   - online_payments_config() reads app_settings 'onlinePayments', which only
--     staff can write (RLS), and is not executable by anon/authenticated.
-- When that is true the RPC, after the capacity check and immediately before
-- the insert, overwrites status, payment_status, total_price, payment_mode,
-- online_amount(_halalas) and payment_expires_at with values computed from the
-- database (online_payment_terms), and strips moyasar_payment_id / paid_at.
-- Nothing in p_booking or the other argument can change that:
--   status / payment_status / total_price / payment_*   overwritten
--   moyasar_payment_id / paid_at                        stripped
--   customer_id                                          replaced (0044)
--   p_session_id vs payload session_id                  see GAP below
--   p_allow_override                                    ignored unless staff
--   an id that already exists                           returns early, inserts
--                                                        nothing
--   a free / unpriced item                              refused (cannot be
--                                                        paid online)
-- And there is no other way for a non-staff caller to create a booking:
-- public.bookings has no INSERT policy except bookings_staff_all, and no other
-- function executable by anon/authenticated inserts into it. Customers have no
-- UPDATE policy, and confirm_booking_payment is service_role only.
--
-- CONCLUSION: a signed-in customer (or a guest) already CANNOT get an unpaid
-- website booking while onlinePayments.enabled is true. The only way to get
-- one is to be staff.
--
-- GAP (not an unpaid booking, but a wrong amount): book_session_seats checks
-- seats on, and prices, coalesce(p_session_id, payload session_id), but saves
-- the payload's session_id. A customer sending p_session_id = a cheap session
-- and session_id = a dearer one got a hold priced on the cheap session, filed
-- (and counted) on the dear one, past its capacity check. Fixed below: for a
-- non-staff caller the row is always filed on the checked session. This
-- applies whether online payments are on or off.
--
-- WHAT THIS FILE ADDS ANYWAY
-- The rule above lives inside two long functions. If a later migration
-- rewrites either one and drops the "0046" block, or adds a new insert path,
-- unpaid website bookings would come back silently. So the rule is now also a
-- BEFORE INSERT trigger on public.bookings:
--
--   when the request comes from the website API roles (anon / authenticated),
--   the caller is not staff, and onlinePayments.enabled is true,
--   the new row MUST be an online payment hold:
--     status 'Pending', payment_status 'Awaiting Payment', payment_mode set,
--     online_amount > 0 and <= total_price, online_amount_halalas matching it,
--     payment_expires_at in (now, now + holdMinutes], no moyasar_payment_id,
--     no paid_at.
--   Anything else is refused with an error; nothing is saved.
--
-- The trigger only CHECKS; the two RPCs still do the forcing, and every row
-- they write for a non-staff caller already passes. book_birthday_slot is not
-- changed. book_session_seats changes only by the session fix above, for
-- non-staff callers; staff bookings are exactly as today.
--
-- WHAT THIS ADDS / CHANGES
--   book_session_seats              0046 + the "0048" session block
--   cancel_own_booking              0046 + the "0048" refund rules (see its
--                                   own comment): never 'Refunded'; an unpaid
--                                   booking stays unpaid; a refund that is due
--                                   is 'Needs Refund' and staff are notified
--   bookings_online_payment_guard() trigger function (not callable by API roles)
--   trigger bookings_online_payment_guard  BEFORE INSERT ON public.bookings
--
-- WHO IS UNAFFECTED
--   staff (is_staff())                  console, walk-ins, admin bookings
--   service_role                        Edge Functions
--   the SQL Editor / postgres           test blocks, manual fixes
--   anyone, when enabled = false
-- The caller is read from the 'role' setting (current_setting('role')), which
-- PostgREST sets with SET LOCAL ROLE for every request and which a SECURITY
-- DEFINER function does NOT change — so the trigger sees the website caller
-- even when the insert runs inside book_session_seats. (current_user would
-- show the function owner there.) Test case 7 proves this.
--
-- EVERY PATH THAT INSERTS INTO public.bookings (audited 8 Nov 2026)
--   Database functions (all migrations): only book_session_seats and
--   book_birthday_slot. No other function inserts a booking.
--   Website / app code:
--     checkout (workshops, events, birthdays) -> addBooking() -> one of the
--       two RPCs. Non-staff with payments on: forced hold -> passes.
--     staff console bookings ('Admin') and walk-ins converted to bookings
--       -> addBooking() -> the RPCs as staff -> exempt.
--     live-queue walk-ins -> addQueueItem() writes public.queue, not
--       bookings (the bookings page shows them from the queue).
--     System Health tests (systemTests.ts) -> RPCs / table writes in a
--       staff session -> exempt.
--     generic db.bookings.put/add (supabaseDb.ts) -> no caller outside
--       systemTests; RLS allows it for staff only anyway.
--   Edge Functions: none insert bookings (auto-cancel-bookings,
--     verify-payment, moyasar-webhook, notify-own-booking only read/update),
--     and they run as service_role -> exempt.
--   scripts/*.mjs: service role; none insert bookings.
--   There is no waitlist, reschedule or birthday/event "request" path that
--   creates a booking.
--   UPDATEs (cancel, confirm payment, auto-cancel, staff edits) are not
--   affected: the trigger is INSERT only.
--
-- DEPLOY ORDER
--   1. Deploy the notify-own-booking Edge Function from the same commit
--      (it stops sending an SMS for a never-paid cancellation or a refund
--      that is due). Deploying it first is safe on the 0046 database.
--   2. Apply this file, then run the MANUAL TESTS block.
--   Applying 0048 BEFORE the new notify-own-booking would make the old one
--   send "not eligible for a refund" for 'Needs Refund' cancellations.
-- =============================================================================

-- Pre-flight: the live booking functions are the 0046 versions.
do $$
begin
  if to_regprocedure('public.book_session_seats(jsonb,text)') is null
     or to_regprocedure('public.book_birthday_slot(jsonb,boolean)') is null
     or to_regprocedure('public.online_payments_config()') is null
     or to_regprocedure('public.online_payment_terms(jsonb,boolean)') is null
     or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.cancel_own_booking(text)') is null
     or to_regprocedure('public.release_booking_seats(text)') is null
     or to_regprocedure('public.booking_start_at(date,text)') is null then
    raise exception '0048 aborted: an expected function is missing (apply 0046 first)';
  end if;

  if pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
       not like '%online_payment_terms%'
     or pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%online_payment_terms%' then
    raise exception '0048 aborted: the live booking functions are not the 0046 version';
  end if;

  if pg_get_functiondef('public.cancel_own_booking(text)'::regprocedure)
       not like '%Non-refundable deposit%' then
    raise exception '0048 aborted: the live cancel_own_booking is not the 0046 version';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- book_session_seats — 0046 verbatim plus the block marked "0048".
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
-- cancel_own_booking — 0046 verbatim except the blocks marked "0048".
--
-- 0046 marked EVERY booking that was not an online deposit or an unpaid hold
-- 'Refunded' when cancelled with more than 24 hours' notice — including
-- bookings that were never paid (pay-at-studio, Unpaid) — and told the
-- customer "N SAR has been refunded". Nothing is refunded automatically: the
-- money is returned by staff (Moyasar dashboard, or in person). So now:
--
--   unpaid online hold ('Awaiting Payment')   0046 unchanged: Cancelled,
--                                             payment_status kept, no refund
--   never paid (anything that is not          Cancelled, payment_status KEPT
--     'Paid' / 'Deposit Paid', e.g. Unpaid)   (e.g. stays Unpaid), no refund,
--                                             whatever the notice
--   online deposit (payment_mode 'deposit')   0046 unchanged: never refunded,
--                                             stays 'Deposit Paid'
--   online full payment, > 24h notice         'Needs Refund' (staff refund the
--                                             Moyasar payment); staff notified
--   paid at the studio (staff marked Paid /   'Needs Refund' (staff refund in
--     Deposit Paid, no online payment), > 24h person); staff notified
--   any paid booking, <= 24h notice           non-refundable, status kept
--
-- 'Refunded' is never written here any more: that is for staff to set once
-- the money has actually gone back.
--
-- Returns refunded = true when a refund is DUE (Needs Refund).
--
-- Customer in-app notification (title always 'Booking Cancelled'):
--   refund due     "...has been cancelled. The studio will refund your payment."
--   never paid     the 0046 hold wording: "Your unpaid booking ... has been
--                  cancelled. Nothing was charged."
--   not refunded   unchanged 0031 wording
-- The SMS is sent by notify-own-booking, which picks a REGISTERED template
-- from payment_status (cancellationSmsKind in
-- supabase/functions/_shared/bookingSmsTemplates.ts): none for a never-paid
-- booking or a refund that is due.
-- -----------------------------------------------------------------------------
create or replace function public.cancel_own_booking(p_booking_id text)
returns table (success boolean, code text, reason text, refunded boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  b            public.bookings%rowtype;
  caller       text;
  starts_at    timestamptz;
  hours_notice numeric;
  is_refund    boolean;
  is_hold      boolean;
  is_paid      boolean;
  is_online    boolean;
  refund_amt   text;
  note         text;
  q            public.queue%rowtype;
begin
  if p_booking_id is null or btrim(p_booking_id) = '' then
    return query select false, 'not_found', 'That booking could not be found.', false;
    return;
  end if;

  -- auth.uid() comes from the caller's own JWT and cannot be supplied through
  -- the argument list, so ownership cannot be forged by passing someone
  -- else's id — the same reasoning as claim_customer_account in 0010.
  caller := public.current_customer_id();
  if caller is null then
    return query select false, 'not_owner', 'Please sign in to manage your bookings.', false;
    return;
  end if;

  select * into b from public.bookings where id = p_booking_id;

  -- "Not found" and "not yours" deliberately answer identically: a customer
  -- must not be able to probe which booking ids exist.
  if b.id is null or b.customer_id is null or b.customer_id <> caller then
    return query select false, 'not_owner', 'That booking could not be found on your account.', false;
    return;
  end if;

  if b.status = 'Cancelled' then
    return query select false, 'already_cancelled', 'This booking has already been cancelled.', false;
    return;
  end if;

  -- A session already attended, or under way, is not the customer's to undo.
  if b.status in ('Completed', 'Checked In', 'In Progress') then
    return query select
      false,
      'not_cancellable',
      'This booking can no longer be cancelled online. Please contact the studio.',
      false;
    return;
  end if;

  starts_at := public.booking_start_at(b.date, b.time);
  if starts_at is null then
    return query select
      false,
      'unknown_time',
      'We could not confirm this booking''s start time. Please contact the studio to cancel.',
      false;
    return;
  end if;

  hours_notice := extract(epoch from (starts_at - now())) / 3600.0;

  if hours_notice <= 0 then
    return query select
      false,
      'already_started',
      'This session has already started, so it can no longer be cancelled online.',
      false;
    return;
  end if;

  -- 0048 — the refund decision depends on whether, and how, it was paid.
  is_hold   := b.payment_status = 'Awaiting Payment';
  is_paid   := b.payment_status in ('Paid', 'Deposit Paid');
  is_online := b.moyasar_payment_id is not null;

  if is_hold then
    is_refund := false;
    note := 'Unpaid booking hold cancelled by Customer — nothing was charged';
  elsif not is_paid then
    -- 0048: never paid (Unpaid, or any status that does not say money
    -- arrived). Nothing to refund, whatever the notice.
    is_refund := false;
    note := 'Booking cancelled by Customer — nothing was paid, nothing to refund';
  elsif b.payment_mode = 'deposit' then
    is_refund := false;
    note := 'Booking cancelled by Customer — Non-refundable deposit';
  else
    -- The rule the customer is shown: more than 24 hours' notice is refundable.
    -- Strictly greater than, matching cancelBooking()'s `diffHours > 24`.
    is_refund := hours_notice > 24;
    if not is_refund then
      note := 'Booking cancelled by Customer — Non-refundable (within 24h cutoff)';
    elsif is_online then
      note := 'Booking cancelled by Customer — Refund due (>24h notice): refund Moyasar payment '
              || b.moyasar_payment_id || ' in the Moyasar dashboard';
    else
      note := 'Booking cancelled by Customer — Refund due (>24h notice): paid at the studio, refund the customer in person';
    end if;
  end if;

  -- One statement, so the status, the refund state and the history entry
  -- cannot land apart. 0048: a refund that is due is 'Needs Refund', never
  -- 'Refunded'; otherwise the payment status is kept as it was.
  update public.bookings
     set status         = 'Cancelled',
         payment_status = case when is_refund then 'Needs Refund' else payment_status end,
         timeline       = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                            'time', to_char(now() at time zone 'Asia/Riyadh', 'FMHH12:MI AM'),
                            'action', note
                          ),
         updated_at     = now()
   where id = b.id;

  -- 0048 — staff must return the money; tell them.
  if is_refund then
    refund_amt := case
      when is_online and b.online_amount is not null
        then to_char(b.online_amount, 'FM999999990.00') || ' SAR'
      when b.payment_status = 'Deposit Paid'
        then 'the deposit taken at the studio (booking total '
             || to_char(coalesce(b.total_price, 0), 'FM999999990.00') || ' SAR)'
      else to_char(coalesce(b.total_price, 0), 'FM999999990.00') || ' SAR'
    end;
    insert into public.notifications (id, type, title, message, "timestamp", is_read, highlighted)
    values (
      'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
               || '-' || floor(random() * 1000)::int::text || '-s',
      'staff',
      'Customer cancellation — refund needed',
      'Booking ' || b.id || ' (' || coalesce(b.customer_name, '') || ', ' || coalesce(b.customer_phone, '')
        || ') was cancelled by the customer with more than 24 hours'' notice. Refund '
        || refund_amt
        || case when is_online
             then ' — Moyasar payment ' || b.moyasar_payment_id || ', in the Moyasar dashboard.'
             else ' in person (paid at the studio).'
           end
        || ' Then set the booking to Refunded.',
      now(), false, true
    );
  end if;

  -- Seats go back through the same RPC staff cancellation uses, so there is
  -- one definition of what releasing a seat means.
  perform public.release_booking_seats(b.id);

  -- Queue parity with cancelBooking(): a linked entry that has not been called
  -- or served is cancelled too, or the studio is left expecting someone who
  -- has cancelled. The same states are left alone.
  select * into q from public.queue
   where booking_id = b.id
     and status not in ('Completed', 'In Progress', 'Called')
   limit 1;

  if q.id is not null then
    update public.queue
       set status     = 'Cancelled',
           history    = coalesce(history, '[]'::jsonb) || jsonb_build_object(
                          'status', 'Cancelled',
                          'timestamp', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                        ),
           updated_at = now()
     where id = q.id;
  end if;

  -- In-app notification, written here rather than by the client — see the
  -- header comment for why. Wording mirrors notifyBookingCancellation()
  -- (AppContext.tsx) exactly, so a customer sees the same message regardless
  -- of who triggered the cancellation.
  insert into public.notifications (
    id, type, customer_id, customer_phone, title, message, "timestamp", is_read, highlighted
  ) values (
    'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
             || '-' || floor(random() * 1000)::int::text,
    'customer',
    b.customer_id,
    b.customer_phone,
    'Booking Cancelled',
    case
      -- 0048: a refund is due, not done — staff return the money.
      when is_refund
        then 'Your booking for "' || b.workshop_title || '" on '
               || to_char(b.date, 'FMMonth FMDD, YYYY') || ' has been cancelled. The studio will refund your payment.'
      -- 0046 / 0048: nothing was paid, so no refund wording at all.
      when is_hold or not is_paid
        then 'Your unpaid booking for "' || b.workshop_title || '" on '
               || to_char(b.date, 'FMMonth FMDD, YYYY') || ' has been cancelled. Nothing was charged.'
      else 'Your booking for "' || b.workshop_title || '" on '
             || to_char(b.date, 'FMMonth FMDD, YYYY')
             || ' has been cancelled. Per our cancellation policy, this booking was not eligible '
             || 'for a refund. Please contact Arty Café with any questions.'
    end,
    now(),
    false,
    false
  );

  return query select true, 'cancelled', null::text, is_refund;
end;
$$;

-- -----------------------------------------------------------------------------
-- The backstop.
-- SECURITY DEFINER so it can call online_payments_config() (revoked from the
-- API roles) and is_staff(). It reads nothing from the row except to check it.
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

revoke all on function public.bookings_online_payment_guard() from public, anon, authenticated;

drop trigger if exists bookings_online_payment_guard on public.bookings;
create trigger bookings_online_payment_guard
  before insert on public.bookings
  for each row execute function public.bookings_online_payment_guard();

-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  exists (select 1 from pg_trigger
           where tgname = 'bookings_online_payment_guard'
             and tgrelid = 'public.bookings'::regclass
             and not tgisinternal and tgenabled = 'O') as guard_trigger,
  (select prosecdef from pg_proc where oid = 'public.bookings_online_payment_guard()'::regprocedure) as guard_security_definer,
  not has_function_privilege('authenticated', 'public.bookings_online_payment_guard()', 'execute') as guard_not_callable,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%online_payment_terms%' as seats_still_0046,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%0048 — a non-staff booking is filed%' as seats_0048,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%current_customer_id()%' as seats_0044_kept,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%online_payment_terms%' as birthday_still_0046,
  has_function_privilege('anon', 'public.book_session_seats(jsonb,text)', 'execute') as seats_anon,
  has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute') as birthday_authenticated,
  pg_get_functiondef('public.cancel_own_booking(text)'::regprocedure) like '%nothing was paid, nothing to refund%' as cancel_0048,
  pg_get_functiondef('public.cancel_own_booking(text)'::regprocedure) not like '%then ''Refunded''%' as cancel_never_refunded,
  has_function_privilege('authenticated', 'public.cancel_own_booking(text)', 'execute') as cancel_authenticated;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0048 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0048-* ids. The test sets onlinePayments
-- inside its own transaction; the rollback puts the live value back.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_err    text;
  v_count  int;
  r        record;
  c_cust   constant text := '{"sub":"00000000-0000-4000-8000-0000000048a1","role":"authenticated"}';
  c_staff  constant text := '{"sub":"00000000-0000-4000-8000-0000000048c1","role":"authenticated"}';
  -- What an ordinary website checkout sends for a pay-at-studio booking.
  v_web    jsonb := jsonb_build_object(
    'customer_name', 'Customer 0048', 'customer_phone', '+966500000948',
    'workshop_id', 'TEST-0048-W', 'session_id', 'TEST-0048-S', 'workshop_title', 'Test 0048 workshop',
    'date', '2099-04-01', 'time', '10:00', 'participants', 2,
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Unpaid', 'total_price', 300);
  -- Everything a tampering browser might send instead.
  v_forged jsonb := jsonb_build_object(
    'status', 'Completed', 'payment_status', 'Paid', 'total_price', 1, 'source', 'Walk-in',
    'customer_id', 'TEST-0048-OTHER',
    'payment_mode', 'full', 'online_amount', 1, 'online_amount_halalas', 100,
    'payment_expires_at', '2100-01-01T00:00:00Z',
    'moyasar_payment_id', 'forged-0048', 'paid_at', '2099-01-01T00:00:00Z');
  v_bday   jsonb := jsonb_build_object(
    'customer_name', 'Customer 0048', 'customer_phone', '+966500000948',
    'workshop_id', 'birthday-party-event', 'workshop_title', 'Birthday Party',
    'date', '2099-04-02', 'time', '4:00 PM', 'participants', 10,
    'birthday_details', jsonb_build_object('packageId', 'TEST-0048-PKG'),
    'source', 'Website', 'status', 'Pending', 'payment_status', 'Unpaid', 'total_price', 1200);
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000048a1', 'authenticated', 'authenticated', now(), now()), -- A: customer
    ('00000000-0000-4000-8000-0000000048c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0048-A', '00000000-0000-4000-8000-0000000048a1', 'Customer A', '+966500000948', '+966500000948', '500000948', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0048-STAFF', '00000000-0000-4000-8000-0000000048c1', 'Staff 0048', true, 'Active');
  INSERT INTO public.workshops (id, title, price, pricing_type) VALUES
    ('TEST-0048-W',  'Test 0048 workshop', 150, 'Per person'),
    ('TEST-0048-W2', 'Test 0048 cheap',     60, 'Per person');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0048-S',  'TEST-0048-W',  '2099-04-01', '10:00', 50),
    ('TEST-0048-S2', 'TEST-0048-W2', '2099-04-01', '12:00', 50);
  INSERT INTO public.birthday_packages (id, name, price, pricing_type, status) VALUES
    ('TEST-0048-PKG',   'Test 0048 package', 120, 'Per child',   'Published'),
    ('TEST-0048-FIXED', 'Test 0048 fixed',  1500, 'Fixed price', 'Published');

  -- A known setting, OFF (rolled back at the end).
  INSERT INTO public.app_settings (id, value) VALUES ('onlinePayments',
    '{"enabled": false, "holdMinutes": 15, "workshop": {"mode": "deposit", "depositAmount": 100}, "birthday": {"mode": "full"}}')
  ON CONFLICT (id) DO UPDATE SET value = excluded.value;

  -- 0. The backstop trigger is installed.
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bookings_online_payment_guard'
                   AND tgrelid = 'public.bookings'::regclass AND tgenabled = 'O'),
    'Case 0: bookings_online_payment_guard trigger missing or disabled';

  -- 1. Customer + payments OFF: a normal pay-at-studio booking, as today.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0048-1"}', 'TEST-0048-S');
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0048-1b"}');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-1';
  ASSERT r.status = 'Pending' AND r.payment_status = 'Unpaid' AND r.total_price = 300
         AND r.payment_mode IS NULL AND r.online_amount IS NULL AND r.payment_expires_at IS NULL,
    format('Case 1 off: expected a normal Unpaid booking with no hold, got %s / %s / %s / %s / %s',
           r.status, r.payment_status, r.total_price, r.payment_mode, r.payment_expires_at);
  ASSERT r.customer_id = 'TEST-0048-A', format('Case 1 off: filed under A, got %s', r.customer_id);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-1b';
  ASSERT r.payment_status = 'Unpaid' AND r.payment_mode IS NULL AND r.payment_expires_at IS NULL,
    format('Case 1 off birthday: expected Unpaid, no hold, got %s / %s', r.payment_status, r.payment_mode);

  -- Payments ON for the rest of the test.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';

  -- 2. Customer + payments ON, ordinary website payload -> forced hold.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0048-2"}', 'TEST-0048-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-2';
  ASSERT r.status = 'Pending' AND r.payment_status = 'Awaiting Payment',
    format('Case 2: expected Pending / Awaiting Payment, got %s / %s', r.status, r.payment_status);
  ASSERT r.total_price = 300 AND r.payment_mode = 'deposit' AND r.online_amount = 100 AND r.online_amount_halalas = 10000,
    format('Case 2: expected 300 total, deposit 100 / 10000, got %s %s %s %s', r.total_price, r.payment_mode, r.online_amount, r.online_amount_halalas);
  ASSERT r.payment_expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes',
    format('Case 2: expected a 15 minute hold, got %s', r.payment_expires_at);

  -- 3. Customer + payments ON, FORGED arguments -> still the same forced hold.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  -- 3a. Every payment field forged, session given as the parameter.
  PERFORM public.book_session_seats(v_web || v_forged || '{"id":"TEST-0048-3a"}', 'TEST-0048-S');
  -- 3b. Session only in the payload, parameter NULL.
  PERFORM public.book_session_seats(v_web || v_forged || '{"id":"TEST-0048-3b"}', NULL);
  -- 3c. Parameter points at the cheap session, payload at the dear one: the
  --     row is filed on, and priced from, the session whose seats were
  --     checked (the parameter) — the 0048 session fix.
  PERFORM public.book_session_seats(v_web || v_forged || '{"id":"TEST-0048-3c"}', 'TEST-0048-S2');
  -- 3d. Birthday with forged fields and p_allow_override = true.
  PERFORM public.book_birthday_slot(v_bday || v_forged || '{"id":"TEST-0048-3d"}', true);
  -- 3e. payment_status already claiming to be a hold, with a 1 SAR amount.
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0048-3e","payment_status":"Awaiting Payment","online_amount":1,"online_amount_halalas":100,"payment_mode":"deposit"}', 'TEST-0048-S');
  PERFORM set_config('role', v_editor, true);

  FOR r IN SELECT * FROM public.bookings WHERE id IN ('TEST-0048-3a','TEST-0048-3b','TEST-0048-3c','TEST-0048-3d','TEST-0048-3e') LOOP
    ASSERT r.status = 'Pending' AND r.payment_status = 'Awaiting Payment',
      format('Case 3 %s: expected Pending / Awaiting Payment, got %s / %s', r.id, r.status, r.payment_status);
    ASSERT r.moyasar_payment_id IS NULL AND r.paid_at IS NULL,
      format('Case 3 %s: forged payment id / paid_at must be dropped', r.id);
    ASSERT r.payment_expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes',
      format('Case 3 %s: forged expiry must be replaced by a 15 minute hold, got %s', r.id, r.payment_expires_at);
    ASSERT r.online_amount_halalas = round(r.online_amount * 100)::int,
      format('Case 3 %s: halalas must match the amount, got %s / %s', r.id, r.online_amount, r.online_amount_halalas);
    ASSERT r.customer_id = 'TEST-0048-A',
      format('Case 3 %s: forged customer_id must be replaced by A, got %s', r.id, r.customer_id);
  END LOOP;
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0048-3a','TEST-0048-3b','TEST-0048-3c','TEST-0048-3d','TEST-0048-3e');
  ASSERT v_count = 5, format('Case 3: expected 5 bookings, got %s', v_count);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3a';
  ASSERT r.total_price = 300 AND r.payment_mode = 'deposit' AND r.online_amount = 100,
    format('Case 3a: expected 300 / deposit / 100, got %s / %s / %s', r.total_price, r.payment_mode, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3b';
  ASSERT r.total_price = 300 AND r.online_amount = 100,
    format('Case 3b: expected 300 / 100, got %s / %s', r.total_price, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3c';
  ASSERT r.session_id = 'TEST-0048-S2' AND r.total_price = 120 AND r.online_amount = 100,
    format('Case 3c: filed on and priced from S2 (60 x 2 = 120, deposit 100), got %s / %s / %s', r.session_id, r.total_price, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3b';
  ASSERT r.session_id = 'TEST-0048-S', format('Case 3b: filed on S, got %s', r.session_id);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3d';
  ASSERT r.payment_mode = 'full' AND r.total_price = 1200 AND r.online_amount = 1200 AND r.online_amount_halalas = 120000,
    format('Case 3d: expected full 1200 / 120000, got %s %s %s %s', r.payment_mode, r.total_price, r.online_amount, r.online_amount_halalas);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-3e';
  ASSERT r.online_amount = 100 AND r.online_amount_halalas = 10000,
    format('Case 3e: a forged 1 SAR hold must be repriced to 100, got %s / %s', r.online_amount, r.online_amount_halalas);

  -- 4. Amounts: workshop deposit and birthday full price.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  -- 4a. Deposit never exceeds the price: 60 SAR x 1 -> 60.
  PERFORM public.book_session_seats((v_web - 'participants') || '{"id":"TEST-0048-4a","participants":1,"session_id":"TEST-0048-S2"}', 'TEST-0048-S2');
  -- 4b. Birthday Per child: 120 x 10 = 1200, full.
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0048-4b","date":"2099-04-03"}');
  -- 4c. Birthday Fixed price: 1500, full.
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0048-4c","date":"2099-04-04","birthday_details":{"packageId":"TEST-0048-FIXED"}}');
  PERFORM set_config('role', v_editor, true);
  -- 4d. The deposit follows the setting: 75 SAR.
  UPDATE public.app_settings SET value = jsonb_set(value, '{workshop,depositAmount}', '75') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0048-4d"}', 'TEST-0048-S');
  PERFORM set_config('role', v_editor, true);
  UPDATE public.app_settings SET value = jsonb_set(value, '{workshop,depositAmount}', '100') WHERE id = 'onlinePayments';

  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-4a';
  ASSERT r.payment_mode = 'deposit' AND r.total_price = 60 AND r.online_amount = 60 AND r.online_amount_halalas = 6000,
    format('Case 4a: 60 SAR workshop must charge 60, got %s %s %s %s', r.payment_mode, r.total_price, r.online_amount, r.online_amount_halalas);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-4b';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.payment_mode = 'full' AND r.total_price = 1200 AND r.online_amount_halalas = 120000,
    format('Case 4b: expected full 1200, got %s %s %s %s', r.payment_status, r.payment_mode, r.total_price, r.online_amount_halalas);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-4c';
  ASSERT r.payment_mode = 'full' AND r.total_price = 1500 AND r.online_amount = 1500,
    format('Case 4c: Fixed price package must charge 1500, got %s / %s', r.total_price, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-4d';
  ASSERT r.total_price = 300 AND r.online_amount = 75 AND r.online_amount_halalas = 7500,
    format('Case 4d: deposit setting 75 must charge 75, got %s / %s', r.online_amount, r.online_amount_halalas);

  -- 5. A signed-out guest + payments ON -> forced hold too.
  --    Every forged payment field, but not customer_id: 0044 replaces it only
  --    for a SIGNED-IN customer (auth.uid() not null); a guest's customer_id
  --    is kept by design, so the forged TEST-0048-OTHER (no such customer)
  --    would just fail the foreign key. Case 3 covers the signed-in case.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM public.book_session_seats(v_web || (v_forged - 'customer_id') || '{"id":"TEST-0048-5"}', 'TEST-0048-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-5';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.online_amount = 100 AND r.moyasar_payment_id IS NULL,
    format('Case 5 guest: expected a 100 SAR hold, got %s / %s', r.payment_status, r.online_amount);

  -- 6. Staff + payments ON -> a staff booking, exactly as today.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  -- 6a. Pay-at-studio booking from the console.
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0048-6a","source":"Admin"}', 'TEST-0048-S');
  -- 6b. Walk-in marked Paid at the desk.
  PERFORM public.book_session_seats((v_web - 'source' - 'payment_status') || '{"id":"TEST-0048-6b","source":"Walk-in","payment_status":"Paid"}', 'TEST-0048-S');
  -- 6d. Staff session mismatch: written as sent, as today.
  PERFORM public.book_session_seats((v_web - 'source') || '{"id":"TEST-0048-6d","source":"Admin"}', 'TEST-0048-S2');
  -- 6c. Birthday with override, as sent.
  PERFORM public.book_birthday_slot((v_bday - 'source') || '{"id":"TEST-0048-6c","source":"Admin","date":"2099-04-05"}', true);
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-6a';
  ASSERT r.payment_status = 'Unpaid' AND r.total_price = 300 AND r.payment_mode IS NULL AND r.payment_expires_at IS NULL,
    format('Case 6a staff: expected Unpaid / 300 / no hold, got %s / %s / %s / %s', r.payment_status, r.total_price, r.payment_mode, r.payment_expires_at);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-6b';
  ASSERT r.payment_status = 'Paid' AND r.source = 'Walk-in' AND r.payment_expires_at IS NULL,
    format('Case 6b staff walk-in: expected Paid, got %s / %s', r.payment_status, r.source);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-6d';
  ASSERT r.session_id = 'TEST-0048-S' AND r.payment_status = 'Unpaid',
    format('Case 6d staff: payload written as sent, got %s / %s', r.session_id, r.payment_status);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-6c';
  ASSERT r.payment_status = 'Unpaid' AND r.total_price = 1200 AND r.payment_mode IS NULL,
    format('Case 6c staff birthday: expected Unpaid / 1200, got %s / %s', r.payment_status, r.total_price);

  -- 7. The backstop on its own. A stand-in for a future insert path that
  --    forgot the 0046 block: a SECURITY DEFINER function (like the booking
  --    RPCs) that inserts whatever it is given. This also proves the trigger
  --    sees the website caller from inside a SECURITY DEFINER function.
  CREATE FUNCTION public.test_0048_raw_insert(p jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public
    AS $f$ INSERT INTO public.bookings SELECT * FROM jsonb_populate_record(null::public.bookings, p) $f$;
  GRANT EXECUTE ON FUNCTION public.test_0048_raw_insert(jsonb) TO anon, authenticated;

  -- 7a. Customer, ON, unpaid row -> refused.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7a","customer_id":"TEST-0048-A","timeline":[],"created_at":"2099-01-01T00:00:00Z"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%must be paid online%', format('Case 7a: an unpaid customer row must be refused by the trigger, got %s', coalesce(v_err, 'no error'));
  -- 7b. Customer, ON, a hand-made "hold" that claims to be paid -> refused.
  BEGIN
    PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7b","timeline":[],"created_at":"2099-01-01T00:00:00Z","payment_status":"Awaiting Payment","payment_mode":"deposit","online_amount":100,"online_amount_halalas":10000}'::jsonb
                                         || jsonb_build_object('payment_expires_at', now() + interval '10 minutes', 'moyasar_payment_id', 'forged'));
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%must be paid online%', format('Case 7b: a hold with a payment id must be refused, got %s', coalesce(v_err, 'no error'));
  -- 7c. Customer, ON, a hold with a day-long expiry -> refused.
  BEGIN
    PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7c","timeline":[],"created_at":"2099-01-01T00:00:00Z","payment_status":"Awaiting Payment","payment_mode":"deposit","online_amount":100,"online_amount_halalas":10000}'::jsonb
                                         || jsonb_build_object('payment_expires_at', now() + interval '1 day'));
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%must be paid online%', format('Case 7c: a hold longer than holdMinutes must be refused, got %s', coalesce(v_err, 'no error'));
  -- 7d. Guest, ON, unpaid row -> refused.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7d","timeline":[],"created_at":"2099-01-01T00:00:00Z"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%must be paid online%', format('Case 7d: an unpaid guest row must be refused, got %s', coalesce(v_err, 'no error'));
  -- 7e. Staff, ON, unpaid row -> allowed.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7e","timeline":[],"created_at":"2099-01-01T00:00:00Z"}');
  -- 7f. service_role (Edge Functions), ON, unpaid row -> allowed.
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-7f","timeline":[],"created_at":"2099-01-01T00:00:00Z"}');
  -- 7g. The SQL Editor itself (postgres), ON, unpaid row -> allowed.
  PERFORM set_config('role', v_editor, true);
  INSERT INTO public.bookings (id, workshop_title, date, participants, status, payment_status)
  VALUES ('TEST-0048-7g', 'Test 0048 editor', '2099-04-01', 1, 'Pending', 'Unpaid');
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0048-7e', 'TEST-0048-7f', 'TEST-0048-7g');
  ASSERT v_count = 3, format('Case 7e-g: staff / service_role / editor rows must be saved, got %s of 3', v_count);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0048-7a', 'TEST-0048-7b', 'TEST-0048-7c', 'TEST-0048-7d');
  ASSERT v_count = 0, format('Case 7a-d: refused rows must not exist, found %s', v_count);

  -- 8. Payments OFF again: the backstop steps aside, nothing changes.
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM public.test_0048_raw_insert(v_web || '{"id":"TEST-0048-8","customer_id":"TEST-0048-A","timeline":[],"created_at":"2099-01-01T00:00:00Z"}');
  PERFORM public.book_session_seats(v_web || '{"id":"TEST-0048-8b"}', 'TEST-0048-S');
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id IN ('TEST-0048-8', 'TEST-0048-8b') AND payment_status = 'Unpaid' AND payment_expires_at IS NULL;
  ASSERT v_count = 2, format('Case 8 off: unpaid customer rows must be saved as before, got %s of 2', v_count);

  -- 9. A customer still cannot insert into bookings directly (no INSERT policy).
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    INSERT INTO public.bookings (id, customer_id, workshop_title, date, participants, status, payment_status)
    VALUES ('TEST-0048-9', 'TEST-0048-A', 'Test 0048 direct', '2099-04-01', 1, 'Pending', 'Unpaid');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM set_config('role', v_editor, true);
  ASSERT v_err IS NOT NULL, 'Case 9: a customer direct INSERT must be refused';
  ASSERT NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = 'TEST-0048-9'), 'Case 9: the direct INSERT must not be saved';

  -- 10. cancel_own_booking (0048 rules). Fixtures written as the editor (the
  --     trigger ignores the editor), owned by customer A. "far" starts in
  --     2099 (> 24h notice); "near" starts 3 hours from now (<= 24h).
  DECLARE
    v_near_ts   timestamp := (now() AT TIME ZONE 'Asia/Riyadh') + interval '3 hours';
    v_near_date date := v_near_ts::date;
    v_near_time text := to_char(v_near_ts, 'HH24:MI');
  BEGIN
    INSERT INTO public.bookings (id, customer_id, customer_name, customer_phone, workshop_title, date, time, participants,
                                 total_price, status, payment_status, payment_mode, online_amount, online_amount_halalas,
                                 moyasar_payment_id, paid_at) VALUES
      -- never paid
      ('TEST-0048-C1', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 unpaid far',  '2099-05-01', '10:00', 1, 150, 'Pending', 'Unpaid', NULL, NULL, NULL, NULL, NULL),
      ('TEST-0048-C2', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 unpaid near', v_near_date, v_near_time, 1, 150, 'Pending', 'Unpaid', NULL, NULL, NULL, NULL, NULL),
      -- paid online
      ('TEST-0048-C3', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 deposit far', '2099-05-01', '10:00', 1, 150, 'Pending', 'Deposit Paid', 'deposit', 100, 10000, 'pay-0048-c3', now()),
      ('TEST-0048-C4', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 full far',    '2099-05-01', '10:00', 10, 1200, 'Pending', 'Paid', 'full', 1200, 120000, 'pay-0048-c4', now()),
      ('TEST-0048-C5', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 full near',   v_near_date, v_near_time, 10, 1200, 'Pending', 'Paid', 'full', 1200, 120000, 'pay-0048-c5', now()),
      -- paid at the studio (marked by staff, no online payment)
      ('TEST-0048-C6', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 studio paid far',    '2099-05-01', '10:00', 1, 150, 'Pending', 'Paid', NULL, NULL, NULL, NULL, NULL),
      ('TEST-0048-C7', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 studio deposit far', '2099-05-01', '10:00', 1, 500, 'Pending', 'Deposit Paid', NULL, NULL, NULL, NULL, NULL),
      ('TEST-0048-C8', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 studio paid near',   v_near_date, v_near_time, 1, 150, 'Pending', 'Paid', NULL, NULL, NULL, NULL, NULL),
      -- unpaid online hold
      ('TEST-0048-C9', 'TEST-0048-A', 'Customer A', '+966500000948', 'Test 0048 hold far',    '2099-05-01', '10:00', 1, 150, 'Pending', 'Awaiting Payment', 'deposit', 100, 10000, NULL, NULL);
    UPDATE public.bookings SET payment_expires_at = now() + interval '10 minutes' WHERE id = 'TEST-0048-C9';

    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', c_cust, true);
    FOR r IN SELECT x.id, c.success, c.refunded, c.code
               FROM (VALUES ('TEST-0048-C1'), ('TEST-0048-C2'), ('TEST-0048-C3'), ('TEST-0048-C4'), ('TEST-0048-C5'),
                            ('TEST-0048-C6'), ('TEST-0048-C7'), ('TEST-0048-C8'), ('TEST-0048-C9')) AS x(id)
               CROSS JOIN LATERAL public.cancel_own_booking(x.id) c LOOP
      ASSERT r.success, format('Case 10 %s: cancel should succeed, got %s', r.id, r.code);
      ASSERT r.refunded = (r.id IN ('TEST-0048-C4', 'TEST-0048-C6', 'TEST-0048-C7')),
        format('Case 10 %s: refunded (= refund due) should be %s, got %s', r.id, r.id IN ('TEST-0048-C4', 'TEST-0048-C6', 'TEST-0048-C7'), r.refunded);
    END LOOP;
    PERFORM set_config('role', v_editor, true);
  END;

  SELECT count(*) INTO v_count FROM public.bookings WHERE id LIKE 'TEST-0048-C%' AND status = 'Cancelled';
  ASSERT v_count = 9, format('Case 10: all 9 bookings should be Cancelled, got %s', v_count);
  SELECT count(*) INTO v_count FROM public.bookings WHERE id LIKE 'TEST-0048-C%' AND payment_status = 'Refunded';
  ASSERT v_count = 0, format('Case 10: a customer cancellation must never write Refunded, got %s', v_count);

  -- 10a/b. Never paid, any notice -> stays Unpaid, no refund recorded.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C1';
  ASSERT r.payment_status = 'Unpaid' AND (r.timeline->-1->>'action') LIKE '%nothing was paid%',
    format('Case 10a unpaid far: expected Unpaid / nothing was paid, got %s / %s', r.payment_status, r.timeline->-1->>'action');
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C2';
  ASSERT r.payment_status = 'Unpaid', format('Case 10b unpaid near: expected Unpaid, got %s', r.payment_status);
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE type = 'customer' AND customer_id = 'TEST-0048-A' AND message LIKE '%Test 0048 unpaid%'
     AND message LIKE '%Your unpaid booking%Nothing was charged.' AND message NOT ILIKE '%refund%';
  ASSERT v_count = 2, format('Case 10a/b: expected 2 "unpaid ... Nothing was charged" notices with no refund wording, got %s', v_count);

  -- 10c. Online deposit -> never refunded (0046 rule).
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C3';
  ASSERT r.payment_status = 'Deposit Paid' AND (r.timeline->-1->>'action') LIKE '%Non-refundable deposit%',
    format('Case 10c online deposit: expected Deposit Paid, got %s', r.payment_status);

  -- 10d. Online full payment, > 24h -> Needs Refund, staff told the Moyasar payment.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C4';
  ASSERT r.payment_status = 'Needs Refund' AND (r.timeline->-1->>'action') LIKE '%pay-0048-c4%Moyasar dashboard%',
    format('Case 10d online full far: expected Needs Refund + Moyasar note, got %s / %s', r.payment_status, r.timeline->-1->>'action');
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE type = 'staff' AND message LIKE '%TEST-0048-C4%' AND message LIKE '%1200.00 SAR%pay-0048-c4%';
  ASSERT v_count = 1, format('Case 10d: expected one staff refund notice naming 1200.00 SAR and the payment, got %s', v_count);
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE type = 'customer' AND message LIKE '%Test 0048 full far%will refund your payment.' AND message NOT LIKE '%has been refunded%';
  ASSERT v_count = 1, format('Case 10d: customer notice must say the refund is coming, not done; got %s', v_count);

  -- 10e. Online full payment, <= 24h -> non-refundable, stays Paid.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C5';
  ASSERT r.payment_status = 'Paid' AND (r.timeline->-1->>'action') LIKE '%within 24h%',
    format('Case 10e online full near: expected Paid / within 24h, got %s', r.payment_status);

  -- 10f/g. Paid at the studio, > 24h -> Needs Refund (in person), staff told.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C6';
  ASSERT r.payment_status = 'Needs Refund' AND (r.timeline->-1->>'action') LIKE '%in person%',
    format('Case 10f studio Paid far: expected Needs Refund / in person, got %s / %s', r.payment_status, r.timeline->-1->>'action');
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C7';
  ASSERT r.payment_status = 'Needs Refund', format('Case 10g studio Deposit Paid far: expected Needs Refund, got %s', r.payment_status);
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE type = 'staff' AND message LIKE '%in person (paid at the studio)%'
     AND (message LIKE '%TEST-0048-C6%150.00 SAR%' OR message LIKE '%TEST-0048-C7%deposit taken at the studio%');
  ASSERT v_count = 2, format('Case 10f/g: expected two in-person staff refund notices, got %s', v_count);

  -- 10h. Paid at the studio, <= 24h -> non-refundable, stays Paid.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C8';
  ASSERT r.payment_status = 'Paid', format('Case 10h studio Paid near: expected Paid, got %s', r.payment_status);

  -- 10i. Unpaid online hold -> 0046 unchanged.
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0048-C9';
  ASSERT r.payment_status = 'Awaiting Payment' AND (r.timeline->-1->>'action') LIKE '%hold cancelled%',
    format('Case 10i hold: expected Awaiting Payment / hold cancelled, got %s', r.payment_status);

  -- 10j. No staff refund notice for anything that was not refundable.
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE type = 'staff' AND title = 'Customer cancellation — refund needed'
     AND message ~ 'TEST-0048-C[123589]';
  ASSERT v_count = 0, format('Case 10j: no refund notice for unpaid / deposit / <=24h / hold bookings, got %s', v_count);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0048 TESTS PASSED — rolled back';
END $$;
*/
