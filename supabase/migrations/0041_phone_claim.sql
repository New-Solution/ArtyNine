-- STATUS: NOT YET APPLIED — requires manual review
-- =============================================================================
-- 0041 — CLAIM A CUSTOMER RECORD BY A VERIFIED PHONE, AND GUARD NEW-ROW ATTACH
--
-- Run after 0040_resolve_customer_record_write_guard.sql.
--
-- 1. link_customer_by_verified_phone(p_name)
--    Phase 1 of phone OTP sign-in. After Supabase Auth has verified the
--    caller's phone by SMS code (auth.users.phone + phone_confirmed_at), this
--    attaches the caller to the customer row with the same normalized_phone —
--    only if that row has no account yet — or creates the row if there is none.
--
--    The caller never passes a phone, a customer id or an auth id: all three
--    come from auth.uid() and auth.users. p_name is used only when a brand-new
--    row is created.
--
--    Returns jsonb { status, customer_id? }:
--      not_verified   no session, no phone, or the phone is not confirmed
--      already_linked the caller already owns a customer row (idempotent)
--      linked         an unclaimed row with this phone now belongs to the caller
--      created        no row had this phone; one was created for the caller
--      phone_in_use   the row with this phone belongs to another account —
--                     never re-pointed; no customer_id is returned
--      error          the race retry ran out (should not happen)
--
--    Telling a caller "phone_in_use" is not enumeration: they have just proved
--    they own that number with the SMS code.
--
-- 2. resolve_customer_record — insert guard
--    0040 guarded writes to EXISTING rows. Its insert path still attached
--    whatever p_auth_id it was handed, so anyone could create a new row tied
--    to someone else's auth id. Now a new row is attached only when
--    auth.uid() = p_auth_id; otherwise it is created unattached. Everything
--    else is byte-for-byte 0040.
--
--    Effect on the email sign-up path: registerCustomer() calls this right
--    after signUp(), before the email is confirmed (no session, so auth.uid()
--    is null). The new row is now created WITHOUT user_id, and the existing
--    post-confirmation heal in resolveSessions() (AppContext.tsx) attaches it:
--    it matches the row by the same email and v_may_attach holds. When email
--    confirmation is off, auth.uid() already equals p_auth_id and the row is
--    attached at creation exactly as before.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. link_customer_by_verified_phone
-- -----------------------------------------------------------------------------
create or replace function public.link_customer_by_verified_phone(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_phone     text;
  v_confirmed timestamptz;
  v_key       text;
  v_row       public.customers%rowtype;
  v_id        text;
  v_name      text := left(nullif(btrim(coalesce(p_name, '')), ''), 100);
begin
  if v_uid is null then
    return jsonb_build_object('status', 'not_verified');
  end if;

  select u.phone, u.phone_confirmed_at
    into v_phone, v_confirmed
    from auth.users u
   where u.id = v_uid;

  v_key := public.normalize_customer_phone(v_phone);

  -- A confirmed Saudi mobile only — the same numbers the send-sms-hook accepts.
  if v_confirmed is null or coalesce(v_key, '') !~ '^5[0-9]{8}$' then
    return jsonb_build_object('status', 'not_verified');
  end if;

  -- Already linked: idempotent, no write.
  select * into v_row from public.customers c where c.user_id = v_uid limit 1;
  if v_row.id is not null then
    return jsonb_build_object('status', 'already_linked', 'customer_id', v_row.id);
  end if;

  -- Two passes: if a concurrent call inserts the same phone (or this same user)
  -- between our lookup and our insert, the unique index refuses the insert and
  -- the second pass finds that row instead.
  for attempt in 1..2 loop
    v_row := null;
    select * into v_row
      from public.customers c
     where c.normalized_phone = v_key
     limit 1
       for update;

    if v_row.id is not null then
      if v_row.user_id = v_uid then
        return jsonb_build_object('status', 'already_linked', 'customer_id', v_row.id);
      end if;

      if v_row.user_id is not null then
        -- Never re-point an existing link.
        return jsonb_build_object('status', 'phone_in_use');
      end if;

      -- Attach only. Name, email and phone stay as the studio recorded them.
      update public.customers
         set user_id     = v_uid,
             has_account = true,
             updated_at  = now()
       where id = v_row.id
         and user_id is null;

      return jsonb_build_object('status', 'linked', 'customer_id', v_row.id);
    end if;

    begin
      v_id := 'CUST-' || gen_random_uuid()::text;
      insert into public.customers (
        id, user_id, name, email, phone, display_phone, normalized_phone,
        source, status, has_account, created_at
      ) values (
        v_id,
        v_uid,
        coalesce(v_name, 'Guest'),
        null,
        '+966' || v_key,
        '+966' || v_key,
        v_key,
        'Website Registration',
        'Active',
        true,
        now()
      );
      return jsonb_build_object('status', 'created', 'customer_id', v_id);
    exception when unique_violation then
      -- A concurrent call won: either this phone or this user now has a row.
      select * into v_row from public.customers c where c.user_id = v_uid limit 1;
      if v_row.id is not null then
        return jsonb_build_object('status', 'already_linked', 'customer_id', v_row.id);
      end if;
      -- Otherwise the phone was taken; the next pass re-reads it.
    end;
  end loop;

  return jsonb_build_object('status', 'error');
end;
$$;

revoke all on function public.link_customer_by_verified_phone(text) from public, anon;
grant execute on function public.link_customer_by_verified_phone(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. resolve_customer_record — 0040 with the insert-path guard
-- -----------------------------------------------------------------------------
create or replace function public.resolve_customer_record(
  p_name    text default null,
  p_phone   text default null,
  p_email   text default null,
  p_auth_id uuid default null,
  p_source  text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text := public.normalize_customer_phone(p_phone);
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_display  text := case when v_key <> '' then '+966' || v_key else nullif(btrim(coalesce(p_phone, '')), '') end;
  v_row      public.customers%rowtype;
  v_id       text;
  -- Only a genuinely authenticated caller, attaching their own id, whose own
  -- confirmed email matches what is already on the record, may attach an
  -- account to an existing row. Unchanged from 0033.
  v_may_attach boolean;
  v_is_owner   boolean;
  -- New in 0041: a brand-new row is attached only to the caller's own id.
  v_attach_new uuid := case when p_auth_id is not null and auth.uid() = p_auth_id then p_auth_id else null end;
begin
  -- Phone first, then email — the same order the app uses.
  if v_key <> '' then
    select * into v_row from public.customers c where c.normalized_phone = v_key limit 1;
  end if;

  if v_row.id is null and v_email <> '' then
    select * into v_row from public.customers c where lower(c.email) = v_email limit 1;
  end if;

  if v_row.id is not null then
    v_may_attach :=
      v_row.user_id is null
      and p_auth_id is not null
      and auth.uid() = p_auth_id
      and coalesce(btrim(v_row.email), '') <> ''
      and lower(btrim(v_row.email)) = (select lower(btrim(u.email)) from auth.users u where u.id = p_auth_id);

    v_is_owner :=
      v_row.user_id is not null
      and auth.uid() is not null
      and v_row.user_id = auth.uid();

    if v_is_owner then
      -- Rule 1: the account holder updating their own record.
      update public.customers
         set name             = case when coalesce(btrim(p_name), '') <> '' then btrim(p_name) else name end,
             email            = case when v_email <> '' then v_email else email end,
             phone            = coalesce(v_display, phone),
             display_phone    = coalesce(v_display, display_phone),
             normalized_phone = case when v_key <> '' then v_key else normalized_phone end,
             updated_at       = now()
       where id = v_row.id;

    elsif v_may_attach then
      -- Rule 2: attach only. Ownership was just proven by the email match;
      -- contact details are left exactly as the studio recorded them.
      update public.customers
         set user_id     = p_auth_id,
             has_account = true,
             updated_at  = now()
       where id = v_row.id
         and user_id is null;

    elsif v_row.user_id is null and public.is_staff() then
      -- Rule 3: staff filling in an unclaimed record. An email already on file
      -- is never replaced here — it is what a claim is verified against.
      update public.customers
         set name             = case when coalesce(btrim(p_name), '') <> '' then btrim(p_name) else name end,
             email            = case when coalesce(btrim(email), '') = '' and v_email <> '' then v_email else email end,
             phone            = coalesce(v_display, phone),
             display_phone    = coalesce(v_display, display_phone),
             normalized_phone = case when v_key <> '' then v_key else normalized_phone end,
             updated_at       = now()
       where id = v_row.id;
    end if;

    -- Rule 4: every other caller writes nothing.
    return v_row.id;
  end if;

  v_id := 'CUST-' || gen_random_uuid()::text;

  -- Brand new record: attached only when the caller is attaching their OWN id
  -- (0041). Anyone else — anon mid-signup, staff, a forged p_auth_id — gets an
  -- unattached row, which the verified paths (email heal, phone link) claim.
  insert into public.customers (
    id, user_id, name, email, phone, display_phone, normalized_phone,
    source, status, has_account, created_at
  ) values (
    v_id,
    v_attach_new,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Guest'),
    nullif(v_email, ''),
    v_display,
    v_display,
    nullif(v_key, ''),
    coalesce(p_source, 'Website'),
    'Active',
    v_attach_new is not null,
    now()
  );

  return v_id;
end;
$$;

-- Grants unchanged from 0010; re-stated so this file is self-contained.
revoke all on function public.resolve_customer_record(text, text, text, uuid, text) from public;
grant execute on function public.resolve_customer_record(text, text, text, uuid, text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Verification — must come back true, true.
-- -----------------------------------------------------------------------------
select
  to_regprocedure('public.link_customer_by_verified_phone(text)')                 is not null as link_fn_exists,
  to_regprocedure('public.resolve_customer_record(text,text,text,uuid,text)')      is not null as resolve_fn_exists;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down to and including the line "END $$;" (inside the comment below), paste it into the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0041 TESTS PASSED — everything rolled back   -> every case passed
--   ERROR: <case> ...                                         -> that case failed (the message names it and shows the actual value)
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_res jsonb;
  v_c_id text;
  v_id text;
  v_user uuid;
  v_has boolean;
  v_name text;
  v_count int;
BEGIN
  -- Fixtures, as the editor's own role.
  INSERT INTO auth.users (id, aud, role, phone, phone_confirmed_at, created_at, updated_at) VALUES
    ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', '966500000901', now(), now(), now()), -- A: walk-in owner
    ('00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', '966500000902', now(), now(), now()), -- B: number held by another account
    ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', NULL, NULL, now(), now()),            -- B2: that other account
    ('00000000-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', '966500000903', now(), now(), now()), -- C: new number
    ('00000000-0000-4000-8000-0000000000d1', 'authenticated', 'authenticated', '966500000904', NULL, now(), now());  -- D: phone NOT confirmed

  INSERT INTO public.customers (id, user_id, name, phone, display_phone, normalized_phone, has_account) VALUES
    ('TEST-WALKIN-A', NULL, 'Walk-in A', '+966500000901', '+966500000901', '500000901', false),
    ('TEST-HELD-B', '00000000-0000-4000-8000-0000000000b2', 'Held B', '+966500000902', '+966500000902', '500000902', true);

  -- A: unclaimed walk-in with the same phone -> linked, then already_linked; name untouched.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
  v_res := public.link_customer_by_verified_phone();
  ASSERT v_res->>'status' = 'linked' AND v_res->>'customer_id' = 'TEST-WALKIN-A', format('A first call: expected linked/TEST-WALKIN-A, got %s', v_res);
  v_res := public.link_customer_by_verified_phone();
  ASSERT v_res->>'status' = 'already_linked' AND v_res->>'customer_id' = 'TEST-WALKIN-A', format('A second call: expected already_linked/TEST-WALKIN-A, got %s', v_res);
  PERFORM set_config('role', v_editor, true);
  SELECT user_id, has_account, name INTO v_user, v_has, v_name FROM public.customers WHERE id = 'TEST-WALKIN-A';
  ASSERT v_user = '00000000-0000-4000-8000-0000000000a1' AND v_has AND v_name = 'Walk-in A', format('A row: expected a1/true/Walk-in A, got %s/%s/%s', v_user, v_has, v_name);

  -- B: the row with this phone belongs to another account -> phone_in_use, no id, never re-pointed, no second row.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
  v_res := public.link_customer_by_verified_phone();
  ASSERT v_res->>'status' = 'phone_in_use' AND v_res->>'customer_id' IS NULL, format('B call: expected phone_in_use with no customer_id, got %s', v_res);
  PERFORM set_config('role', v_editor, true);
  SELECT user_id INTO v_user FROM public.customers WHERE id = 'TEST-HELD-B';
  ASSERT v_user = '00000000-0000-4000-8000-0000000000b2', format('B row: expected still owned by b2, got %s', v_user);
  SELECT count(*) INTO v_count FROM public.customers WHERE user_id = '00000000-0000-4000-8000-0000000000b1';
  ASSERT v_count = 0, format('B second row: expected 0 rows for b1, got %s', v_count);

  -- C: no row with this phone -> created with the name, then already_linked to the same row (second name ignored).
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
  v_res := public.link_customer_by_verified_phone('Noura');
  ASSERT v_res->>'status' = 'created' AND v_res->>'customer_id' LIKE 'CUST-%', format('C first call: expected created/CUST-..., got %s', v_res);
  v_c_id := v_res->>'customer_id';
  v_res := public.link_customer_by_verified_phone('Other');
  ASSERT v_res->>'status' = 'already_linked' AND v_res->>'customer_id' = v_c_id, format('C second call: expected already_linked/%s, got %s', v_c_id, v_res);
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_count FROM public.customers WHERE user_id = '00000000-0000-4000-8000-0000000000c1';
  ASSERT v_count = 1, format('C rows: expected exactly 1 row for c1, got %s', v_count);
  SELECT name INTO v_name FROM public.customers WHERE id = v_c_id;
  ASSERT v_name = 'Noura', format('C name: expected Noura, got %s', v_name);
  SELECT count(*) INTO v_count FROM public.customers WHERE id = v_c_id AND normalized_phone = '500000903' AND display_phone = '+966500000903' AND has_account;
  ASSERT v_count = 1, format('C phone fields: expected 500000903 / +966500000903 / has_account on row %s', v_c_id);

  -- D: phone not confirmed -> not_verified.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
  v_res := public.link_customer_by_verified_phone();
  ASSERT v_res->>'status' = 'not_verified', format('D call: expected not_verified, got %s', v_res);

  -- No session (authenticated role, no sub) -> not_verified.
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  v_res := public.link_customer_by_verified_phone();
  ASSERT v_res->>'status' = 'not_verified', format('No-sub call: expected not_verified, got %s', v_res);
  PERFORM set_config('role', v_editor, true);

  -- Insert guard: anon creating a new row with someone else's auth id -> row created, but not attached.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_id := public.resolve_customer_record('Probe', '0500000905', NULL, '00000000-0000-4000-8000-0000000000a1', NULL);
  PERFORM set_config('role', v_editor, true);
  ASSERT v_id LIKE 'CUST-%', format('Insert guard: expected a new CUST-... id, got %s', v_id);
  SELECT user_id, has_account INTO v_user, v_has FROM public.customers WHERE id = v_id;
  ASSERT v_user IS NULL AND NOT v_has, format('Insert guard: expected user_id null / has_account false, got %s/%s', v_user, v_has);

  -- Grants: anon may not call the link function; signed-in users may.
  v_has := has_function_privilege('anon', 'public.link_customer_by_verified_phone(text)', 'execute');
  ASSERT NOT v_has, format('Grant: expected anon execute = false, got %s', v_has);
  v_has := has_function_privilege('authenticated', 'public.link_customer_by_verified_phone(text)', 'execute');
  ASSERT v_has, format('Grant: expected authenticated execute = true, got %s', v_has);

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0041 TESTS PASSED — everything rolled back';
END $$;
*/
-- Race (two simultaneous calls for the same new phone) needs two sessions: open
-- two SQL editor tabs, run the C setup in both inside BEGIN, call the function in
-- tab 1 (no commit), call it in tab 2 (it waits), commit tab 1 — tab 2 must return
-- already_linked or phone_in_use, never a second row.
