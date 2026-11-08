-- STATUS: APPLIED
-- Confirmed 8 Nov 2026: every column this file adds exists in production
-- (information_schema check), so it was applied earlier without the header being updated.
-- Purpose: add an optional Arabic list of the "Materials Included" tags to workshops (display-only)
--
-- =============================================================================
-- 0038 — OPTIONAL ARABIC MATERIALS LIST (workshops.materials_ar)
--
-- CONTEXT
-- Same architecture as 0035's *_ar columns. workshops.materials is the list of
-- free-typed "Materials Included" tags staff add on the Workshop form (an open tag
-- input; there is no fixed list to translate from). This adds an optional Arabic
-- list for the customer site's "Included" section. Nothing reads or writes it yet;
-- this migration only adds it. The application changes (the TABLE_COLUMNS whitelist
-- in src/lib/mappers.ts, the Workshop type, the admin form's Arabic tag input, and
-- the customer-side display) are separate, later work.
--
-- DISPLAY-ONLY, WHOLE-LIST BY DESIGN
-- materials_ar is a STANDALONE Arabic list, not a per-item translation of
-- materials. It is deliberately NOT index-aligned with materials: staff add and
-- remove English tags by value, so parallel arrays would drift. The application
-- shows materials_ar in place of materials only when the visitor reads Arabic AND
-- the list is non-empty, and shows the whole list or the whole English list, never a
-- mix. English materials stays the canonical value everywhere it is deduplicated or
-- compared (the tag input's duplicate check, and deleteWorkshopOption's in-use
-- check). materials_ar is never compared, matched, keyed or snapshotted.
--
-- SCOPE — ADDITIVE ONLY. Exactly 1 column, nothing else:
--   public.workshops   materials_ar
-- Nothing is removed, renamed, retyped, backfilled or constrained. No other
-- column, table, index, RLS policy, grant or trigger is touched.
--
-- TYPE / NULLABILITY
-- text[] NOT NULL DEFAULT '{}', mirroring the existing materials column
-- (0001_init.sql:132). An empty array means "no Arabic version — show the English",
-- exactly as NULL does for the scalar *_ar columns. Existing rows read '{}'
-- immediately. Adding a NOT NULL column with a constant default is a metadata-only
-- change in PostgreSQL 11+ (no table rewrite, no lock beyond a brief ACCESS
-- EXCLUSIVE). `add column ... if not exists` makes re-running harmless.
-- NOTE FOR THE APPLICATION: because the column is NOT NULL, the app must write an
-- empty array ('{}' / []) to clear it, never null. Omitting the field on insert is
-- fine (the default applies).
--
-- RLS — NOT TOUCHED, DELIBERATELY. Verified against the migrations, not assumed:
--   * workshops is in the shared catalogue policy loop in 0001_init.sql:625-646:
--       workshops_public_read   for select to anon, authenticated using (true)
--       workshops_staff_write   for all    to authenticated
--                               using (public.is_staff()) with check (public.is_staff())
--     These are row-level predicates with no column list, so they cover the new column.
--   * No migration grants or revokes privileges on public.workshops (the only
--     grant/revoke statements in the migrations target customer_pieces,
--     customer_piece_history and functions), and no trigger is attached to it. The
--     only other statements naming it are its two indexes in 0001_init.sql:148-149.
--   * It is in the supabase_realtime publication as a whole table
--     (0002_capacity_rpc.sql:186-195), so the column flows through realtime.
-- No new policy is added or needed.
-- =============================================================================

alter table public.workshops
  add column if not exists materials_ar text[] not null default '{}';

-- -----------------------------------------------------------------------------
-- Verification (read-only). Expect 1 row: data_type = 'ARRAY', udt_name = '_text',
-- is_nullable = 'NO', column_default = '{}'::text[].
-- -----------------------------------------------------------------------------
select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'workshops'
  and column_name = 'materials_ar';

-- =============================================================================
-- End of migration.
-- =============================================================================
