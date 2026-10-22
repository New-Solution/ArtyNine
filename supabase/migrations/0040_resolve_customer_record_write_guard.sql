-- STATUS: NOT YET APPLIED — requires manual review
-- =============================================================================
-- 0040 — STOP ANONYMOUS WRITES TO EXISTING CUSTOMER ROWS IN resolve_customer_record
--
-- Run after 0039_birthday_package_arabic_lists.sql.
--
-- THE BUG
-- resolve_customer_record() (latest: 0033) is executable by anon. When an
-- existing row matched on phone/email and p_auth_id was null, the UPDATE branch
-- ran unconditionally: it overwrote name and email (and phone fields) with
-- whatever the caller sent, and never looked at user_id. So:
--
--   1. anon calls resolve_customer_record(p_phone => <walk-in's phone>,
--      p_email => attacker@x, p_auth_id => null) — the walk-in row now holds
--      the attacker's email;
--   2. the attacker signs up as attacker@x and confirms it;
--   3. the post-confirmation heal (resolveSessions() in AppContext.tsx) calls
--      resolve_customer_record(p_email => attacker@x, p_auth_id => <their id>),
--      which matches the walk-in row by email, and v_may_attach is true because
--      the row's stored email now equals the attacker's auth email.
--
-- The walk-in's bookings, queue history, pieces and notifications then belong
-- to the attacker. The same anon call could also rewrite the name/email on an
-- already-claimed account.
--
-- THE FIX — who may write to an EXISTING row:
--   1. Owner (row.user_id = auth.uid()): may update name/email/phone as before.
--   2. Attach (v_may_attach, unchanged from 0033): writes ONLY user_id,
--      has_account and updated_at. Contact fields are never touched by the
--      attaching caller.
--   3. Staff (public.is_staff()), unclaimed row only: may update name and phone;
--      may set email ONLY when the row's email is currently empty. Never touches
--      user_id / has_account.
--   4. Anyone else (anon, or an authenticated non-owner non-staff caller):
--      updates nothing and just returns the id.
--   A row with user_id set is never modified here unless rule 1 applies.
--
-- Unchanged: signature, return value, matching order (phone, then email), the
-- v_may_attach condition, and the insert path for a brand-new customer.
--
-- KNOWN EFFECT ON CURRENT CALLERS
-- resolveCustomer() in AppContext.tsx calls this through the CUSTOMER client,
-- so staff-console callers (Live Queue walk-in, logging a piece by hand) arrive
-- as anon and fall under rule 4, not rule 3. Live Queue is unaffected (it
-- renames through an explicit staff-client updateCustomer()). Logging a piece
-- by hand no longer fills name/email onto an EXISTING customer; the piece still
-- links to the right record, and staff can add an email via Edit Customer.
-- Rule 3 takes effect once resolveCustomer() uses getDataClient() — a separate
-- frontend change, not part of this migration.
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

  -- Brand new record: nobody else's data is at stake, so the caller's id is
  -- attached directly, same as before.
  insert into public.customers (
    id, user_id, name, email, phone, display_phone, normalized_phone,
    source, status, has_account, created_at
  ) values (
    v_id,
    p_auth_id,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Guest'),
    nullif(v_email, ''),
    v_display,
    v_display,
    nullif(v_key, ''),
    coalesce(p_source, 'Website'),
    'Active',
    p_auth_id is not null,
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
