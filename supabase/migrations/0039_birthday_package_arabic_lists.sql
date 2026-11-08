-- STATUS: APPLIED
-- Confirmed 8 Nov 2026: every column this file adds exists in production
-- (information_schema check), so it was applied earlier without the header being updated.
-- Purpose: add optional standalone Arabic lists for the birthday-package Includes / Activity Choices / Additional Information (display-only)
--
-- =============================================================================
-- 0039 — OPTIONAL ARABIC BIRTHDAY-PACKAGE LISTS (birthday_packages)
--
-- CONTEXT
-- Same architecture as 0038 (workshops.materials_ar). 0037 deferred the three
-- text[] lists; this adds them. Nothing reads or writes them yet; this migration
-- only adds them. The application changes (mappers.ts whitelist, BirthdayPackage
-- type, admin editor Arabic inputs, showcase display) are separate, later work.
--
-- DISPLAY-ONLY, WHOLE-LIST BY DESIGN
-- Each *_ar column is a STANDALONE Arabic list, not a per-item translation and
-- deliberately NOT index-aligned with its English twin. The application shows an
-- Arabic list in place of its English one only when the visitor reads Arabic AND
-- that list is non-empty; the whole list or the whole English list, never a mix.
-- The English lists stay canonical. Never compared, matched, keyed or snapshotted.
--
-- SCOPE — ADDITIVE ONLY. Exactly 3 columns, nothing else:
--   public.birthday_packages
--     included_items_ar, activity_choices_ar, additional_info_ar
-- Nothing is removed, renamed, retyped, backfilled or constrained.
--
-- TYPE / NULLABILITY
-- text[] NOT NULL DEFAULT '{}', mirroring the English columns
-- (0001_init.sql:415-417) and 0038. An empty array means "no Arabic version —
-- show the English". Existing rows read '{}' immediately; adding a NOT NULL
-- column with a constant default is metadata-only in PostgreSQL 11+.
-- NOTE FOR THE APPLICATION: because the columns are NOT NULL, the app must write
-- an empty array to clear a list, never null. Omitting them on insert is fine.
--
-- RLS — NOT TOUCHED, DELIBERATELY. birthday_packages is in the shared catalogue
-- policy loop (0001_init.sql:625-646: birthday_packages_public_read for select to
-- anon, authenticated using (true); birthday_packages_staff_write for all to
-- authenticated using/with check public.is_staff()). Row-level predicates with no
-- column list cover the new columns. No migration grants/revokes privileges on
-- this table, no trigger is attached to it, and it is in the supabase_realtime
-- publication as a whole table (0002_capacity_rpc.sql:186-195).
-- =============================================================================

alter table public.birthday_packages
  add column if not exists included_items_ar   text[] not null default '{}',
  add column if not exists activity_choices_ar text[] not null default '{}',
  add column if not exists additional_info_ar  text[] not null default '{}';

-- Verification (read-only). Expect 3 rows: data_type = 'ARRAY', udt_name = '_text',
-- is_nullable = 'NO', column_default = '{}'::text[].
select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'birthday_packages'
  and column_name in ('included_items_ar', 'activity_choices_ar', 'additional_info_ar')
order by column_name;

-- =============================================================================
-- End of migration.
-- =============================================================================
