-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 9 Nov 2026; every verification
-- column true and the test block below passed ("ALL 0054 TESTS PASSED").
-- =============================================================================
-- 0054 — IN-APP REFUNDS THROUGH THE MOYASAR API
--
-- Run after 0053_app_settings_write_permissions.sql (applied). Apply BEFORE
-- deploying refund-payment and the updated moyasar-webhook: both call the
-- functions below.
--
-- WHAT IT ADDS
--   bookings.refunded_at        when the booking became Refunded via 0054
--   bookings.refund_method      void | refund | moyasar_refunded | moyasar_voided
--   bookings.moyasar_refund_id  the refund's id IF Moyasar's answer carries
--                               one (its docs only promise the payment with
--                               status 'refunded', so this is often null; the
--                               full answer is in moyasar_payment_events)
--   bookings.refund_started_at  when a refund-payment call claimed the booking
--   payment_status 'Refund Processing' — a refund-payment call is talking to
--     Moyasar right now. payment_status has no CHECK constraint (0001), so no
--     DDL is needed for it; the functions below are the only writers.
--   moyasar_payment_events.source also accepts 'refund-payment'.
--
-- THE THREE FUNCTIONS (service role only — refund-payment and moyasar-webhook)
--   claim_booking_refund(booking)
--     Needs Refund -> Refund Processing in ONE conditional UPDATE, only for a
--     booking with a Moyasar payment. Returns true for exactly one caller: a
--     concurrent second UPDATE waits on the row lock, re-checks the WHERE
--     against the committed row, matches nothing and returns false. A claim
--     older than 5 minutes (the Edge Function died mid-way) can be taken over;
--     refund-payment always re-reads Moyasar before acting, so a takeover never
--     refunds twice.
--   release_booking_refund(booking, reason)
--     Refund Processing -> Needs Refund, with a timeline note. Used when
--     Moyasar refused or did not answer.
--   complete_booking_refund(booking, expected_status, method, refund_id, actor)
--     expected_status -> Refunded (Refund Processing for refund-payment,
--     Needs Refund for the webhook), sets refunded_at / refund_method /
--     moyasar_refund_id, appends the timeline entry and writes the customer's
--     refunded bell notification — all in one transaction. Returns true only
--     for the call that changed the row; the Edge Function sends the refunded
--     SMS only then, so bell and SMS go out once.
--     Bell wording = refundedNotificationMessage() in AppContext.tsx, the
--     'refund' pattern notificationText.ts renders in Arabic.
--
-- UNCHANGED: RLS on bookings (staff can still write payment_status directly,
-- as today's "Mark as Refunded" for studio payments does), every other RPC.
--
-- ROLLBACK
--   drop function if exists public.claim_booking_refund(text);
--   drop function if exists public.release_booking_refund(text, text);
--   drop function if exists public.complete_booking_refund(text, text, text, text, text);
--   update public.bookings set payment_status = 'Needs Refund' where payment_status = 'Refund Processing';
--   alter table public.moyasar_payment_events drop constraint if exists moyasar_payment_events_source_valid;
--   alter table public.moyasar_payment_events add constraint moyasar_payment_events_source_check
--     check (source in ('verify-payment', 'webhook', 'return-page'));   -- fails if refund rows exist
--   alter table public.bookings drop constraint if exists bookings_refund_method_valid;
--   alter table public.bookings drop column if exists refunded_at, drop column if exists refund_method,
--     drop column if exists moyasar_refund_id, drop column if exists refund_started_at;
--
-- TESTS: the commented-out block at the end of this file, run AFTER it. It
-- ends with an error on purpose ("ALL 0054 TESTS PASSED — rolled back") so
-- nothing is kept.
-- =============================================================================

-- Pre-flight.
do $$
begin
  if to_regclass('public.bookings') is null or to_regclass('public.moyasar_payment_events') is null
     or to_regclass('public.notifications') is null then
    raise exception '0054 aborted: bookings / moyasar_payment_events / notifications missing (run 0001-0053 first)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bookings' and column_name = 'online_amount_halalas') then
    raise exception '0054 aborted: bookings.online_amount_halalas missing (run 0046 first)';
  end if;
  if to_regprocedure('public.staff_can(text)') is null then
    raise exception '0054 aborted: staff_can(text) missing (0013) — refund-payment authorizes with it';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Columns.
-- -----------------------------------------------------------------------------
alter table public.bookings
  add column if not exists refunded_at       timestamptz,
  add column if not exists refund_method     text,
  add column if not exists moyasar_refund_id text,
  add column if not exists refund_started_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_refund_method_valid') then
    alter table public.bookings
      add constraint bookings_refund_method_valid
      check (refund_method is null or refund_method in ('void', 'refund', 'moyasar_refunded', 'moyasar_voided'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Evidence log: accept source 'refund-payment'. 0047 declared the source
-- check inline (auto-named), so find it by its definition rather than name.
-- -----------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.moyasar_payment_events'::regclass
       and contype = 'c'
       and conname <> 'moyasar_payment_events_no_forbidden_keys'
       and conname <> 'moyasar_payment_events_source_valid'
       and pg_get_constraintdef(oid) like '%verify-payment%'
  loop
    execute format('alter table public.moyasar_payment_events drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'moyasar_payment_events_source_valid') then
    alter table public.moyasar_payment_events
      add constraint moyasar_payment_events_source_valid
      check (source in ('verify-payment', 'webhook', 'return-page', 'refund-payment'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- claim_booking_refund
-- -----------------------------------------------------------------------------
create or replace function public.claim_booking_refund(p_booking_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.bookings
     set payment_status    = 'Refund Processing',
         refund_started_at = now(),
         updated_at        = now()
   where id = p_booking_id
     and moyasar_payment_id is not null
     and (payment_status = 'Needs Refund'
          or (payment_status = 'Refund Processing'
              and (refund_started_at is null or refund_started_at < now() - interval '5 minutes')));
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- release_booking_refund
-- -----------------------------------------------------------------------------
create or replace function public.release_booking_refund(p_booking_id text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.bookings
     set payment_status    = 'Needs Refund',
         refund_started_at = null,
         timeline          = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                               'time', to_char(now() at time zone 'Asia/Riyadh', 'FMHH12:MI AM'),
                               'action', 'Refund through Moyasar failed: '
                                         || left(coalesce(nullif(trim(p_reason), ''), 'no reason given'), 300)
                             ),
         updated_at        = now()
   where id = p_booking_id
     and payment_status = 'Refund Processing';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- complete_booking_refund
-- -----------------------------------------------------------------------------
create or replace function public.complete_booking_refund(
  p_booking_id      text,
  p_expected_status text,
  p_method          text,
  p_refund_id       text,
  p_actor           text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  b      public.bookings%rowtype;
  v_amt  text;
  v_who  text := coalesce(nullif(trim(p_actor), ''), 'Staff');
begin
  if p_expected_status is null or p_expected_status not in ('Refund Processing', 'Needs Refund') then
    raise exception 'complete_booking_refund: expected status must be Refund Processing or Needs Refund, got %', p_expected_status
      using errcode = 'invalid_parameter_value';
  end if;
  if p_method is null or p_method not in ('void', 'refund', 'moyasar_refunded', 'moyasar_voided') then
    raise exception 'complete_booking_refund: unknown method %', p_method
      using errcode = 'invalid_parameter_value';
  end if;

  select * into b from public.bookings
   where id = p_booking_id
     and payment_status = p_expected_status
     and moyasar_payment_id is not null
   for update;
  if not found then
    return false;
  end if;

  -- 10000 -> '100', 10050 -> '100.5' (matches notificationText.ts's \d+(\.\d+)?).
  v_amt := coalesce(trim_scale(b.online_amount_halalas / 100.0)::text, '?');

  update public.bookings
     set payment_status    = 'Refunded',
         refunded_at       = now(),
         refund_method     = p_method,
         moyasar_refund_id = nullif(trim(p_refund_id), ''),
         refund_started_at = null,
         timeline          = coalesce(timeline, '[]'::jsonb) || jsonb_build_object(
                               'time', to_char(now() at time zone 'Asia/Riyadh', 'FMHH12:MI AM'),
                               'action', case p_method
                                 when 'void'   then 'Refunded ' || v_amt || ' SAR through Moyasar (payment voided) by ' || v_who
                                 when 'refund' then 'Refunded ' || v_amt || ' SAR through Moyasar by ' || v_who
                                 else 'Moyasar shows the payment '
                                      || case when p_method = 'moyasar_voided' then 'voided' else 'refunded' end
                                      || ' — payment updated to Refunded (' || v_who || ')'
                               end
                             ),
         updated_at        = now()
   where id = b.id;

  insert into public.notifications (
    id, type, customer_id, customer_phone, title, message, "timestamp", is_read, highlighted
  ) values (
    'NOTIF-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
             || '-' || floor(random() * 1000)::int::text,
    'customer',
    b.customer_id,
    b.customer_phone,
    'Booking Cancelled — Refunded',
    'Your booking for "' || coalesce(b.workshop_title, '') || '" on ' || to_char(b.date, 'FMMonth FMDD, YYYY')
      || ' has been cancelled, and ' || v_amt || ' SAR has been refunded. We hope to see you again soon!',
    now(),
    false,
    false
  );

  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges: the Edge Functions (service role) only.
-- -----------------------------------------------------------------------------
revoke all on function public.claim_booking_refund(text) from public, anon, authenticated;
revoke all on function public.release_booking_refund(text, text) from public, anon, authenticated;
revoke all on function public.complete_booking_refund(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_booking_refund(text) to service_role;
grant execute on function public.release_booking_refund(text, text) to service_role;
grant execute on function public.complete_booking_refund(text, text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- Verification — every column must be true.
-- -----------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name in ('refunded_at', 'refund_method', 'moyasar_refund_id', 'refund_started_at')) = 4  as columns_added,
  exists (select 1 from pg_constraint where conname = 'bookings_refund_method_valid')                     as method_check,
  exists (select 1 from pg_constraint c where c.conname = 'moyasar_payment_events_source_valid'
            and pg_get_constraintdef(c.oid) like '%refund-payment%')                                     as evidence_source_check,
  (select count(*) from pg_constraint where conrelid = 'public.moyasar_payment_events'::regclass
     and contype = 'c' and pg_get_constraintdef(oid) like '%verify-payment%') = 1                        as one_source_check,
  exists (select 1 from pg_constraint where conname = 'moyasar_payment_events_no_forbidden_keys')        as forbidden_keys_kept,
  to_regprocedure('public.claim_booking_refund(text)') is not null                                       as claim_fn,
  to_regprocedure('public.release_booking_refund(text,text)') is not null                                as release_fn,
  to_regprocedure('public.complete_booking_refund(text,text,text,text,text)') is not null                as complete_fn,
  not has_function_privilege('authenticated', 'public.claim_booking_refund(text)', 'execute')            as claim_not_authenticated,
  not has_function_privilege('anon', 'public.claim_booking_refund(text)', 'execute')                     as claim_not_anon,
  not has_function_privilege('authenticated', 'public.release_booking_refund(text,text)', 'execute')     as release_not_authenticated,
  not has_function_privilege('authenticated', 'public.complete_booking_refund(text,text,text,text,text)', 'execute')
                                                                                                         as complete_not_authenticated,
  not has_function_privilege('anon', 'public.complete_booking_refund(text,text,text,text,text)', 'execute')
                                                                                                         as complete_not_anon,
  has_function_privilege('service_role', 'public.complete_booking_refund(text,text,text,text,text)', 'execute')
                                                                                                         as complete_service_role,
  has_function_privilege('service_role', 'public.claim_booking_refund(text)', 'execute')                 as claim_service_role;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0054 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0054-* ids.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_ok     boolean;
  v_count  int;
  v_err    text;
  r        record;
  c_staff  constant text := '{"sub":"00000000-0000-4000-8000-0000000054c1","role":"authenticated"}';
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000054a1', 'authenticated', 'authenticated', now(), now()), -- customer
    ('00000000-0000-4000-8000-0000000054c1', 'authenticated', 'authenticated', now(), now()); -- staff (Bookings)
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0054-A', '00000000-0000-4000-8000-0000000054a1', 'Customer 0054', '+966500000954', '+966500000954', '500000954', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status, role, permissions) VALUES
    ('TEST-0054-STAFF', '00000000-0000-4000-8000-0000000054c1', 'Staff 0054', true, 'Active', 'Admin', ARRAY['bookings']);

  -- N1: online, refund due.  N2: online, refund due (webhook path).
  -- S1: paid at the studio, refund due (no Moyasar payment).  P1: online, Paid.
  INSERT INTO public.bookings (id, customer_id, customer_phone, workshop_title, date, participants, status, payment_status,
                               payment_mode, online_amount, online_amount_halalas, moyasar_payment_id, timeline) VALUES
    ('TEST-0054-N1', 'TEST-0054-A', '+966500000954', 'Wheel 0054', '2099-03-01', 1, 'Cancelled', 'Needs Refund',
       'full', 150.50, 15050, 'pay-0054-n1', '[]'),
    ('TEST-0054-N2', 'TEST-0054-A', '+966500000954', 'Glaze 0054', '2099-03-02', 1, 'Cancelled', 'Needs Refund',
       'full', 200.00, 20000, 'pay-0054-n2', '[]'),
    ('TEST-0054-S1', 'TEST-0054-A', '+966500000954', 'Studio 0054', '2099-03-03', 1, 'Cancelled', 'Needs Refund',
       null, null, null, null, '[]'),
    ('TEST-0054-P1', 'TEST-0054-A', '+966500000954', 'Paid 0054', '2099-03-04', 1, 'Pending', 'Paid',
       'full', 100.00, 10000, 'pay-0054-p1', '[]');

  -- 1. Only the service role may call the functions.
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_booking_refund(text)', 'execute'),
    'Case 1a: authenticated must not execute claim_booking_refund';
  ASSERT NOT has_function_privilege('authenticated', 'public.complete_booking_refund(text,text,text,text,text)', 'execute'),
    'Case 1b: authenticated must not execute complete_booking_refund';
  ASSERT NOT has_function_privilege('anon', 'public.release_booking_refund(text,text)', 'execute'),
    'Case 1c: anon must not execute release_booking_refund';
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  BEGIN
    PERFORM public.claim_booking_refund('TEST-0054-N1');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%permission denied%', format('Case 1d: staff calling claim directly must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.complete_booking_refund('TEST-0054-N1', 'Needs Refund', 'refund', null, 'x');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%permission denied%', format('Case 1e: staff calling complete directly must be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT payment_status INTO r FROM public.bookings WHERE id = 'TEST-0054-N1';
  ASSERT r.payment_status = 'Needs Refund', 'Case 1f: refused calls must change nothing';

  -- From here on, as the Edge Functions: the service role.
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 2. Wrong status / no Moyasar payment: the claim refuses.
  ASSERT NOT public.claim_booking_refund('TEST-0054-S1'), 'Case 2a: a studio-paid booking (no Moyasar payment) must not be claimed';
  ASSERT NOT public.claim_booking_refund('TEST-0054-P1'), 'Case 2b: a Paid booking must not be claimed';
  ASSERT NOT public.claim_booking_refund('TEST-0054-NOPE'), 'Case 2c: an unknown booking must not be claimed';

  -- 3. The claim: exactly one caller wins.
  ASSERT public.claim_booking_refund('TEST-0054-N1'), 'Case 3a: first claim of a Needs Refund booking must succeed';
  ASSERT NOT public.claim_booking_refund('TEST-0054-N1'), 'Case 3b: a second (double-click) claim must fail';
  SELECT payment_status, refund_started_at INTO r FROM public.bookings WHERE id = 'TEST-0054-N1';
  ASSERT r.payment_status = 'Refund Processing' AND r.refund_started_at IS NOT NULL,
    format('Case 3c: expected Refund Processing with refund_started_at, got %s / %s', r.payment_status, r.refund_started_at);

  -- 4. Release (Moyasar failed): back to Needs Refund, once, with a note.
  ASSERT public.release_booking_refund('TEST-0054-N1', 'Validation Failed: amount must be an integer'),
    'Case 4a: release of a claimed booking must succeed';
  ASSERT NOT public.release_booking_refund('TEST-0054-N1', 'again'), 'Case 4b: a second release must do nothing';
  SELECT payment_status, refund_started_at, timeline INTO r FROM public.bookings WHERE id = 'TEST-0054-N1';
  ASSERT r.payment_status = 'Needs Refund' AND r.refund_started_at IS NULL,
    format('Case 4c: expected Needs Refund after release, got %s', r.payment_status);
  ASSERT (r.timeline->-1->>'action') = 'Refund through Moyasar failed: Validation Failed: amount must be an integer',
    format('Case 4d: release timeline note wrong: %s', r.timeline->-1->>'action');
  ASSERT NOT public.release_booking_refund('TEST-0054-P1', 'x'), 'Case 4e: release must not touch a Paid booking';

  -- 5. A stale claim (function died) can be taken over; a fresh one cannot.
  ASSERT public.claim_booking_refund('TEST-0054-N1'), 'Case 5a: re-claim after release must succeed';
  ASSERT NOT public.claim_booking_refund('TEST-0054-N1'), 'Case 5b: a fresh claim must not be taken over';
  PERFORM set_config('role', v_editor, true);
  UPDATE public.bookings SET refund_started_at = now() - interval '10 minutes' WHERE id = 'TEST-0054-N1';
  PERFORM set_config('role', 'service_role', true);
  ASSERT public.claim_booking_refund('TEST-0054-N1'), 'Case 5c: a claim older than 5 minutes must be taken over';
  ASSERT NOT public.claim_booking_refund('TEST-0054-N1'), 'Case 5d: and then be held again';

  -- 6. Complete: Refunded, columns, timeline, ONE bell notification.
  BEGIN
    PERFORM public.complete_booking_refund('TEST-0054-N1', 'Refund Processing', 'bogus', null, 'Staff 0054');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%unknown method%', format('Case 6a: an unknown method must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    PERFORM public.complete_booking_refund('TEST-0054-N1', 'Paid', 'refund', null, 'Staff 0054');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%expected status%', format('Case 6b: an expected status other than Refund Processing / Needs Refund must be refused, got %s', coalesce(v_err, 'no error'));
  ASSERT NOT public.complete_booking_refund('TEST-0054-N1', 'Needs Refund', 'refund', null, 'Staff 0054'),
    'Case 6c: completing with the wrong expected status must do nothing';

  ASSERT public.complete_booking_refund('TEST-0054-N1', 'Refund Processing', 'void', 'rf-0054', 'Staff 0054'),
    'Case 6d: completing a claimed booking must succeed';
  ASSERT NOT public.complete_booking_refund('TEST-0054-N1', 'Refund Processing', 'void', 'rf-0054', 'Staff 0054'),
    'Case 6e: a second complete must do nothing';
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0054-N1';
  ASSERT r.payment_status = 'Refunded' AND r.refunded_at IS NOT NULL AND r.refund_method = 'void'
         AND r.moyasar_refund_id = 'rf-0054' AND r.refund_started_at IS NULL,
    format('Case 6f: wrong completed row: %s / %s / %s / %s', r.payment_status, r.refunded_at, r.refund_method, r.moyasar_refund_id);
  ASSERT (r.timeline->-1->>'action') = 'Refunded 150.5 SAR through Moyasar (payment voided) by Staff 0054',
    format('Case 6g: timeline entry wrong: %s', r.timeline->-1->>'action');
  SELECT count(*) INTO v_count FROM public.notifications
   WHERE customer_phone = '+966500000954' AND title = 'Booking Cancelled — Refunded' AND message LIKE '%Wheel 0054%';
  ASSERT v_count = 1, format('Case 6h: expected exactly one refunded bell notification, found %s', v_count);
  SELECT * INTO r FROM public.notifications
   WHERE customer_phone = '+966500000954' AND message LIKE '%Wheel 0054%';
  ASSERT r.message = 'Your booking for "Wheel 0054" on March 1, 2099 has been cancelled, and 150.5 SAR has been refunded. We hope to see you again soon!',
    format('Case 6i: bell wording must match notificationText.ts''s refund pattern, got %s', r.message);
  ASSERT r.message ~ '^Your booking for "(.+)" on (.+) has been cancelled, and (\d+(?:\.\d+)?) SAR has been refunded\. We hope to see you again soon!$',
    'Case 6j: bell message must match the refund regex in notificationText.ts';
  ASSERT r.type = 'customer' AND r.customer_id = 'TEST-0054-A' AND r.is_read = false,
    'Case 6k: bell must be an unread customer notification for the booking''s customer';
  PERFORM set_config('role', 'service_role', true);

  -- 7. The webhook path: Needs Refund -> Refunded directly, once.
  ASSERT public.complete_booking_refund('TEST-0054-N2', 'Needs Refund', 'moyasar_refunded', null, 'Moyasar'),
    'Case 7a: webhook completion of a Needs Refund booking must succeed';
  ASSERT NOT public.complete_booking_refund('TEST-0054-N2', 'Needs Refund', 'moyasar_refunded', null, 'Moyasar'),
    'Case 7b: a retried webhook must do nothing';
  ASSERT NOT public.complete_booking_refund('TEST-0054-S1', 'Needs Refund', 'moyasar_refunded', null, 'Moyasar'),
    'Case 7c: a booking without a Moyasar payment must not be completed';
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.bookings WHERE id = 'TEST-0054-N2';
  ASSERT r.payment_status = 'Refunded' AND r.refund_method = 'moyasar_refunded' AND r.moyasar_refund_id IS NULL,
    format('Case 7d: wrong webhook-completed row: %s / %s', r.payment_status, r.refund_method);
  ASSERT (r.timeline->-1->>'action') = 'Moyasar shows the payment refunded — payment updated to Refunded (Moyasar)',
    format('Case 7e: webhook timeline entry wrong: %s', r.timeline->-1->>'action');
  SELECT count(*) INTO v_count FROM public.notifications WHERE message LIKE '%Glaze 0054%and 200 SAR has been refunded%';
  ASSERT v_count = 1, format('Case 7f: expected one bell for the webhook completion, found %s', v_count);
  SELECT payment_status INTO r FROM public.bookings WHERE id = 'TEST-0054-P1';
  ASSERT r.payment_status = 'Paid', 'Case 7g: the Paid booking must be untouched';
  SELECT payment_status INTO r FROM public.bookings WHERE id = 'TEST-0054-S1';
  ASSERT r.payment_status = 'Needs Refund', 'Case 7h: the studio booking must be untouched';

  -- 8. refund_method is constrained on the table too.
  BEGIN
    UPDATE public.bookings SET refund_method = 'cash' WHERE id = 'TEST-0054-P1';
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%bookings_refund_method_valid%', format('Case 8: refund_method = cash must be refused, got %s', coalesce(v_err, 'no error'));

  -- 9. Evidence log: 'refund-payment' accepted, other sources still refused,
  --    card token still refused.
  PERFORM set_config('role', 'service_role', true);
  INSERT INTO public.moyasar_payment_events (booking_id, moyasar_payment_id, source, event_type, status, raw)
  VALUES ('TEST-0054-N1', 'pay-0054-n1', 'refund-payment', 'void', 'voided', '{"id":"pay-0054-n1","status":"voided"}');
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('bogus', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%moyasar_payment_events_source_valid%', format('Case 9a: an unknown source must be refused, got %s', coalesce(v_err, 'no error'));
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('refund-payment', '{"source":{"token":"tok_x"}}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%no_forbidden_keys%', format('Case 9b: source.token must still be refused, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE booking_id = 'TEST-0054-N1' AND source = 'refund-payment';
  ASSERT v_count = 1, format('Case 9c: expected one refund-payment evidence row, found %s', v_count);

  -- 10. Staff (authenticated) still cannot read-modify evidence, and can read it.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', c_staff, true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE booking_id = 'TEST-0054-N1';
  ASSERT v_count = 1, format('Case 10a: staff must read refund evidence, saw %s', v_count);
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('refund-payment', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 10b: staff must not insert evidence';
  PERFORM set_config('role', v_editor, true);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0054 TESTS PASSED — rolled back';
END $$;
*/
