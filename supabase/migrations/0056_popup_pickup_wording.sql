-- STATUS: APPLIED
-- Applied manually in the Supabase SQL Editor on 10 Nov 2026.
-- =============================================================================
-- 0056 — BOOKING POP-UP: PICKUP WORDING MATCHES THE TERMS
--
-- Run after 0055_security_advisor_fixes.sql (applied). One transaction.
--
-- The Booking Pop-up text lives in app_settings.prePaymentInstructions, seeded
-- by 0001 with "10 to 14 days" and "up to 30 days post-firing". The studio has
-- since confirmed: pieces are kept for about 1.5 months after they are ready,
-- and aprons are provided. The Terms page and DEFAULT_PREPAYMENT_POPUP
-- (src/types.ts) now say so; this brings the stored text in line.
--
-- Only lines that are STILL EXACTLY the old seeded default are replaced. A
-- line staff have edited in Settings -> Booking Pop-up is left as it is, and so
-- are any Arabic fields they typed. Re-running is a no-op.
-- =============================================================================

begin;

update public.app_settings
set value = replace(replace(replace(replace(value::text,
      'takes 10 to 14 days to completely air dry',
      'takes about two weeks to completely air dry'),
      'Safety Attire: We recommend wearing clothes you do not mind getting a little clay on (although aprons are provided!).',
      'Safety Attire: We recommend wearing clothes you do not mind getting a little clay on. Aprons are provided.'),
      'Storage Window: Your finished pieces will be held at our collection shelves for up to 30 days post-firing.',
      'Storage Window: Your finished pieces are kept for about 1.5 months after they are ready, so please collect them within that time.'),
      'I confirm I have read these safety rules and understand the 10-14 day firing timeline.',
      'I confirm I have read these studio rules and understand the firing timeline of about two weeks.')::jsonb,
    updated_at = now()
where id = 'prePaymentInstructions'
  and (value::text like '%10 to 14 days%'
    or value::text like '%(although aprons are provided!)%'
    or value::text like '%up to 30 days post-firing%'
    or value::text like '%10-14 day firing timeline%');

-- Verification: every column should be true (or the row was edited by staff
-- and no longer holds the old default wording — check it in Settings).
select
  value::text not like '%10 to 14 days%'             as no_10_to_14_days,
  value::text not like '%up to 30 days post-firing%' as no_30_days,
  value::text not like '%10-14 day firing timeline%' as no_10_14_checkbox,
  jsonb_typeof(value -> 'instructions') = 'array'    as still_valid_json
from public.app_settings
where id = 'prePaymentInstructions';

commit;
