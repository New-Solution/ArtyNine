-- STATUS: NOT APPLIED
-- =============================================================================
-- 0046 — ONLINE PAYMENTS (MOYASAR): HOLD, VERIFY, CONFIRM
--
-- Run after 0045_piece_stage_id.sql. Requires 0044 (booking customer guard)
-- and 0031 (cancel_own_booking notification) to be the live definitions; the
-- pre-flight block checks both.
--
-- THE PROBLEM
-- 1. book_session_seats() and book_birthday_slot() run as SECURITY DEFINER,
--    are executable by anon and authenticated, and insert whatever
--    payment_status, status and total_price the browser sends. Any visitor can
--    write a "Paid" booking for 0 SAR. The checkout's "payment" is an 800ms
--    timer (CheckoutPaymentSection.tsx) that then claims Paid.
-- 2. There is nowhere to record a real payment, nothing ties a payment to one
--    booking, and nothing lets a seat be held while the customer pays.
--
-- THE MODEL
-- One setting, app_settings id 'onlinePayments' (seeded below, enabled=false):
--   { "enabled": false, "holdMinutes": 15,
--     "workshop": { "mode": "deposit", "depositAmount": 100 },
--     "birthday": { "mode": "full" } }
-- mode 'deposit' charges min(depositAmount, full price) online and is never
-- refunded on a customer cancellation. mode 'full' charges the full price and
-- keeps the existing >24h refund rule (the money itself is refunded by staff in
-- the Moyasar dashboard).
--
-- While "enabled" is FALSE every booking behaves exactly as it does today,
-- except that a non-staff caller can no longer set the new payment columns
-- (moyasar_payment_id, paid_at, ...). Turning it on is the single switch:
--
--   For a NON-STAFF caller (anon or a signed-in customer) both booking RPCs now
--   - ignore the payload's status / payment_status / total_price,
--   - compute the full price from the database (workshop price and pricing
--     type via the session's workshop; birthday package price and pricing
--     type via birthday_details.packageId),
--   - write status 'Pending', payment_status 'Awaiting Payment', payment_mode,
--     online_amount (+ halalas) and payment_expires_at = now() + holdMinutes.
--   Staff (is_staff()) are unchanged: walk-ins, admin bookings and the health
--   tests keep writing what they send.
--
--   An 'Awaiting Payment' booking holds its seat / birthday slot until
--   payment_expires_at. After that it stops counting immediately (seat counts
--   below ignore it), whether or not the auto-cancel job has run yet; the job
--   then marks it status 'Cancelled', payment_status 'Expired'.
--
--   Only the verify-payment Edge Function (service role) can mark a booking
--   paid, through confirm_booking_payment(), after fetching the payment from
--   Moyasar with the secret key. It checks currency, the exact amount in
--   halalas, and that the payment is not already used. A payment that arrives
--   after the hold expired is accepted if the place is still free, otherwise
--   the booking becomes 'Needs Refund' and staff are notified.
--
-- WHAT THIS ADDS / CHANGES
--   bookings: payment_mode, online_amount, online_amount_halalas,
--             payment_expires_at, moyasar_payment_id (unique when set), paid_at
--   booking_payments: every Moyasar payment seen (staff read, service-role write)
--   app_settings 'onlinePayments' row (insert only if missing)
--   online_payments_config()        normalised setting (internal)
--   online_payment_terms(jsonb,bool) price + amount due online (internal)
--   book_session_seats / book_birthday_slot   0044 + the "0046" blocks
--   session_seats_taken / birthday_booking_counts   ignore expired holds
--   confirm_booking_payment(...)    service_role only
--   booking_payment_quote(text)     amount + expiry of a held booking, for the
--                                   payment step (anon/authenticated)
--   cancel_own_booking              deposit never refunded; an unpaid hold is
--                                   cancelled without refund wording
--
-- WHAT IS NOT CHANGED
--   RLS on bookings: customers still have SELECT only on their own rows, no
--   UPDATE. Every payment write is a SECURITY DEFINER function the customer
--   cannot reach, or the service role.
--   Signatures and grants of the existing functions (create or replace keeps
--   the ACL; the verification query checks it).
--
-- DEPLOY ORDER
--   1. Apply this file (enabled stays false: no visible change).
--   2. Set MOYASAR_SECRET_KEY, deploy verify-payment and auto-cancel-bookings.
--   3. Ship the checkout front end (commit 6+), then set enabled=true in
--      Settings -> Online Payments.
--   Setting enabled=true BEFORE the front end ships would leave every online
--   booking 'Awaiting Payment' with no way to pay, and the job would expire it.
-- =============================================================================

-- Pre-flight: the live functions are the versions this file was written from.
do $$
begin
  if to_regprocedure('public.book_session_seats(jsonb,text)') is null
     or to_regprocedure('public.book_birthday_slot(jsonb,boolean)') is null
     or to_regprocedure('public.cancel_own_booking(text)') is null
     or to_regprocedure('public.session_seats_taken(text)') is null
     or to_regprocedure('public.birthday_booking_counts(date[],text)') is null
     or to_regprocedure('public.current_customer_id()') is null
     or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.booking_start_at(date,text)') is null
     or to_regprocedure('public.release_booking_seats(text)') is null then
    raise exception '0046 aborted: an expected function is missing';
  end if;

  -- 0044's guard text is kept verbatim below, so these also pass on a re-run.
  if pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
       not like '%current_customer_id()%'
     or pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure)
       not like '%current_customer_id()%' then
    raise exception '0046 aborted: the live booking functions are not the 0044 version — compare them before applying';
  end if;

  if pg_get_functiondef('public.cancel_own_booking(text)'::regprocedure)
       not like '%Refund issued (>24h notice)%' then
    raise exception '0046 aborted: the live cancel_own_booking is not the 0031 version — compare it before applying';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
alter table public.bookings
  add column if not exists payment_mode          text,
  add column if not exists online_amount         numeric(10,2),
  add column if not exists online_amount_halalas integer,
  add column if not exists payment_expires_at    timestamptz,
  add column if not exists moyasar_payment_id    text,
  add column if not exists paid_at               timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_mode_valid') then
    alter table public.bookings
      add constraint bookings_payment_mode_valid
      check (payment_mode is null or payment_mode in ('deposit', 'full'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_online_amount_halalas_positive') then
    alter table public.bookings
      add constraint bookings_online_amount_halalas_positive
      check (online_amount_halalas is null or online_amount_halalas > 0);
  end if;
end $$;

-- One Moyasar payment can pay for one booking, ever.
create unique index if not exists bookings_moyasar_payment_id_key
  on public.bookings (moyasar_payment_id) where moyasar_payment_id is not null;

-- The auto-cancel job's expiry scan.
create index if not exists bookings_awaiting_payment_idx
  on public.bookings (payment_expires_at) where payment_status = 'Awaiting Payment';

-- -----------------------------------------------------------------------------
-- booking_payments — every payment the system has seen, paid or not.
-- A booking can have several attempts (a declined card, then a good one).
-- Written only by the service role (verify-payment, auto-cancel-bookings).
-- -----------------------------------------------------------------------------
create table if not exists public.booking_payments (
  id             text primary key,            -- Moyasar payment id (uuid)
  booking_id     text references public.bookings(id) on delete set null,
  status         text not null,               -- Moyasar's status, as fetched
  amount_halalas integer,
  currency       text,
  source_type    text,                        -- creditcard | applepay | stcpay | ...
  message        text,                        -- Moyasar's decline/approval message
  outcome        text,                        -- what confirm_booking_payment decided
  raw            jsonb,                       -- the fetched payment, card data masked by Moyasar
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists booking_payments_booking_idx on public.booking_payments (booking_id);

alter table public.booking_payments enable row level security;

drop policy if exists booking_payments_staff_select on public.booking_payments;
create policy booking_payments_staff_select on public.booking_payments
  for select to authenticated using (public.is_staff());
-- No insert/update/delete policy: nobody but the service role writes here.

-- -----------------------------------------------------------------------------
-- The setting. Inserted only if missing, so a value staff already saved wins.
-- -----------------------------------------------------------------------------
insert into public.app_settings (id, value)
values (
  'onlinePayments',
  '{"enabled": false, "holdMinutes": 15,
    "workshop": {"mode": "deposit", "depositAmount": 100},
    "birthday": {"mode": "full"}}'::jsonb
)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- online_payments_config() — the setting, normalised.
--
-- Every field is type-checked rather than cast, so a malformed value saved by
-- hand falls back to its default instead of making every booking fail.
-- Defaults are the ones above and src/types.ts DEFAULT_ONLINE_PAYMENTS; keep
-- them in step.
-- -----------------------------------------------------------------------------
create or replace function public.online_payments_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v       jsonb;
  v_hold  integer := 15;
  v_out   jsonb;
  k       text;
  v_kind  jsonb;
  v_mode  text;
  v_dep   numeric;
begin
  select s.value into v from public.app_settings s where s.id = 'onlinePayments';
  v := coalesce(v, '{}'::jsonb);

  if jsonb_typeof(v->'holdMinutes') = 'number' then
    v_hold := least(greatest(floor((v->>'holdMinutes')::numeric)::integer, 5), 120);
  end if;

  v_out := jsonb_build_object(
    'enabled',     coalesce(jsonb_typeof(v->'enabled') = 'boolean' and (v->>'enabled')::boolean, false),
    'holdMinutes', v_hold
  );

  foreach k in array array['workshop', 'birthday'] loop
    v_kind := case when jsonb_typeof(v->k) = 'object' then v->k else '{}'::jsonb end;
    v_mode := case
      when v_kind->>'mode' in ('deposit', 'full') then v_kind->>'mode'
      when k = 'workshop' then 'deposit'
      else 'full'
    end;
    v_dep := case
      when jsonb_typeof(v_kind->'depositAmount') = 'number' and (v_kind->>'depositAmount')::numeric >= 1
        then round((v_kind->>'depositAmount')::numeric, 2)
      else 100
    end;
    v_out := v_out || jsonb_build_object(k, jsonb_build_object('mode', v_mode, 'depositAmount', v_dep));
  end loop;

  return v_out;
end;
$$;

revoke all on function public.online_payments_config() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- online_payment_terms() — what a booking costs and what is due online.
--
-- The full price is computed from the database, never taken from the payload.
-- It mirrors the customer site's own arithmetic:
--   workshop (WorkshopDetailSection.tsx totalPrice):
--     'Per pair'    price * ceil(participants / 2)
--     'Fixed price' price
--     otherwise     price * participants
--   birthday: 'Fixed price' -> price, otherwise price * participants.
--     (BirthdayBookingSection.tsx estimatedTotal currently multiplies every
--     package, including Fixed price ones — the client display is fixed to
--     match in the birthday commit; this is the amount actually charged.)
-- Cake upgrades and extras stay on the studio bill, as today.
-- -----------------------------------------------------------------------------
create or replace function public.online_payment_terms(
  p_booking     jsonb,
  p_is_birthday boolean
)
returns table (payment_mode text, total_price numeric, online_amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg    jsonb := public.online_payments_config();
  v_kind   jsonb;
  v_people integer := greatest(coalesce((p_booking->>'participants')::integer, 1), 1);
  v_price  numeric;
  v_type   text;
  v_total  numeric;
  v_due    numeric;
begin
  if p_is_birthday then
    v_kind := v_cfg->'birthday';

    select bp.price, bp.pricing_type into v_price, v_type
      from public.birthday_packages bp
     where bp.id = p_booking->'birthday_details'->>'packageId'
       and bp.status = 'Published';

    if v_price is null then
      raise exception 'That birthday package is no longer available. Please choose another package.'
        using errcode = 'check_violation';
    end if;

    v_total := case when v_type = 'Fixed price' then v_price else v_price * v_people end;
  else
    v_kind := v_cfg->'workshop';

    -- The session's workshop, not the payload's workshop_id: the session is
    -- what the seat check used, so it is what is being bought.
    select w.price, w.pricing_type into v_price, v_type
      from public.workshop_sessions s
      join public.workshops w on w.id = s.workshop_id
     where s.id = p_booking->>'session_id';

    if v_price is null then
      raise exception 'That session is no longer available'
        using errcode = 'check_violation';
    end if;

    v_total := case
      when v_type = 'Per pair'    then v_price * ceil(v_people / 2.0)
      when v_type = 'Fixed price' then v_price
      else v_price * v_people
    end;
  end if;

  v_total := round(v_total, 2);

  if v_kind->>'mode' = 'deposit' then
    v_due := least((v_kind->>'depositAmount')::numeric, v_total);
  else
    v_due := v_total;
  end if;

  -- Moyasar's minimum is 100 halalas. A free or unpriced item cannot be paid
  -- online; the studio has to set a price (or take the booking at the desk).
  if v_due < 1 then
    raise exception 'This booking cannot be paid online yet. Please contact the studio to book.'
      using errcode = 'check_violation';
  end if;

  return query select (v_kind->>'mode')::text, v_total, round(v_due, 2);
end;
$$;

revoke all on function public.online_payment_terms(jsonb, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Seat counting: an expired hold no longer takes a seat, from the moment it
-- expires. Copied from 0002 with the one added condition and 'expired' in the
-- payment exclusions. Same signature; the grant from 0002 is kept.
-- -----------------------------------------------------------------------------
create or replace function public.session_seats_taken(p_session_id text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select sum(b.participants) from public.bookings b
     where b.session_id = p_session_id
       and lower(coalesce(b.status, '')) not in ('cancelled','auto-cancelled','draft','no show','no-show')
       and lower(coalesce(b.payment_status, '')) not in ('failed','payment failed','declined','draft','expired')
       -- 0046: an unpaid hold past its expiry is released at once.
       and not (b.payment_status = 'Awaiting Payment'
                and b.payment_expires_at is not null
                and b.payment_expires_at <= now())
  ), 0)
  +
  coalesce((
    select sum(q.participants) from public.queue q
     where q.session_id = p_session_id
       and q.booking_id is null
       and lower(coalesce(q.status, '')) not in ('cancelled','completed')
  ), 0);
$$;

-- Copied from 0026 with the same addition.
create or replace function public.birthday_booking_counts(
  p_dates               date[],
  p_exclude_booking_id  text default null
)
returns table (
  booking_date  date,
  booking_time  text,
  party_count   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.date,
    coalesce(b.time, ''),
    count(*)::integer
  from public.bookings b
  where b.date = any(coalesce(p_dates, '{}'::date[]))
    and (
      b.workshop_id = 'birthday-party-event'
      or coalesce(b.workshop_title, '') ilike '%birthday%'
    )
    and lower(coalesce(b.status, '')) not in ('cancelled','auto-cancelled','draft','no show','no-show')
    and lower(coalesce(b.payment_status, '')) not in ('failed','payment failed','declined','draft','expired')
    and not (b.payment_status = 'Awaiting Payment'
             and b.payment_expires_at is not null
             and b.payment_expires_at <= now())
    and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
  group by b.date, coalesce(b.time, '');
$$;

-- -----------------------------------------------------------------------------
-- book_session_seats — 0044 verbatim plus the blocks marked "0046".
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
-- book_birthday_slot — 0044 verbatim plus the blocks marked "0046".
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
-- confirm_booking_payment — the ONLY way a held booking becomes paid.
--
-- Called by the verify-payment Edge Function (and the auto-cancel job's
-- reconciliation) with the service role, AFTER it has fetched the payment from
-- Moyasar with the secret key and seen status 'paid'. The caller passes what
-- Moyasar reported; this function compares it with what the booking is owed.
--
-- Outcomes (first column):
--   confirmed             paid in time; booking is now Deposit Paid / Paid
--   confirmed_late        hold had expired but the place was still free
--   already_confirmed     this payment already confirmed this booking (retry)
--   needs_refund          paid, but the place was gone (or the customer had
--                         cancelled the hold); booking Cancelled + Needs Refund,
--                         staff notified
--   already_paid_other    the booking was already paid by a DIFFERENT payment:
--                         this second payment needs a refund (staff notified)
--   payment_used_elsewhere  this payment id already paid another booking
--   amount_mismatch       wrong currency or amount; nothing changed
--   not_awaiting          booking is not waiting for a payment (e.g. staff
--                         cancelled/refunded it); nothing changed
--   not_found             no such booking
--
-- Safe to call any number of times, concurrently: the booking row is locked,
-- and the unique index on moyasar_payment_id backs the "one payment, one
-- booking" rule.
-- -----------------------------------------------------------------------------
create or replace function public.confirm_booking_payment(
  p_booking_id     text,
  p_payment_id     text,
  p_amount_halalas integer,
  p_currency       text
)
returns table (outcome text, booking_payment_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  c_daily_max  constant integer := 5;   -- book_birthday_slot
  c_slot_max   constant integer := 2;   -- book_birthday_slot

  b            public.bookings%rowtype;
  v_late       boolean;
  v_fits       boolean := true;
  v_capacity   integer;
  v_taken      integer;
  v_on_date    integer;
  v_at_slot    integer;
  v_new_status text;
  v_stamp      text := to_char(now() at time zone 'Asia/Riyadh', 'FMHH12:MI AM');
  v_amount_txt text;
begin
  if p_booking_id is null or btrim(p_booking_id) = ''
     or p_payment_id is null or btrim(p_payment_id) = '' then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if b.moyasar_payment_id = p_payment_id then
    return query select 'already_confirmed'::text, b.payment_status;
    return;
  end if;

  if exists (select 1 from public.bookings x
              where x.moyasar_payment_id = p_payment_id and x.id <> b.id) then
    return query select 'payment_used_elsewhere'::text, b.payment_status;
    return;
  end if;

  v_amount_txt := to_char(coalesce(p_amount_halalas, 0) / 100.0, 'FM999999990.00');

  if b.moyasar_payment_id is not null then
    -- A second successful payment for a booking already paid (two tabs, a
    -- double submit). The booking stays as it is; the money goes back.
    insert into public.notifications (id, type, title, message, "timestamp", is_read, highlighted)
    values (
      'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
               || '-' || floor(random() * 1000)::int::text,
      'staff',
      'Duplicate online payment — refund needed',
      'Booking ' || b.id || ' (' || coalesce(b.customer_name, '') || ') was already paid by Moyasar payment '
        || b.moyasar_payment_id || '. A second payment ' || p_payment_id || ' of ' || v_amount_txt
        || ' SAR was received. Refund it in the Moyasar dashboard.',
      now(), false, true
    );
    return query select 'already_paid_other'::text, b.payment_status;
    return;
  end if;

  if b.payment_status not in ('Awaiting Payment', 'Expired') then
    return query select 'not_awaiting'::text, b.payment_status;
    return;
  end if;

  if upper(coalesce(p_currency, '')) <> 'SAR'
     or b.online_amount_halalas is null
     or p_amount_halalas is distinct from b.online_amount_halalas then
    return query select 'amount_mismatch'::text, b.payment_status;
    return;
  end if;

  -- A hold the customer cancelled themselves is not brought back by a payment
  -- that lands afterwards: they asked for it to be gone.
  if b.payment_status = 'Awaiting Payment' and b.status = 'Cancelled' then
    v_fits := false;
    v_late := true;
  else
    v_late := b.payment_status = 'Expired'
              or b.payment_expires_at is null
              or b.payment_expires_at <= now();
  end if;

  -- Late: the hold no longer counts, so the place must be checked again under
  -- the same locks the booking RPCs take.
  if v_late and v_fits then
    if b.workshop_id = 'birthday-party-event' or coalesce(b.workshop_title, '') ilike '%birthday%' then
      perform pg_advisory_xact_lock(hashtext('birthday_slot:' || b.date::text));
      select
        count(*),
        count(*) filter (where coalesce(x.time, '') = coalesce(b.time, ''))
        into v_on_date, v_at_slot
      from public.bookings x
      where x.date = b.date
        and x.id <> b.id
        and (x.workshop_id = 'birthday-party-event' or coalesce(x.workshop_title, '') ilike '%birthday%')
        and lower(coalesce(x.status, '')) not in ('cancelled','auto-cancelled','draft','no show','no-show')
        and lower(coalesce(x.payment_status, '')) not in ('failed','payment failed','declined','draft','expired')
        and not (x.payment_status = 'Awaiting Payment'
                 and x.payment_expires_at is not null
                 and x.payment_expires_at <= now());
      v_fits := v_on_date < c_daily_max and v_at_slot < c_slot_max;
    elsif b.session_id is not null then
      select s.capacity into v_capacity
        from public.workshop_sessions s where s.id = b.session_id for update;
      -- b itself is not counted: it is Expired/Cancelled or a lapsed hold.
      v_taken := public.session_seats_taken(b.session_id);
      v_fits := v_capacity is not null and v_taken + coalesce(b.participants, 1) <= v_capacity;
    else
      v_fits := false;
    end if;
  end if;

  if not v_fits then
    update public.bookings
       set status             = 'Cancelled',
           payment_status     = 'Needs Refund',
           moyasar_payment_id = p_payment_id,
           paid_at            = now(),
           timeline           = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                                  'time', v_stamp,
                                  'action', 'Online payment of ' || v_amount_txt || ' SAR received after the hold ended and the place was no longer available — refund needed (Moyasar ' || p_payment_id || ')'
                                ),
           updated_at         = now()
     where id = b.id;

    insert into public.notifications (id, type, title, message, "timestamp", is_read, highlighted)
    values (
      'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
               || '-' || floor(random() * 1000)::int::text,
      'staff',
      'Online payment needs a refund',
      'Booking ' || b.id || ' (' || coalesce(b.customer_name, '') || ', ' || coalesce(b.customer_phone, '')
        || ') paid ' || v_amount_txt || ' SAR after its hold ended and the place was no longer available. '
        || 'Refund Moyasar payment ' || p_payment_id || ' in the Moyasar dashboard, or rebook the customer.',
      now(), false, true
    );

    return query select 'needs_refund'::text, 'Needs Refund'::text;
    return;
  end if;

  v_new_status := case when b.payment_mode = 'full' then 'Paid' else 'Deposit Paid' end;

  update public.bookings
     set status             = 'Pending',
         payment_status     = v_new_status,
         moyasar_payment_id = p_payment_id,
         paid_at            = now(),
         timeline           = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                                'time', v_stamp,
                                'action', case when b.payment_mode = 'full'
                                            then 'Online payment confirmed — '
                                            else 'Online deposit confirmed — ' end
                                          || v_amount_txt || ' SAR (Moyasar ' || p_payment_id || ')'
                                          || case when v_late then ' — after the hold ended, place still free' else '' end
                              ),
         updated_at         = now()
   where id = b.id;

  return query select (case when v_late then 'confirmed_late' else 'confirmed' end)::text, v_new_status;
end;
$$;

revoke all on function public.confirm_booking_payment(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.confirm_booking_payment(text, text, integer, text) to service_role;

-- -----------------------------------------------------------------------------
-- booking_payment_quote — what the payment step needs to open the Moyasar form
-- for a booking it has just created. A guest cannot read bookings (RLS), so
-- this returns the minimum: amount, mode and expiry, and only while the
-- booking is an unexpired hold. No name, phone or other personal data.
-- -----------------------------------------------------------------------------
create or replace function public.booking_payment_quote(p_booking_id text)
returns table (
  online_amount_halalas integer,
  online_amount         numeric,
  total_price           numeric,
  payment_mode          text,
  payment_expires_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select b.online_amount_halalas, b.online_amount, b.total_price, b.payment_mode, b.payment_expires_at
    from public.bookings b
   where b.id = p_booking_id
     and b.payment_status = 'Awaiting Payment'
     and b.status = 'Pending'
     and b.payment_expires_at > now();
$$;

revoke all on function public.booking_payment_quote(text) from public;
grant execute on function public.booking_payment_quote(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- cancel_own_booking — 0031 verbatim except the refund decision and the
-- matching note/notification, marked "0046":
--   - an unpaid hold: cancelled, nothing to refund, no refund wording;
--   - payment_mode 'deposit': never refunded (non-refundable deposit);
--   - everything else (payment_mode 'full', and every booking made before
--     online payments): the existing >24h rule. For an online full payment the
--     money is refunded by staff in the Moyasar dashboard; the timeline says so.
-- notify-own-booking keys its SMS off payment_status = 'Refunded', so a deposit
-- cancellation gets the existing notRefunded SMS without any change there.
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

  -- 0046 — the refund decision depends on how the booking was paid.
  is_hold := b.payment_status = 'Awaiting Payment';

  if is_hold then
    is_refund := false;
    note := 'Unpaid booking hold cancelled by Customer — nothing was charged';
  elsif b.payment_mode = 'deposit' then
    is_refund := false;
    note := 'Booking cancelled by Customer — Non-refundable deposit';
  else
    -- The rule the customer is shown: more than 24 hours' notice is refundable.
    -- Strictly greater than, matching cancelBooking()'s `diffHours > 24`.
    is_refund := hours_notice > 24;
    note := case
      when is_refund then 'Booking cancelled by Customer — Refund issued (>24h notice)'
      else 'Booking cancelled by Customer — Non-refundable (within 24h cutoff)'
    end;
    if is_refund and b.moyasar_payment_id is not null then
      note := note || ' — refund Moyasar payment ' || b.moyasar_payment_id || ' in the Moyasar dashboard';
    end if;
  end if;

  -- One statement, so the status, the refund state and the history entry
  -- cannot land apart. A deposit stays a deposit when there is no refund.
  update public.bookings
     set status         = 'Cancelled',
         payment_status = case when is_refund then 'Refunded' else payment_status end,
         timeline       = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                            'time', to_char(now() at time zone 'Asia/Riyadh', 'FMHH12:MI AM'),
                            'action', note
                          ),
         updated_at     = now()
   where id = b.id;

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
    case when is_refund then 'Booking Cancelled — Refunded' else 'Booking Cancelled' end,
    case
      when is_refund
        then 'Your booking for "' || b.workshop_title || '" on '
               || to_char(b.date, 'FMMonth FMDD, YYYY') || ' has been cancelled, and '
               || (b.total_price)::int::text || ' SAR has been refunded. We hope to see you again soon!'
      -- 0046: nothing was paid, so no refund wording at all.
      when is_hold
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
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%online_payment_terms%' as seats_0046,
  pg_get_functiondef('public.book_birthday_slot(jsonb,boolean)'::regprocedure) like '%online_payment_terms%' as birthday_0046,
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)    like '%current_customer_id()%' as seats_0044_kept,
  pg_get_functiondef('public.cancel_own_booking(text)'::regprocedure)          like '%Non-refundable deposit%' as cancel_0046,
  pg_get_functiondef('public.session_seats_taken(text)'::regprocedure)         like '%Awaiting Payment%' as seats_taken_0046,
  has_function_privilege('anon',          'public.book_session_seats(jsonb,text)',    'execute') as seats_anon,
  has_function_privilege('authenticated', 'public.book_birthday_slot(jsonb,boolean)', 'execute') as birthday_authenticated,
  has_function_privilege('authenticated', 'public.cancel_own_booking(text)',          'execute') as cancel_authenticated,
  has_function_privilege('anon',          'public.session_seats_taken(text)',         'execute') as seats_taken_anon,
  has_function_privilege('service_role',  'public.confirm_booking_payment(text,text,integer,text)', 'execute') as confirm_service,
  not has_function_privilege('anon',          'public.confirm_booking_payment(text,text,integer,text)', 'execute') as confirm_not_anon,
  not has_function_privilege('authenticated', 'public.confirm_booking_payment(text,text,integer,text)', 'execute') as confirm_not_authenticated,
  has_function_privilege('anon', 'public.booking_payment_quote(text)', 'execute') as quote_anon,
  (select relrowsecurity from pg_class where oid = 'public.booking_payments'::regclass) as booking_payments_rls,
  exists (select 1 from public.app_settings where id = 'onlinePayments') as setting_seeded,
  (select (value->>'enabled')::boolean is not true from public.app_settings where id = 'onlinePayments') as setting_off;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0046 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0046-* ids. The test turns the setting on
-- inside its own transaction; the rollback puts it back.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_id     text;
  v_count  int;
  v_err    text;
  v_has    boolean;
  r        record;
  v_seats  jsonb := jsonb_build_object(
    'customer_name', 'Guest 0046', 'customer_phone', '+966500000946',
    'workshop_id', 'TEST-0046-W', 'session_id', 'TEST-0046-S', 'workshop_title', 'Test 0046 workshop',
    'date', '2099-02-01', 'time', '10:00', 'participants', 2,
    -- Everything a tampering browser might claim:
    'status', 'Completed', 'payment_status', 'Paid', 'total_price', 1,
    'moyasar_payment_id', 'forged', 'paid_at', '2099-01-01T00:00:00Z',
    'online_amount_halalas', 100, 'payment_mode', 'full');
  v_bday   jsonb := jsonb_build_object(
    'customer_name', 'Guest 0046', 'customer_phone', '+966500000946',
    'workshop_id', 'birthday-party-event', 'workshop_title', 'Birthday Party',
    'date', '2099-02-02', 'time', '4:00 PM', 'participants', 10,
    'birthday_details', jsonb_build_object('packageId', 'TEST-0046-PKG'),
    'payment_status', 'Paid', 'total_price', 1);
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000046a1', 'authenticated', 'authenticated', now(), now()), -- A: customer
    ('00000000-0000-4000-8000-0000000046c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0046-A', '00000000-0000-4000-8000-0000000046a1', 'Customer A', '+966500000941', '+966500000941', '500000941', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0046-STAFF', '00000000-0000-4000-8000-0000000046c1', 'Staff 0046', true, 'Active');
  INSERT INTO public.workshops (id, title, price, pricing_type) VALUES
    ('TEST-0046-W',  'Test 0046 workshop', 150, 'Per person'),
    ('TEST-0046-W2', 'Test 0046 cheap',     60, 'Per person'),
    ('TEST-0046-W3', 'Test 0046 pair',     200, 'Per pair');
  INSERT INTO public.workshop_sessions (id, workshop_id, date, start_time, capacity) VALUES
    ('TEST-0046-S',  'TEST-0046-W',  '2099-02-01', '10:00', 3),
    ('TEST-0046-S2', 'TEST-0046-W2', '2099-02-01', '12:00', 10),
    ('TEST-0046-S3', 'TEST-0046-W3', '2099-02-01', '14:00', 10);
  INSERT INTO public.birthday_packages (id, name, price, pricing_type, status) VALUES
    ('TEST-0046-PKG',   'Test 0046 package',   120, 'Per child',   'Published'),
    ('TEST-0046-FIXED', 'Test 0046 fixed',    1500, 'Fixed price', 'Published');

  -- 1. Setting OFF: today's behaviour, except the new payment columns are stripped.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM public.book_session_seats((v_seats - 'participants') || '{"id":"TEST-0046-1","participants":1}', 'TEST-0046-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-1';
  ASSERT r.payment_status = 'Paid', format('Case 1 off: payment_status should be unchanged (Paid), got %s', r.payment_status);
  ASSERT r.moyasar_payment_id IS NULL AND r.paid_at IS NULL AND r.payment_mode IS NULL AND r.online_amount_halalas IS NULL,
    'Case 1 off: a guest must not be able to set the payment columns';
  DELETE FROM public.bookings WHERE id = 'TEST-0046-1';

  -- Turn online payments ON for the rest of the test (rolled back at the end).
  UPDATE public.app_settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE id = 'onlinePayments';

  -- 2. Guest workshop booking: hold, server price, deposit 100.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0046-2"}', 'TEST-0046-S');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-2';
  ASSERT r.status = 'Pending' AND r.payment_status = 'Awaiting Payment',
    format('Case 2: expected Pending / Awaiting Payment, got %s / %s', r.status, r.payment_status);
  ASSERT r.total_price = 300, format('Case 2: total_price must be 150 x 2 = 300 from the database, got %s', r.total_price);
  ASSERT r.payment_mode = 'deposit' AND r.online_amount = 100 AND r.online_amount_halalas = 10000,
    format('Case 2: expected deposit 100 / 10000 halalas, got %s %s %s', r.payment_mode, r.online_amount, r.online_amount_halalas);
  ASSERT r.moyasar_payment_id IS NULL AND r.paid_at IS NULL, 'Case 2: forged payment id / paid_at must be dropped';
  ASSERT r.payment_expires_at BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes',
    format('Case 2: expected a 15 minute hold, got %s', r.payment_expires_at);

  -- 3. Deposit never exceeds the price; Per pair rounds up.
  PERFORM set_config('role', 'anon', true);
  PERFORM public.book_session_seats((v_seats - 'participants') || '{"id":"TEST-0046-3","participants":1,"session_id":"TEST-0046-S2"}', 'TEST-0046-S2');
  PERFORM public.book_session_seats((v_seats - 'participants') || '{"id":"TEST-0046-3b","participants":3,"session_id":"TEST-0046-S3"}', 'TEST-0046-S3');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-3';
  ASSERT r.total_price = 60 AND r.online_amount = 60, format('Case 3: 60 SAR workshop must charge 60, got %s / %s', r.total_price, r.online_amount);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-3b';
  ASSERT r.total_price = 400 AND r.online_amount = 100, format('Case 3: Per pair x3 = 400, deposit 100; got %s / %s', r.total_price, r.online_amount);

  -- 4. Guest birthday: full price from the package.
  PERFORM set_config('role', 'anon', true);
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0046-4"}');
  PERFORM public.book_birthday_slot(v_bday || '{"id":"TEST-0046-4b","date":"2099-02-03","birthday_details":{"packageId":"TEST-0046-FIXED"}}');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-4';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.payment_mode = 'full' AND r.total_price = 1200 AND r.online_amount_halalas = 120000,
    format('Case 4: expected full 1200 SAR hold, got %s %s %s %s', r.payment_status, r.payment_mode, r.total_price, r.online_amount_halalas);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-4b';
  ASSERT r.total_price = 1500 AND r.online_amount = 1500, format('Case 4: Fixed price package must charge 1500, got %s', r.total_price);

  -- 5. Signed-in customer gets the same treatment.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000046a1","role":"authenticated"}', true);
  PERFORM public.book_session_seats((v_seats - 'participants') || '{"id":"TEST-0046-5","participants":1,"session_id":"TEST-0046-S2"}', 'TEST-0046-S2');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-5';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.customer_id = 'TEST-0046-A',
    format('Case 5: expected a hold filed under A, got %s / %s', r.payment_status, r.customer_id);

  -- 6. Staff are unchanged: what they send is what is written.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000046c1","role":"authenticated"}', true);
  PERFORM public.book_session_seats((v_seats - 'participants' - 'status') || '{"id":"TEST-0046-6","participants":1,"session_id":"TEST-0046-S2"}', 'TEST-0046-S2');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-6';
  ASSERT r.payment_status = 'Paid' AND r.total_price = 1 AND r.payment_expires_at IS NULL,
    format('Case 6 staff: expected Paid / 1 / no expiry, got %s / %s / %s', r.payment_status, r.total_price, r.payment_expires_at);

  -- 7. The hold takes seats; an expired hold releases them at once; its retry is refused.
  ASSERT public.session_seats_taken('TEST-0046-S') = 2, format('Case 7: hold should take 2 seats, got %s', public.session_seats_taken('TEST-0046-S'));
  UPDATE public.bookings SET payment_expires_at = now() - interval '1 minute' WHERE id = 'TEST-0046-2';
  ASSERT public.session_seats_taken('TEST-0046-S') = 0, format('Case 7: expired hold should take 0 seats, got %s', public.session_seats_taken('TEST-0046-S'));
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.book_session_seats(v_seats || '{"id":"TEST-0046-2"}', 'TEST-0046-S');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%hold has expired%', format('Case 7: retry of an expired hold must be refused, got %s', coalesce(v_err, 'no error'));
  -- Quote: nothing for the expired hold, the amount for a live one.
  SELECT count(*) INTO v_count FROM public.booking_payment_quote('TEST-0046-2');
  ASSERT v_count = 0, 'Case 7: no quote for an expired hold';
  SELECT * INTO r FROM public.booking_payment_quote('TEST-0046-4');
  ASSERT r.online_amount_halalas = 120000, format('Case 7: quote for a live hold, got %s', r.online_amount_halalas);
  PERFORM set_config('role', v_editor, true);

  -- 8. Nobody but the service role can confirm a payment.
  v_has := has_function_privilege('anon', 'public.confirm_booking_payment(text,text,integer,text)', 'execute')
        OR has_function_privilege('authenticated', 'public.confirm_booking_payment(text,text,integer,text)', 'execute');
  ASSERT NOT v_has, 'Case 8: anon/authenticated must not be able to call confirm_booking_payment';

  -- 9. Confirm: wrong amount, wrong currency, right; then retries and reuse.
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3b', 'pay-0046-a', 9999, 'SAR');
  ASSERT r.outcome = 'amount_mismatch', format('Case 9 amount: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3b', 'pay-0046-a', 10000, 'USD');
  ASSERT r.outcome = 'amount_mismatch', format('Case 9 currency: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3b', 'pay-0046-a', 10000, 'SAR');
  ASSERT r.outcome = 'confirmed' AND r.booking_payment_status = 'Deposit Paid', format('Case 9 confirm: got %s / %s', r.outcome, r.booking_payment_status);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-3b';
  ASSERT r.moyasar_payment_id = 'pay-0046-a' AND r.paid_at IS NOT NULL, 'Case 9: payment id and paid_at stored';
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3b', 'pay-0046-a', 10000, 'SAR');
  ASSERT r.outcome = 'already_confirmed', format('Case 9 retry: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3', 'pay-0046-a', 6000, 'SAR');
  ASSERT r.outcome = 'payment_used_elsewhere', format('Case 9 reuse: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-3b', 'pay-0046-b', 10000, 'SAR');
  ASSERT r.outcome = 'already_paid_other', format('Case 9 second payment: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-nope', 'pay-0046-c', 10000, 'SAR');
  ASSERT r.outcome = 'not_found', format('Case 9 unknown booking: got %s', r.outcome);
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-6', 'pay-0046-d', 100, 'SAR');
  ASSERT r.outcome = 'not_awaiting', format('Case 9 staff Paid booking: got %s', r.outcome);

  -- 10. Birthday full payment -> Paid.
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-4', 'pay-0046-e', 120000, 'SAR');
  ASSERT r.outcome = 'confirmed' AND r.booking_payment_status = 'Paid', format('Case 10: got %s / %s', r.outcome, r.booking_payment_status);

  -- 11. Late payment, place still free -> confirmed_late.
  --     TEST-0046-2 expired in case 7 and session S is empty.
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-2', 'pay-0046-f', 10000, 'SAR');
  ASSERT r.outcome = 'confirmed_late' AND r.booking_payment_status = 'Deposit Paid', format('Case 11: got %s / %s', r.outcome, r.booking_payment_status);
  ASSERT public.session_seats_taken('TEST-0046-S') = 2, 'Case 11: the late-confirmed booking takes its seats again';

  -- 12. Late payment, place gone -> needs_refund + staff notification.
  --     Session S (capacity 3) now has 2 seats taken by TEST-0046-2. A second
  --     2-seat booking whose hold expired (and was marked Expired by the job)
  --     pays late: 2 + 2 > 3, so it cannot be honoured.
  INSERT INTO public.bookings (id, session_id, workshop_id, workshop_title, date, time, participants,
                               status, payment_status, payment_mode, online_amount, online_amount_halalas, payment_expires_at)
  VALUES ('TEST-0046-12', 'TEST-0046-S', 'TEST-0046-W', 'Test 0046 workshop', '2099-02-01', '10:00', 2,
          'Cancelled', 'Expired', 'deposit', 100, 10000, now() - interval '30 minutes');
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-12', 'pay-0046-g', 10000, 'SAR');
  ASSERT r.outcome = 'needs_refund', format('Case 12: got %s', r.outcome);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-12';
  ASSERT r.status = 'Cancelled' AND r.payment_status = 'Needs Refund' AND r.moyasar_payment_id = 'pay-0046-g',
    format('Case 12: got %s / %s / %s', r.status, r.payment_status, r.moyasar_payment_id);
  SELECT count(*) INTO v_count FROM public.notifications WHERE type = 'staff' AND message LIKE '%TEST-0046-12%';
  ASSERT v_count = 1, format('Case 12: expected one staff notification, got %s', v_count);

  -- 13. A customer cannot mark their own booking paid directly (no UPDATE policy),
  --     and cannot read booking_payments.
  INSERT INTO public.booking_payments (id, booking_id, status) VALUES ('pay-0046-a', 'TEST-0046-3b', 'paid');
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000046a1","role":"authenticated"}', true);
  -- Either outcome is a pass: RLS makes it match no rows, or the table grant
  -- refuses it outright. The row check below is what matters.
  BEGIN
    UPDATE public.bookings SET payment_status = 'Paid', moyasar_payment_id = 'self' WHERE id = 'TEST-0046-5';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    SELECT count(*) INTO v_count FROM public.booking_payments;
  EXCEPTION WHEN insufficient_privilege THEN v_count := 0;
  END;
  ASSERT v_count = 0, format('Case 13: a customer must see no booking_payments rows, saw %s', v_count);
  BEGIN
    INSERT INTO public.booking_payments (id, booking_id, status) VALUES ('pay-0046-self', 'TEST-0046-5', 'paid');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 13: a customer must not be able to insert booking_payments';
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-5';
  ASSERT r.payment_status = 'Awaiting Payment' AND r.moyasar_payment_id IS NULL,
    format('Case 13: customer UPDATE must change nothing, got %s / %s', r.payment_status, r.moyasar_payment_id);

  -- 14. cancel_own_booking: deposit -> never refunded; full -> >24h refunded; hold -> no refund.
  UPDATE public.bookings SET customer_id = 'TEST-0046-A' WHERE id IN ('TEST-0046-3b', 'TEST-0046-4');
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000046a1","role":"authenticated"}', true);
  SELECT * INTO r FROM public.cancel_own_booking('TEST-0046-3b');
  ASSERT r.success AND NOT r.refunded, format('Case 14 deposit: expected cancelled, not refunded; got %s / %s', r.success, r.refunded);
  SELECT * INTO r FROM public.cancel_own_booking('TEST-0046-4');
  ASSERT r.success AND r.refunded, format('Case 14 full: expected refunded (>24h), got %s / %s', r.success, r.refunded);
  SELECT * INTO r FROM public.cancel_own_booking('TEST-0046-5');
  ASSERT r.success AND NOT r.refunded, format('Case 14 hold: expected cancelled, not refunded; got %s / %s', r.success, r.refunded);
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-3b';
  ASSERT r.status = 'Cancelled' AND r.payment_status = 'Deposit Paid', format('Case 14 deposit row: got %s / %s', r.status, r.payment_status);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0046-4';
  ASSERT r.payment_status = 'Refunded' AND (r.timeline->-1->>'action') LIKE '%Moyasar dashboard%',
    format('Case 14 full row: got %s / %s', r.payment_status, r.timeline->-1->>'action');
  -- A payment landing after the customer cancelled their hold -> refund, not revived.
  SELECT * INTO r FROM public.confirm_booking_payment('TEST-0046-5', 'pay-0046-h', 6000, 'SAR');
  ASSERT r.outcome = 'needs_refund', format('Case 14 paid after self-cancel: got %s', r.outcome);

  -- 15. A malformed setting falls back to defaults instead of breaking bookings.
  UPDATE public.app_settings
     SET value = '{"enabled": true, "holdMinutes": "abc", "workshop": {"mode": "weird", "depositAmount": "x"}}'
   WHERE id = 'onlinePayments';
  v_has := public.online_payments_config() = '{"enabled": true, "holdMinutes": 15, "workshop": {"mode": "deposit", "depositAmount": 100}, "birthday": {"mode": "full", "depositAmount": 100}}'::jsonb;
  ASSERT v_has, format('Case 15: got %s', public.online_payments_config());

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0046 TESTS PASSED — rolled back';
END $$;
*/
