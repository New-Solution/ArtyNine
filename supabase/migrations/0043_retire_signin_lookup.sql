-- STATUS: APPLIED
-- =============================================================================
-- 0043 — RETIRE THE SIGN-IN LOOKUP
--
-- Run after 0042_no_empty_customer_insert.sql.
--
-- customer_signin_route() and customer_claim_email_matches() (0005) answer,
-- for anyone, questions about a phone number or address before any code or
-- password has been checked: whether an unclaimed record sits behind it, and a
-- masked hint of its email. With VITE_PHONE_AUTH on the app no longer calls
-- them — Sign In goes straight to a password check, and studio-made records
-- are claimed with a texted code (link_customer_by_verified_phone, 0041).
--
-- Change: anon and authenticated can no longer execute either function. The
-- functions themselves are kept, so rolling back is a single grant (below).
-- customer_signin_email() is NOT touched: phone + password sign-in for older
-- email accounts still uses it.
--
-- ⚠️ Applying this while VITE_PHONE_AUTH is still off in production breaks the
-- live claim flow:
--   - Sign In (account page and the checkout sign-in box): customer_signin_route
--     fails, loginCustomer() fails closed to the password route, so a walk-in /
--     studio-made record is told "Incorrect phone number or password" (or
--     "Incorrect email or password") instead of being offered "Set up your
--     password". Existing website accounts still sign in normally.
--   - "Set up your password" (claim form) becomes unreachable, and
--     claimCustomerAccount() would refuse anyway ("That account cannot be set up
--     here...") because its own route check fails the same way. Claiming by
--     phone with an email also fails at customer_claim_email_matches ("Could not
--     set up your account right now"). With the flag off there is no texted-code
--     route either, so walk-ins have no way to claim their record online.
--   - Every sign-in attempt logs "customer_signin_route failed: permission
--     denied" in the browser console.
--   - The startup migration check (src/lib/migrationCheck.ts) used to probe both
--     functions; those probes would become failed requests on every page load.
--     They have been removed.
--
-- Rollback:
--   grant execute on function public.customer_signin_route(text) to anon, authenticated;
--   grant execute on function public.customer_claim_email_matches(text, text) to anon, authenticated;
-- =============================================================================

revoke execute on function public.customer_signin_route(text) from public, anon, authenticated;
revoke execute on function public.customer_claim_email_matches(text, text) from public, anon, authenticated;

-- Check: every column should be false, and both functions still exist.
select
  has_function_privilege('anon',          'public.customer_signin_route(text)',             'execute') as route_anon,
  has_function_privilege('authenticated', 'public.customer_signin_route(text)',             'execute') as route_authenticated,
  has_function_privilege('anon',          'public.customer_claim_email_matches(text,text)', 'execute') as claim_match_anon,
  has_function_privilege('authenticated', 'public.customer_claim_email_matches(text,text)', 'execute') as claim_match_authenticated,
  to_regprocedure('public.customer_signin_route(text)')             is null as route_fn_missing,
  to_regprocedure('public.customer_claim_email_matches(text,text)') is null as claim_match_fn_missing;
