-- STATUS: APPLIED
-- =============================================================================
-- 0042 — resolve_customer_record INSERTS NOTHING WHEN PHONE AND EMAIL ARE EMPTY
--
-- Run after 0041_phone_claim.sql.
--
-- With no usable phone and no email there is nothing to match on, so every
-- version since 0003 fell through to the insert and created a 'Guest' row with
-- no phone, no email, no user_id and source 'Website'. The app's startup
-- migration check called it exactly that way on every page load of both live
-- sites, which is where the stream of empty Guest rows came from.
--
-- Change: the function is 0041's, unchanged, plus one early return at the top
-- of the body — before any lookup — returning null and writing nothing. Every
-- caller in the app already treats a null id as a failure.
--
-- A phone that normalizes to nothing (e.g. letters only) counts as empty.
-- =============================================================================

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
  -- New in 0042: nothing to match on and nothing worth saving — write nothing.
  if v_key = '' and v_email = '' then
    return null;
  end if;

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
-- Verification — must come back true.
-- -----------------------------------------------------------------------------
select to_regprocedure('public.resolve_customer_record(text,text,text,uuid,text)') is not null as resolve_fn_exists;

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down to and including the line "END $$;" (inside the comment below), paste it into the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0042 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                             -> that case failed (the message names it and shows the actual value)
-- =============================================================================
/*
DO $$
DECLARE
  v_editor text := current_user;
  v_before bigint;
  v_after bigint;
  v_id text;
BEGIN
  SELECT count(*) INTO v_before FROM public.customers;

  -- Empty calls, as anon (exactly what the old startup probe sent) -> null, nothing inserted.
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_id := public.resolve_customer_record(NULL, NULL, NULL, NULL, NULL);
  ASSERT v_id IS NULL, format('All-null call: expected null, got %s', v_id);
  v_id := public.resolve_customer_record('Someone', '   ', '  ', NULL, 'Website');
  ASSERT v_id IS NULL, format('Blank phone/email call: expected null, got %s', v_id);
  v_id := public.resolve_customer_record('Someone', 'abc', NULL, NULL, NULL);
  ASSERT v_id IS NULL, format('Unusable phone call: expected null, got %s', v_id);
  PERFORM set_config('role', v_editor, true);
  SELECT count(*) INTO v_after FROM public.customers;
  ASSERT v_after = v_before, format('Empty calls: expected no new rows, count went %s -> %s', v_before, v_after);

  -- A call with a phone still returns an id (new or existing row).
  PERFORM set_config('role', 'anon', true);
  v_id := public.resolve_customer_record('TEST 0042', '0500000942', NULL, NULL, NULL);
  PERFORM set_config('role', v_editor, true);
  ASSERT v_id IS NOT NULL, 'Phone call: expected an id, got null';
  ASSERT EXISTS (SELECT 1 FROM public.customers WHERE id = v_id AND normalized_phone = '500000942'), format('Phone call: row %s missing or has the wrong phone', v_id);

  -- Grants unchanged.
  ASSERT has_function_privilege('anon', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute'), 'Grant: expected anon execute = true';
  ASSERT has_function_privilege('authenticated', 'public.resolve_customer_record(text,text,text,uuid,text)', 'execute'), 'Grant: expected authenticated execute = true';

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0042 TESTS PASSED — rolled back';
END $$;
*/
