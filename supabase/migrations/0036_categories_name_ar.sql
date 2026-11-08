-- STATUS: APPLIED
-- Confirmed 8 Nov 2026: every column this file adds exists in production
-- (information_schema check), so it was applied earlier without the header being updated.
-- Purpose: add an optional Arabic name for workshop categories (display-only)
--
-- =============================================================================
-- 0036 — OPTIONAL ARABIC CATEGORY NAME (categories.name_ar)
--
-- CONTEXT
-- Same architecture as 0035's *_ar columns. The customer site has an EN/AR
-- toggle, but a workshop category (Pottery, Painting, ...) is entered once, in
-- English, and shown as-is in both languages. This column gives staff somewhere
-- to store an Arabic name for it. Nothing reads or writes it yet; this migration
-- only adds it. The application changes (the TABLE_COLUMNS whitelist in
-- src/lib/mappers.ts, the Category type, an admin place to type the Arabic name,
-- and the customer-side display-only fallback to English when it is NULL) are
-- separate, later work.
--
-- DISPLAY-ONLY BY DESIGN
-- public.workshops.category is a plain text column holding the category NAME.
-- It is not a foreign key, so the English `name` is what every filter chip,
-- comparison and dedup matches on. name_ar must never be stored in
-- workshops.category, compared, or used as a key: the English name stays the
-- canonical matched value, and the Arabic is looked up by that name only to
-- decide what text to show.
--
-- SCOPE — ADDITIVE ONLY. Exactly 1 column, nothing else:
--   public.categories   name_ar
-- Nothing is removed, renamed, retyped, backfilled or constrained. In particular
-- the existing unique index categories_name_key on lower(name) is left exactly
-- as it is, and no index is added on name_ar: two categories may legitimately
-- share an Arabic display name, and it is never a lookup key. No other column,
-- table, index, RLS policy, grant or trigger is touched.
--
-- TYPE / NULLABILITY
-- Plain nullable `text` with no default and no check constraint. It pairs with
-- categories.name, which is NOT NULL in 0001_init.sql; the Arabic twin is
-- deliberately nullable because every existing row has no Arabic value yet and
-- an Arabic name is optional going forward. NULL means "no Arabic version —
-- show the English". `add column ... if not exists` makes re-running this file
-- harmless. Adding a nullable column with no default is a metadata-only change
-- in Postgres: no table rewrite, no lock beyond a brief ACCESS EXCLUSIVE, and
-- existing rows read NULL immediately.
--
-- RLS — NOT TOUCHED, DELIBERATELY. Verified against the migrations, not assumed:
--   * categories is one of the tables in the shared catalogue policy loop in
--     0001_init.sql:625-646, which creates
--       categories_public_read  for select to anon, authenticated using (true)
--       categories_staff_write  for all    to authenticated
--                               using (public.is_staff()) with check (public.is_staff())
--     These are row-level predicates with no column list, so public read of, and
--     staff write to, the new column are already covered. RLS is enabled on the
--     table at 0001_init.sql:580.
--   * No migration grants or revokes column- or table-level privileges on
--     public.categories: every `grant`/`revoke` in supabase/migrations targets a
--     function, or another table (customer_pieces, customer_piece_history,
--     signin_attempts). So there is no column-privilege list this column could
--     be missing from.
--   * No trigger is attached to public.categories in any migration.
--   * categories is in the supabase_realtime publication as a whole table
--     (0002_capacity_rpc.sql:186-195), so the new column flows through realtime
--     with no publication change.
-- No new policy is added or needed.
-- =============================================================================

alter table public.categories
  add column if not exists name_ar text;

-- -----------------------------------------------------------------------------
-- Verification (read-only). Expect 1 row: data_type = 'text',
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
  and table_name = 'categories'
  and column_name = 'name_ar';

-- =============================================================================
-- End of migration.
-- =============================================================================
