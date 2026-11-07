-- STATUS: NOT APPLIED
-- =============================================================================
-- 0047 — MOYASAR PAYMENT EVENTS: AN APPEND-ONLY EVIDENCE LOG
--
-- Run after 0046_online_deposit_payments.sql (needs public.bookings and
-- public.is_staff(); the pre-flight block checks both).
--
-- WHY A NEW TABLE (booking_payments already has a raw column)
-- booking_payments (0046) is the system's CURRENT view of each payment, not
-- evidence:
--   - it is upserted by payment id, so every re-check overwrites the last one
--     (an earlier 'initiated' or 'failed' fetch is lost once it is 'paid');
--   - its raw column holds auditCopy(), a trimmed copy, not what Moyasar sent;
--   - webhook bodies are never stored at all.
-- For a dispute we need every response exactly as received, with when and how
-- it arrived. That is this table. booking_payments is left unchanged.
--
-- WHAT IS STORED
--   source = 'verify-payment'  GET /v1/payments/{id} fetched by verify-payment
--                              with the secret key (the payment step's
--                              on_completed call)
--          = 'return-page'     the same fetch, when verify-payment was called
--                              from the 3-D Secure return page
--          = 'webhook'         a webhook body that passed the secret_token
--                              check, with secret_token REMOVED
--   raw = Moyasar's JSON, unmodified apart from removing secret_token
--   (webhooks) and the payment's card token, source.token (both sources).
--   ip, source.transaction_url and everything else are kept.
--   Moyasar never returns a full card number or CVC: source.number is already
--   masked by Moyasar (e.g. 4111-11XX-XXXX-1111). Nothing is added to raw.
--   Our secret key and webhook secret are never stored. A CHECK constraint
--   refuses any raw that contains a secret_token key or a source.token key at
--   any depth.
--
-- WHO CAN DO WHAT
--   service_role (the Edge Functions): insert (and, as the platform's admin
--     role, update/delete — no code path does either)
--   staff (is_staff()): SELECT only
--   customers / anon: nothing
--   A trigger refuses UPDATE/DELETE from anon and authenticated even if a
--   grant or policy is added by mistake later. Deleting a booking still works:
--   the foreign key sets booking_id to null (it runs as the table owner) and
--   the evidence row stays.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pre-flight.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.bookings') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception '0047: public.bookings and public.is_staff() must exist (run 0001-0046 first).';
  end if;
  if to_regclass('public.booking_payments') is null then
    raise exception '0047: run 0046_online_deposit_payments.sql first.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- The table.
-- -----------------------------------------------------------------------------
create table if not exists public.moyasar_payment_events (
  id                 bigint generated always as identity primary key,
  booking_id         text references public.bookings(id) on delete set null,
  moyasar_payment_id text,                          -- null for a non-payment webhook event
  source             text not null
                     check (source in ('verify-payment', 'webhook', 'return-page')),
  event_type         text,                          -- webhook "type" (payment_paid, ...); null for fetches
  status             text,                          -- Moyasar's payment status in raw, if any
  amount_halalas     integer,
  currency           text,
  raw                jsonb not null
                     -- Forbidden keys, at any depth: our webhook secret, and
                     -- the payment's card token. ('$.**' includes the root.)
                     constraint moyasar_payment_events_no_forbidden_keys
                     check (    not jsonb_path_exists(raw, '$.**.secret_token')
                            and not jsonb_path_exists(raw, '$.**.source.token')),
  received_at        timestamptz not null default now()
);

comment on table public.moyasar_payment_events is
  'Append-only evidence log: every Moyasar payment response and webhook body as received '
  '(webhook secret_token removed). Card data is masked by Moyasar. Written by the service role only. See 0047.';

create index if not exists moyasar_payment_events_payment_idx on public.moyasar_payment_events (moyasar_payment_id);
create index if not exists moyasar_payment_events_booking_idx on public.moyasar_payment_events (booking_id);

-- -----------------------------------------------------------------------------
-- Privileges. Supabase's default privileges grant everything on new public
-- tables to anon and authenticated; take that back explicitly.
-- -----------------------------------------------------------------------------
revoke all on public.moyasar_payment_events from anon;
revoke all on public.moyasar_payment_events from authenticated;
grant select on public.moyasar_payment_events to authenticated;   -- filtered to staff by RLS
grant select, insert, update, delete on public.moyasar_payment_events to service_role;

alter table public.moyasar_payment_events enable row level security;

drop policy if exists moyasar_payment_events_staff_select on public.moyasar_payment_events;
create policy moyasar_payment_events_staff_select on public.moyasar_payment_events
  for select to authenticated using (public.is_staff());
-- No insert/update/delete policy: only the service role (which bypasses RLS) writes.

-- -----------------------------------------------------------------------------
-- Belt and braces: refuse UPDATE/DELETE from the API roles even if a future
-- grant or policy would allow it.
-- -----------------------------------------------------------------------------
create or replace function public.moyasar_payment_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'moyasar_payment_events is append-only evidence (% refused for %)', tg_op, current_user
      using errcode = 'insufficient_privilege';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists moyasar_payment_events_append_only on public.moyasar_payment_events;
create trigger moyasar_payment_events_append_only
  before update or delete on public.moyasar_payment_events
  for each row execute function public.moyasar_payment_events_append_only();

-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  (select relrowsecurity from pg_class where oid = 'public.moyasar_payment_events'::regclass) as rls_on,
  has_table_privilege('authenticated', 'public.moyasar_payment_events', 'select') as staff_can_select_via_rls,
  not has_table_privilege('authenticated', 'public.moyasar_payment_events', 'insert') as authenticated_no_insert,
  not has_table_privilege('authenticated', 'public.moyasar_payment_events', 'update') as authenticated_no_update,
  not has_table_privilege('authenticated', 'public.moyasar_payment_events', 'delete') as authenticated_no_delete,
  not has_table_privilege('anon', 'public.moyasar_payment_events', 'select') as anon_no_select,
  not has_table_privilege('anon', 'public.moyasar_payment_events', 'insert') as anon_no_insert,
  has_table_privilege('service_role', 'public.moyasar_payment_events', 'insert') as service_insert,
  exists (select 1 from pg_trigger where tgname = 'moyasar_payment_events_append_only'
            and tgrelid = 'public.moyasar_payment_events'::regclass) as append_only_trigger,
  pg_get_constraintdef((select oid from pg_constraint where conname = 'moyasar_payment_events_no_forbidden_keys'))
    like '%source.token%' as forbidden_keys_check,
  exists (select 1 from pg_indexes where indexname = 'moyasar_payment_events_payment_idx') as payment_idx,
  exists (select 1 from pg_indexes where indexname = 'moyasar_payment_events_booking_idx') as booking_idx;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0047 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use dates in 2099 and TEST-0047-* ids.
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_count  int;
  v_err    text;
  v_id     bigint;
  r        record;
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000047a1', 'authenticated', 'authenticated', now(), now()), -- A: customer
    ('00000000-0000-4000-8000-0000000047c1', 'authenticated', 'authenticated', now(), now()); -- S: staff
  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-0047-A', '00000000-0000-4000-8000-0000000047a1', 'Customer A', '+966500000971', '+966500000971', '500000971', true);
  INSERT INTO public.staff (id, user_id, name, has_console_access, status) VALUES
    ('TEST-0047-STAFF', '00000000-0000-4000-8000-0000000047c1', 'Staff 0047', true, 'Active');
  INSERT INTO public.bookings (id, customer_id, workshop_title, date, participants, status, payment_status) VALUES
    ('TEST-0047-B', 'TEST-0047-A', 'Test 0047 workshop', '2099-03-01', 1, 'Pending', 'Awaiting Payment');

  -- 1. The service role can insert; defaults are filled in.
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO public.moyasar_payment_events (booking_id, moyasar_payment_id, source, status, amount_halalas, currency, raw)
  VALUES ('TEST-0047-B', 'pay-0047-a', 'verify-payment', 'paid', 10000, 'SAR',
          '{"id":"pay-0047-a","status":"paid","source":{"number":"4111-11XX-XXXX-1111"}}')
  RETURNING id INTO v_id;
  INSERT INTO public.moyasar_payment_events (booking_id, moyasar_payment_id, source, event_type, status, raw)
  VALUES ('TEST-0047-B', 'pay-0047-a', 'webhook', 'payment_paid', 'paid', '{"type":"payment_paid","data":{"id":"pay-0047-a"}}');
  PERFORM set_config('role', v_editor, true);
  SELECT * INTO r FROM public.moyasar_payment_events WHERE id = v_id;
  ASSERT r.received_at IS NOT NULL AND r.raw->>'status' = 'paid', 'Case 1: service-role insert should be stored with received_at';

  -- 2. raw is required; source must be one of the three; secret_token is refused at any depth.
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('verify-payment', NULL);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 2: raw NULL must be refused';
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('browser', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 2: an unknown source must be refused';
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('webhook', '{"type":"payment_paid","secret_token":"x"}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 2: a top-level secret_token must be refused';
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('webhook', '{"data":{"metadata":{"secret_token":"x"}}}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 2: a nested secret_token must be refused';
  -- The card token: refused in a fetched payment (source.token) and in a webhook (data.source.token).
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw)
    VALUES ('verify-payment', '{"id":"p","source":{"type":"creditcard","token":"token_abc"}}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%moyasar_payment_events_no_forbidden_keys%',
    format('Case 2: source.token must be refused by the forbidden-keys check, got %s', coalesce(v_err, 'no error'));
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw)
    VALUES ('webhook', '{"type":"payment_paid","data":{"source":{"token":"token_abc"}}}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%moyasar_payment_events_no_forbidden_keys%',
    format('Case 2: data.source.token must be refused by the forbidden-keys check, got %s', coalesce(v_err, 'no error'));
  -- ...but ip, source.transaction_url and a "token" key outside source are kept.
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw)
    VALUES ('verify-payment', '{"id":"p","ip":"1.2.3.4","metadata":{"token":"x"},"source":{"number":"4111-11XX-XXXX-1111","transaction_url":"https://example"}}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NULL, format('Case 2: ip / transaction_url / non-source token must be accepted, got %s', v_err);
  PERFORM set_config('role', v_editor, true);

  -- 3. anon: cannot read, insert, update or delete.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    SELECT count(*) INTO v_count FROM public.moyasar_payment_events;
  EXCEPTION WHEN insufficient_privilege THEN v_count := 0;
  END;
  ASSERT v_count = 0, format('Case 3: anon must see no rows, saw %s', v_count);
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('webhook', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 3: anon must not insert';
  BEGIN
    UPDATE public.moyasar_payment_events SET status = 'forged';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.moyasar_payment_events;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a' AND status = 'paid';
  ASSERT v_count = 2, format('Case 3: anon must change nothing, expected 2 untouched rows, got %s', v_count);

  -- 4. A signed-in customer: sees nothing (even for their own booking), cannot write.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000047a1","role":"authenticated"}', true);
  BEGIN
    SELECT count(*) INTO v_count FROM public.moyasar_payment_events;
  EXCEPTION WHEN insufficient_privilege THEN v_count := 0;
  END;
  ASSERT v_count = 0, format('Case 4: a customer must see no rows, saw %s', v_count);
  BEGIN
    INSERT INTO public.moyasar_payment_events (booking_id, source, raw) VALUES ('TEST-0047-B', 'verify-payment', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 4: a customer must not insert';
  BEGIN
    UPDATE public.moyasar_payment_events SET status = 'forged';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.moyasar_payment_events;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a' AND status = 'paid';
  ASSERT v_count = 2, format('Case 4: a customer must change nothing, got %s untouched rows', v_count);

  -- 5. Staff: can read, cannot insert, update or delete.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000047c1","role":"authenticated"}', true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a';
  ASSERT v_count = 2, format('Case 5: staff should see both rows, saw %s', v_count);
  BEGIN
    INSERT INTO public.moyasar_payment_events (source, raw) VALUES ('webhook', '{}');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 5: staff must not insert';
  BEGIN
    UPDATE public.moyasar_payment_events SET status = 'forged' WHERE moyasar_payment_id = 'pay-0047-a';
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 5: staff UPDATE must be refused';
  BEGIN
    DELETE FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a';
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err IS NOT NULL, 'Case 5: staff DELETE must be refused';
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a' AND status = 'paid';
  ASSERT v_count = 2, format('Case 5: staff must change nothing, got %s untouched rows', v_count);

  -- 6. The trigger refuses API-role writes even if a grant slips in later.
  GRANT UPDATE, DELETE ON public.moyasar_payment_events TO authenticated;
  CREATE POLICY test_0047_open_update ON public.moyasar_payment_events FOR UPDATE TO authenticated USING (true);
  CREATE POLICY test_0047_open_delete ON public.moyasar_payment_events FOR DELETE TO authenticated USING (true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000047c1","role":"authenticated"}', true);
  BEGIN
    UPDATE public.moyasar_payment_events SET status = 'forged' WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%append-only%', format('Case 6: trigger should refuse UPDATE, got %s', coalesce(v_err, 'no error'));
  BEGIN
    DELETE FROM public.moyasar_payment_events WHERE id = v_id;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  ASSERT v_err LIKE '%append-only%', format('Case 6: trigger should refuse DELETE, got %s', coalesce(v_err, 'no error'));
  PERFORM set_config('role', v_editor, true);

  -- 7. Deleting the booking keeps the evidence, with booking_id set to null.
  DELETE FROM public.bookings WHERE id = 'TEST-0047-B';
  SELECT count(*) INTO v_count FROM public.moyasar_payment_events WHERE moyasar_payment_id = 'pay-0047-a' AND booking_id IS NULL;
  ASSERT v_count = 2, format('Case 7: evidence must survive the booking with booking_id null, got %s', v_count);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0047 TESTS PASSED — rolled back';
END $$;
*/
