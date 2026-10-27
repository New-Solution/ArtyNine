-- STATUS: APPLIED
-- =============================================================================
-- 0045 — PIECES POINT AT A STAGE ID (M1 of the stage-id plan: additive only)
--
-- Run after 0044_booking_customer_guard.sql.
--
-- THE PROBLEM
-- pieces.status holds the stage NAME ('First Burn and Colored'), with no link
-- to pipeline_stages. Renaming a stage hides its pieces from the board, the
-- pieces_status_valid check only accepts the five original names, and SMS and
-- notification logic match on the name. Settings locks stage names and hides
-- "Add Stage" until pieces reference something stable.
--
-- WHAT THIS ADDS (nothing is removed, renamed or tightened)
--   pipeline_stages.system_key   'created' | 'kiln' | 'ready' | 'collected' |
--                                'broken' on the five system rows, NULL for
--                                custom stages. Unique when set. Behaviour
--                                (SMS templates, end-states, overdue) will key
--                                on this; display keeps using the name.
--   pipeline_stages.name_ar      Optional Arabic stage name, same pattern as
--   pipeline_stages.customer_label_ar   categories.name_ar (0036). name_ar is
--                                seeded for the five system rows with the
--                                labels in src/utils/enumLabels.ts.
--                                customer_label_ar is left NULL.
--   pieces.stage_id              -> pipeline_stages(id), on delete restrict.
--   piece_history.stage_id       -> pipeline_stages(id), on delete restrict.
--                                piece_history.status stays exactly as written:
--                                history shows the name the stage had then.
--   Both foreign keys are added NOT VALID, then validated after the backfill.
--
-- KEEPING OLD AND NEW WRITERS IN STEP (the triggers)
-- The live app (and any console tab left open) writes only pieces.status. The
-- next app version will write stage_id. Until every writer uses stage_id, both
-- columns are kept in sync on every write:
--   pieces, before insert or update of status/stage_id (pieces_sync_stage):
--     - stage_id set on insert, or changed on update -> status := that stage's
--       name (the stage wins if both changed and disagree).
--     - otherwise, if status was written (or stage_id is still NULL) ->
--       stage_id := the stage whose name is exactly that status. No such stage
--       -> refused with check_violation (23514), the same error class
--       pieces_status_valid raises today, so nothing new gets through.
--   piece_history, before insert (piece_history_fill_stage):
--     - stage_id NULL -> filled from the stage whose name equals status. If no
--       stage has that name the row is still accepted with stage_id NULL:
--       history has never been validated and this does not start now.
-- pieces_status_valid is NOT dropped here; it still guards the five names.
-- Dropping it, making stage_id NOT NULL and a rename trigger come in M2.
--
-- CUSTOMER VIEWS
-- customer_pieces and customer_piece_history (0001; nothing later redefines
-- them) are recreated with stage_id APPENDED as the last column. Every other
-- column, the WHERE clause and the grants are unchanged. `create or replace
-- view` only allows adding columns at the end, which is all this does.
--
-- RLS — NOT TOUCHED. Checked against the migrations:
--   * pipeline_stages is in the public catalogue policy loop in
--     0001_init.sql:625-646: pipeline_stages_public_read (select, anon +
--     authenticated, using true) and pipeline_stages_staff_write (all,
--     is_staff()). Row-level only, no column list, and no migration grants or
--     revokes column privileges on it, so customers can read system_key,
--     name_ar and customer_label_ar with no change.
--   * pieces / piece_history keep pieces_staff_all / piece_history_staff_all
--     (0014). Customers read pieces only through the two views above, which run
--     as their owner (no security_invoker) — 0001_init.sql:719, 0014:70-73.
--   * All three tables are already in supabase_realtime as whole tables
--     (0002_capacity_rpc.sql:192-193), so the new columns flow through.
--   * No trigger existed on pieces or piece_history before this file.
--
-- LIVE-DATA SAFETY
--   * Runs in one transaction with lock_timeout = 5s: if the board holds a lock
--     the file stops and nothing changes; just run it again.
--   * New columns are nullable with no default (metadata-only, no rewrite).
--     Table locks are brief; pieces is ~45 rows.
--   * The backfill sends one realtime update per piece to open boards. The
--     content they show does not change.
--   * The pre-flight block refuses to run unless the five system stages have
--     their expected ids and names and every piece status names a stage.
--   * Safe to re-run: every step checks for what is already there.
--
-- DEPLOY ORDER
--   Apply this BEFORE any app build that writes stage_id (plan step A1). The
--   live app is unaffected by this file on its own.
--
-- ROLLBACK (only while no deployed app writes stage_id / system_key / *_ar —
-- otherwise those writes fail with "column not found"). pieces.status was the
-- source of truth throughout, so nothing is lost:
--
--   begin;
--   drop trigger if exists pieces_sync_stage on public.pieces;
--   drop trigger if exists piece_history_fill_stage on public.piece_history;
--   drop function if exists public.pieces_sync_stage();
--   drop function if exists public.piece_history_fill_stage();
--   -- The views must be dropped and recreated: a column cannot be removed with
--   -- create or replace. These are the 0001_init.sql definitions.
--   drop view if exists public.customer_piece_history;
--   drop view if exists public.customer_pieces;
--   create view public.customer_pieces as
--   select p.id, p.piece_code, p.customer_id, p.name, p.workshop_name,
--          p.date_created, p.image, p.status, p.days_elapsed,
--          p.expected_completion, p.expected_ready_date, p.collection_date,
--          p.created_at, p.updated_at
--   from public.pieces p
--   where p.customer_id is not null
--     and p.customer_id = public.current_customer_id();
--   comment on view public.customer_pieces is
--     'Customer-facing pottery. Deliberately omits damage_note and other internal fields.';
--   revoke all on public.customer_pieces from anon;
--   grant select on public.customer_pieces to authenticated;
--   create view public.customer_piece_history as
--   select h.id, h.piece_id, h.status, h."timestamp", h.riyadh_time
--   from public.piece_history h
--   join public.pieces p on p.id = h.piece_id
--   where p.customer_id is not null
--     and p.customer_id = public.current_customer_id();
--   comment on view public.customer_piece_history is
--     'Customer-facing piece timeline. Omits the internal reason/user columns.';
--   revoke all on public.customer_piece_history from anon;
--   grant select on public.customer_piece_history to authenticated;
--   alter table public.piece_history drop column if exists stage_id;
--   alter table public.pieces drop column if exists stage_id;
--   drop index if exists public.pipeline_stages_system_key_key;
--   alter table public.pipeline_stages
--     drop column if exists system_key,
--     drop column if exists name_ar,
--     drop column if exists customer_label_ar;
--   commit;
--   notify pgrst, 'reload schema';
-- =============================================================================

begin;
set local lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- Pre-flight: the data must look the way the production checks said it does.
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing  text;
  v_orphans  int;
begin
  select string_agg(e.id || ' = ' || e.name, ', ')
    into v_missing
    from (values
      ('stage-greenware', 'Created'),
      ('stage-bisque',    'First Burn and Colored'),
      ('stage-ready',     'Ready for Pickup'),
      ('stage-collected', 'Collected'),
      ('stage-broken',    'Broken')
    ) as e(id, name)
   where not exists (
     select 1 from public.pipeline_stages s where s.id = e.id and s.name = e.name
   );
  if v_missing is not null then
    raise exception '0045 aborted: expected system stage(s) not found as id = name: %', v_missing;
  end if;

  select count(*) into v_orphans
    from public.pieces p
   where not exists (select 1 from public.pipeline_stages s where s.name = p.status);
  if v_orphans > 0 then
    raise exception '0045 aborted: % piece(s) have a status that is not the name of any stage', v_orphans;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Columns. All nullable, no default.
-- -----------------------------------------------------------------------------
alter table public.pipeline_stages
  add column if not exists system_key        text,
  add column if not exists name_ar           text,
  add column if not exists customer_label_ar text;

alter table public.pieces        add column if not exists stage_id text;
alter table public.piece_history add column if not exists stage_id text;

-- -----------------------------------------------------------------------------
-- 2. Constraints. The foreign keys start NOT VALID (enforced for new writes,
--    existing rows not scanned yet) and are validated after the backfill.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'pipeline_stages_system_key_valid'
                    and conrelid = 'public.pipeline_stages'::regclass) then
    alter table public.pipeline_stages
      add constraint pipeline_stages_system_key_valid
      check (system_key in ('created', 'kiln', 'ready', 'collected', 'broken'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'pieces_stage_id_fkey'
                    and conrelid = 'public.pieces'::regclass) then
    alter table public.pieces
      add constraint pieces_stage_id_fkey
      foreign key (stage_id) references public.pipeline_stages(id)
      on delete restrict not valid;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'piece_history_stage_id_fkey'
                    and conrelid = 'public.piece_history'::regclass) then
    alter table public.piece_history
      add constraint piece_history_stage_id_fkey
      foreign key (stage_id) references public.pipeline_stages(id)
      on delete restrict not valid;
  end if;
end
$$;

create unique index if not exists pipeline_stages_system_key_key
  on public.pipeline_stages (system_key)
  where system_key is not null;

-- -----------------------------------------------------------------------------
-- 3. Sync triggers. Created before the backfill so a write that lands while
--    this file runs is covered either way.
-- -----------------------------------------------------------------------------
create or replace function public.pieces_sync_stage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_stage_written boolean;
  v_name          text;
  v_id            text;
begin
  if tg_op = 'INSERT' then
    v_stage_written := new.stage_id is not null;
  else
    v_stage_written := new.stage_id is not null
                       and new.stage_id is distinct from old.stage_id;
  end if;

  if v_stage_written then
    -- New-style write: the stage decides; status mirrors its current name.
    select s.name into v_name from public.pipeline_stages s where s.id = new.stage_id;
    if v_name is null then
      raise exception 'pieces.stage_id "%" is not a pipeline stage', new.stage_id
        using errcode = 'foreign_key_violation';
    end if;
    new.status := v_name;
  elsif tg_op = 'INSERT'
        or new.stage_id is null
        or new.status is distinct from old.status then
    -- Old-style write: find the stage by its exact name.
    select s.id into v_id from public.pipeline_stages s where s.name = new.status;
    if v_id is null then
      raise exception 'pieces.status "%" is not the name of any pipeline stage', new.status
        using errcode = 'check_violation';
    end if;
    new.stage_id := v_id;
  end if;

  return new;
end;
$$;

drop trigger if exists pieces_sync_stage on public.pieces;
create trigger pieces_sync_stage
  before insert or update of status, stage_id on public.pieces
  for each row execute function public.pieces_sync_stage();

create or replace function public.piece_history_fill_stage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_id text;
begin
  if new.stage_id is null then
    select s.id into v_id from public.pipeline_stages s where s.name = new.status;
    new.stage_id := v_id;   -- stays NULL for a name no stage has; still accepted
  end if;
  return new;
end;
$$;

drop trigger if exists piece_history_fill_stage on public.piece_history;
create trigger piece_history_fill_stage
  before insert on public.piece_history
  for each row execute function public.piece_history_fill_stage();

-- -----------------------------------------------------------------------------
-- 4. Backfill by exact name, then validate the foreign keys.
-- -----------------------------------------------------------------------------
update public.pieces p
   set stage_id = s.id
  from public.pipeline_stages s
 where p.stage_id is null
   and s.name = p.status;

update public.piece_history h
   set stage_id = s.id
  from public.pipeline_stages s
 where h.stage_id is null
   and s.name = h.status;

alter table public.pieces        validate constraint pieces_stage_id_fkey;
alter table public.piece_history validate constraint piece_history_stage_id_fkey;

create index if not exists pieces_stage_id_idx        on public.pieces (stage_id);
create index if not exists piece_history_stage_id_idx on public.piece_history (stage_id);

-- -----------------------------------------------------------------------------
-- 5. System keys and Arabic names on the five system rows (by id). name_ar is
--    only filled where empty, so a re-run never overwrites a staff edit.
-- -----------------------------------------------------------------------------
update public.pipeline_stages s
   set system_key = v.system_key
  from (values
    ('stage-greenware', 'created'),
    ('stage-bisque',    'kiln'),
    ('stage-ready',     'ready'),
    ('stage-collected', 'collected'),
    ('stage-broken',    'broken')
  ) as v(id, system_key)
 where s.id = v.id
   and s.system_key is distinct from v.system_key;

update public.pipeline_stages s
   set name_ar = v.name_ar
  from (values
    ('stage-greenware', 'تم الإنشاء'),
    ('stage-bisque',    'وقت الفرن'),
    ('stage-ready',     'جاهزة للاستلام'),
    ('stage-collected', 'تم الاستلام'),
    ('stage-broken',    'مكسورة')
  ) as v(id, name_ar)
 where s.id = v.id
   and s.name_ar is null;

-- -----------------------------------------------------------------------------
-- 6. Customer views: the 0001 definitions with stage_id appended.
-- -----------------------------------------------------------------------------
create or replace view public.customer_pieces as
select
  p.id,
  p.piece_code,
  p.customer_id,
  p.name,
  p.workshop_name,
  p.date_created,
  p.image,
  p.status,
  p.days_elapsed,
  p.expected_completion,
  p.expected_ready_date,
  p.collection_date,
  p.created_at,
  p.updated_at,
  p.stage_id
from public.pieces p
where p.customer_id is not null
  and p.customer_id = public.current_customer_id();

comment on view public.customer_pieces is
  'Customer-facing pottery. Deliberately omits damage_note and other internal fields.';

revoke all on public.customer_pieces from anon;
grant select on public.customer_pieces to authenticated;

create or replace view public.customer_piece_history as
select
  h.id,
  h.piece_id,
  h.status,
  h."timestamp",
  h.riyadh_time,
  h.stage_id
from public.piece_history h
join public.pieces p on p.id = h.piece_id
where p.customer_id is not null
  and p.customer_id = public.current_customer_id();

comment on view public.customer_piece_history is
  'Customer-facing piece timeline. Omits the internal reason/user columns.';

revoke all on public.customer_piece_history from anon;
grant select on public.customer_piece_history to authenticated;

commit;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- Verification — every column must come back true.
-- -----------------------------------------------------------------------------
select
  (select count(*) from public.pieces where stage_id is null) = 0                          as pieces_all_have_stage,
  (select count(*) from public.pieces p join public.pipeline_stages s on s.id = p.stage_id
    where p.status <> s.name) = 0                                                           as pieces_status_matches_stage,
  (select count(*) from public.piece_history where stage_id is null) = 0                   as history_all_matched,
  (select count(*) from public.piece_history h join public.pipeline_stages s on s.id = h.stage_id
    where h.status <> s.name) = 0                                                           as history_status_matches_stage,
  (select count(*) from public.pipeline_stages where system_key is not null) = 5           as system_keys_set,
  (select count(*) from public.pipeline_stages where system_key is not null and name_ar is not null) = 5
                                                                                            as name_ar_seeded,
  (select bool_and(convalidated) from pg_constraint
    where conname in ('pieces_stage_id_fkey', 'piece_history_stage_id_fkey'))             as stage_fks_validated,
  (select count(*) from pg_trigger
    where tgname in ('pieces_sync_stage', 'piece_history_fill_stage') and not tgisinternal) = 2
                                                                                            as sync_triggers_present,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'stage_id'
      and table_name in ('customer_pieces', 'customer_piece_history')) = 2                  as views_expose_stage_id,
  exists (select 1 from pg_constraint
           where conname = 'pieces_status_valid' and conrelid = 'public.pieces'::regclass)  as status_check_still_present;

-- Cross-tab — one row per stage (5 rows). Expect status_on_pieces to equal
-- name (or be NULL for a stage no piece is in) and pieces_count to match the
-- production counts: Created 36, First Burn and Colored 4, Ready for Pickup 5,
-- Collected 0, Broken 0.
select
  s."order",
  s.id,
  s.system_key,
  s.name,
  s.name_ar,
  min(p.status)                         as status_on_pieces,
  count(distinct p.status)              as distinct_statuses,   -- expect 0 or 1
  count(p.id)                           as pieces_count,
  (select count(*) from public.piece_history h where h.stage_id = s.id) as history_count
from public.pipeline_stages s
left join public.pieces p on p.stage_id = s.id
group by s."order", s.id, s.system_key, s.name, s.name_ar
order by s."order";

-- =============================================================================
-- MANUAL TESTS — run AFTER applying. Copy everything from the line "DO $$" down
-- to and including the line "END $$;" (inside the comment below), paste it into
-- the Supabase SQL editor, and run it once.
-- It always ends with an error, on purpose, so nothing is ever kept:
--   ERROR: ALL 0045 TESTS PASSED — rolled back   -> every case passed
--   ERROR: <case> ...                            -> that case failed (the message names it)
-- Fixtures use TEST-0045-* ids and are rolled back with everything else. The
-- realtime feed never sees them: nothing is committed.
-- =============================================================================
/*
DO $$
DECLARE
  v_status text;
  v_stage  text;
  v_ok     boolean;
BEGIN
  -- 1. Old-style insert (status only, as the live app writes) fills stage_id.
  INSERT INTO public.pieces (id, name, status) VALUES ('TEST-0045-1', 'Test bowl', 'Created');
  SELECT stage_id INTO v_stage FROM public.pieces WHERE id = 'TEST-0045-1';
  ASSERT v_stage = 'stage-greenware', format('Case 1 old-style insert: expected stage-greenware, got %s', v_stage);

  -- 2. Old-style update (status only) moves stage_id with it.
  UPDATE public.pieces SET status = 'Ready for Pickup' WHERE id = 'TEST-0045-1';
  SELECT stage_id INTO v_stage FROM public.pieces WHERE id = 'TEST-0045-1';
  ASSERT v_stage = 'stage-ready', format('Case 2 old-style update: expected stage-ready, got %s', v_stage);

  -- 3. New-style update (stage_id only) fills status with the stage name.
  UPDATE public.pieces SET stage_id = 'stage-bisque' WHERE id = 'TEST-0045-1';
  SELECT status INTO v_status FROM public.pieces WHERE id = 'TEST-0045-1';
  ASSERT v_status = 'First Burn and Colored', format('Case 3 new-style update: expected First Burn and Colored, got %s', v_status);

  -- 4. New-style insert (stage_id only; status falls to its default 'Created')
  --    takes the stage's name, not the default.
  INSERT INTO public.pieces (id, name, stage_id) VALUES ('TEST-0045-2', 'Test mug', 'stage-ready');
  SELECT status, stage_id INTO v_status, v_stage FROM public.pieces WHERE id = 'TEST-0045-2';
  ASSERT v_status = 'Ready for Pickup' AND v_stage = 'stage-ready',
    format('Case 4 new-style insert: expected Ready for Pickup / stage-ready, got %s / %s', v_status, v_stage);

  -- 5. Both written and disagreeing: the stage wins.
  UPDATE public.pieces SET stage_id = 'stage-collected', status = 'Created' WHERE id = 'TEST-0045-2';
  SELECT status, stage_id INTO v_status, v_stage FROM public.pieces WHERE id = 'TEST-0045-2';
  ASSERT v_status = 'Collected' AND v_stage = 'stage-collected',
    format('Case 5 conflicting write: expected Collected / stage-collected, got %s / %s', v_status, v_stage);

  -- 6. An unrelated update leaves both untouched.
  UPDATE public.pieces SET notes = 'unrelated' WHERE id = 'TEST-0045-2';
  SELECT status, stage_id INTO v_status, v_stage FROM public.pieces WHERE id = 'TEST-0045-2';
  ASSERT v_status = 'Collected' AND v_stage = 'stage-collected',
    format('Case 6 unrelated update: expected Collected / stage-collected, got %s / %s', v_status, v_stage);

  -- 7. History insert without stage_id gets it filled from the name.
  INSERT INTO public.piece_history (piece_id, status, "user") VALUES ('TEST-0045-1', 'First Burn and Colored', 'Staff');
  SELECT stage_id INTO v_stage FROM public.piece_history WHERE piece_id = 'TEST-0045-1' AND status = 'First Burn and Colored';
  ASSERT v_stage = 'stage-bisque', format('Case 7 history fill: expected stage-bisque, got %s', v_stage);

  -- 8. History with a name no stage has is still accepted (as today), stage_id NULL.
  INSERT INTO public.piece_history (piece_id, status, "user") VALUES ('TEST-0045-1', 'Glazing', 'Staff');
  SELECT stage_id INTO v_stage FROM public.piece_history WHERE piece_id = 'TEST-0045-1' AND status = 'Glazing';
  ASSERT v_stage IS NULL, format('Case 8 history unknown name: expected NULL stage_id, got %s', v_stage);

  -- 9. An unknown status is refused on insert.
  v_ok := false;
  BEGIN
    INSERT INTO public.pieces (id, name, status) VALUES ('TEST-0045-3', 'Test plate', 'Drying');
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'Case 9 unknown status insert: expected check_violation';

  -- 10. An unknown status is refused on update, and the row is unchanged.
  v_ok := false;
  BEGIN
    UPDATE public.pieces SET status = 'Kiln Time' WHERE id = 'TEST-0045-1';
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  SELECT status INTO v_status FROM public.pieces WHERE id = 'TEST-0045-1';
  ASSERT v_ok AND v_status = 'First Burn and Colored',
    format('Case 10 unknown status update: expected check_violation and unchanged row, got %s / %s', v_ok, v_status);

  -- 11. An unknown stage_id is refused.
  v_ok := false;
  BEGIN
    UPDATE public.pieces SET stage_id = 'stage-nope' WHERE id = 'TEST-0045-1';
  EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'Case 11 unknown stage_id: expected foreign_key_violation';

  -- 12. A stage in use cannot be deleted.
  v_ok := false;
  BEGIN
    DELETE FROM public.pipeline_stages WHERE id = 'stage-bisque';
  EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
  END;
  ASSERT v_ok, 'Case 12 delete stage in use: expected foreign_key_violation';

  -- Always roll back, pass or fail.
  RAISE EXCEPTION 'ALL 0045 TESTS PASSED — rolled back';
END $$;
*/
