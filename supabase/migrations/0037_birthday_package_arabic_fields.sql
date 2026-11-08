-- STATUS: APPLIED
-- Confirmed 8 Nov 2026: every column this file adds exists in production
-- (information_schema check), so it was applied earlier without the header being updated.
-- Purpose: add optional Arabic versions of the remaining customer-facing birthday-package text (display-only)
--
-- =============================================================================
-- 0037 — OPTIONAL ARABIC BIRTHDAY-PACKAGE FIELDS (birthday_packages, tier 1)
--
-- CONTEXT
-- Same architecture as 0035's *_ar columns. 0035 covered name, short_description
-- and full_description. This adds the remaining single-value text fields the
-- customer site shows. Nothing reads or writes them yet; this migration only adds
-- them. The application changes (the TABLE_COLUMNS whitelist in
-- src/lib/mappers.ts, the BirthdayPackage type, the admin editor's Arabic inputs,
-- and the customer-side display-only fallback to English when NULL) are separate,
-- later work.
--
-- DISPLAY-ONLY BY DESIGN
-- The English column stays the canonical value everywhere. Each *_ar column is only
-- ever shown in place of its English twin when the visitor reads Arabic and the
-- value is non-blank. Never compared, matched, keyed or stored as a snapshot.
--
-- SCOPE — ADDITIVE ONLY. Exactly 8 columns, nothing else:
--   public.birthday_packages
--     pricing_label_ar, duration_ar, age_information_ar, cake_description_ar,
--     trainer_info_ar, delivery_info_ar, customer_notes_ar, terms_ar
-- Deliberately NOT included:
--   * included_items / activity_choices / additional_info (text[]) — deferred.
--   * cake_sizes — an optional `labelAr` is added inside each object of the
--     EXISTING jsonb column by the application. No DDL is needed for that.
-- Nothing is removed, renamed, retyped, backfilled or constrained. No other
-- column, table, index, RLS policy, grant or trigger is touched.
--
-- TYPE / NULLABILITY
-- All eight are plain nullable `text` with no default and no check constraint,
-- mirroring the English columns they pair with. NULL means "no Arabic version —
-- show the English". `add column ... if not exists` makes re-running harmless;
-- adding a nullable column with no default is a metadata-only change in Postgres.
--
-- RLS — NOT TOUCHED, DELIBERATELY. Verified against the migrations, not assumed:
--   * birthday_packages is in the shared catalogue policy loop in
--     0001_init.sql:625-646 (public read for anon/authenticated; staff-only write).
--     These are row-level predicates with no column list, so they cover the new columns.
--   * No migration grants/revokes privileges on public.birthday_packages, and no
--     trigger is attached to it.
--   * It is in the supabase_realtime publication as a whole table
--     (0002_capacity_rpc.sql:186-195), so the columns flow through realtime.
-- No new policy is added or needed.
-- =============================================================================

alter table public.birthday_packages
  add column if not exists pricing_label_ar    text,
  add column if not exists duration_ar         text,
  add column if not exists age_information_ar  text,
  add column if not exists cake_description_ar text,
  add column if not exists trainer_info_ar     text,
  add column if not exists delivery_info_ar    text,
  add column if not exists customer_notes_ar   text,
  add column if not exists terms_ar            text;

-- -----------------------------------------------------------------------------
-- Verification (read-only). Expect 8 rows, all data_type = 'text',
-- is_nullable = 'YES', column_default = NULL.
-- -----------------------------------------------------------------------------
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'birthday_packages'
  and column_name in (
    'pricing_label_ar', 'duration_ar', 'age_information_ar', 'cake_description_ar',
    'trainer_info_ar', 'delivery_info_ar', 'customer_notes_ar', 'terms_ar')
order by column_name;

-- =============================================================================
-- End of migration.
-- =============================================================================
