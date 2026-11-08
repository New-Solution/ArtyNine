-- STATUS: APPLIED
-- Confirmed 8 Nov 2026: every column this file adds exists in production
-- (information_schema check), so it was applied earlier without the header being updated.
-- Purpose: add optional Arabic content columns to workshops and birthday_packages
--
-- =============================================================================
-- 0035 — OPTIONAL ARABIC CONTENT COLUMNS (workshops, birthday_packages)
--
-- CONTEXT
-- The customer site has an EN/AR toggle (LanguageContext.tsx), but workshop
-- and birthday-package content is entered once, in English, and shown as-is
-- in both languages. These columns give staff somewhere to store an Arabic
-- version of the customer-facing copy. Nothing reads or writes them yet; this
-- migration only adds them. The application changes (admin form inputs, the
-- TABLE_COLUMNS whitelist in src/lib/mappers.ts, customer-side fallback to
-- English when the Arabic value is NULL) are separate, later work.
--
-- SCOPE — ADDITIVE ONLY. Exactly 7 columns, nothing else:
--   public.workshops          title_ar, hook_ar, description_ar, full_details_ar
--   public.birthday_packages  name_ar, short_description_ar, full_description_ar
-- Nothing is removed, renamed, retyped, backfilled or constrained. No other
-- column, table, index, RLS policy, grant or trigger is touched.
--
-- TYPE / NULLABILITY
-- All seven are plain nullable `text` with no default and no check constraint.
-- They mirror the English columns they pair with (title/name are NOT NULL in
-- 0001_init.sql; the Arabic twins are deliberately nullable because every
-- existing row has no Arabic value yet, and an Arabic translation is optional
-- going forward). NULL means "no Arabic version — show the English".
-- `add column ... if not exists` makes re-running this file harmless. Adding a
-- nullable column with no default is a metadata-only change in Postgres: no
-- table rewrite, no lock beyond a brief ACCESS EXCLUSIVE, existing rows read
-- NULL immediately.
--
-- RLS — NOT TOUCHED, DELIBERATELY. See the report accompanying this file.
-- Both tables use the shared catalogue policies from 0001_init.sql:625-646:
--   <table>_public_read   for select to anon, authenticated using (true)
--   <table>_staff_write   for all    to authenticated
--                         using (public.is_staff()) with check (public.is_staff())
-- These are row-level predicates with no column list, and no migration grants
-- or revokes column-level privileges on either table, or attaches a trigger to
-- either table. Public read of, and staff write to, the new columns is
-- therefore already covered by the existing policies. No new policy is added
-- or needed. Both tables are already in the supabase_realtime publication as
-- whole tables (0002_capacity_rpc.sql:186-195), so the new columns flow
-- through realtime with no publication change.
-- =============================================================================

alter table public.workshops
  add column if not exists title_ar        text,
  add column if not exists hook_ar         text,
  add column if not exists description_ar  text,
  add column if not exists full_details_ar text;

alter table public.birthday_packages
  add column if not exists name_ar              text,
  add column if not exists short_description_ar text,
  add column if not exists full_description_ar  text;

-- -----------------------------------------------------------------------------
-- Verification (read-only). Expect 7 rows, all data_type = 'text',
-- is_nullable = 'YES', column_default = NULL.
-- -----------------------------------------------------------------------------
select
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'workshops' and column_name in (
      'title_ar', 'hook_ar', 'description_ar', 'full_details_ar'))
    or
    (table_name = 'birthday_packages' and column_name in (
      'name_ar', 'short_description_ar', 'full_description_ar'))
  )
order by table_name, column_name;

-- =============================================================================
-- End of migration.
-- =============================================================================
