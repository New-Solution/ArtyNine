-- =============================================================================
-- 0006 — pottery pipeline clean-up
--
-- Three problems this fixes, all of them data-level:
--
--  1. pipeline_stages had accumulated duplicate and retired rows, so the Kanban
--     board drew "CREATED" and "KILN DRYING" twice and Settings edits appeared
--     to do nothing — staff were editing one of several rows with the same
--     name. 0001 seeds by id with ON CONFLICT DO NOTHING, so the extras came in
--     afterwards (the in-app "add stage" writes `stage-<timestamp>` ids, which
--     can never conflict). This deletes everything that is not one of the six
--     canonical rows and adds a unique index on the name so a second row with
--     the same name cannot be created again.
--
--  2. pieces.status was CHECK-constrained to the eight legacy stage names, so
--     renaming the pipeline would have made every write fail. Pieces are
--     migrated onto the new names first, then the constraint is replaced.
--
--  3. piece_code had no uniqueness, which is how two cards ended up showing
--     AC-1806. A unique index now enforces it at the data layer.
--
-- Safe to re-run.
-- =============================================================================

-- ---------- pieces.workshop_id -----------------------------------------------
-- The customer's My Pieces page shows the originating workshop's cover photo
-- rather than the studio's internal shot of the piece, which needs the link.
alter table public.pieces
  add column if not exists workshop_id text references public.workshops(id) on delete set null;

-- Backfill from the workshop name already stored on the piece.
update public.pieces p
   set workshop_id = w.id
  from public.workshops w
 where p.workshop_id is null
   and p.workshop_name is not null
   and lower(btrim(p.workshop_name)) = lower(btrim(w.title));

-- ---------- migrate pieces onto the four making-stages ------------------------
-- Done before any stage row is deleted, so no piece is left pointing at a stage
-- that no longer exists.
alter table public.pieces drop constraint if exists pieces_status_valid;

update public.pieces
   set status = case status
     when 'Created'       then 'Greenware'
     when 'Drying'        then 'Greenware'
     when 'In Processing' then 'Bisque Firing'
     when 'Firing'        then 'Bisque Firing'
     else status
   end
 where status in ('Created', 'Drying', 'In Processing', 'Firing');

-- Anything on a stage name we do not recognise (a hand-added duplicate) starts
-- again at the front of the pipeline rather than becoming unreadable.
update public.pieces
   set status = 'Greenware'
 where status not in ('Greenware', 'Bisque Firing', 'Glazing',
                      'Ready for Collection', 'Collected', 'Broken');

alter table public.pieces
  add constraint pieces_status_valid check (
    status in ('Greenware', 'Bisque Firing', 'Glazing',
               'Ready for Collection', 'Collected', 'Broken')
  );

-- History is a record of what happened, so old stage names stay readable, but
-- the four renamed ones are relabelled so the customer's timeline is coherent.
update public.piece_history
   set status = case status
     when 'Created'       then 'Greenware'
     when 'Drying'        then 'Greenware'
     when 'In Processing' then 'Bisque Firing'
     when 'Firing'        then 'Bisque Firing'
     else status
   end
 where status in ('Created', 'Drying', 'In Processing', 'Firing');

-- ---------- one clean, ordered set of stages ---------------------------------
insert into public.pipeline_stages (id, name, color, "order", visible_to_customer, customer_label, enabled, notify_customer) values
  ('stage-greenware', 'Greenware',            '#E07A5F', 0, true,  NULL, true, true),
  ('stage-bisque',    'Bisque Firing',        '#F2CC8F', 1, true,  NULL, true, true),
  ('stage-glazing',   'Glazing',              '#81B29A', 2, true,  NULL, true, true),
  ('stage-ready',     'Ready for Collection', '#335C67', 3, true,  NULL, true, true),
  ('stage-collected', 'Collected',            '#111111', 4, true,  NULL, true, true),
  ('stage-broken',    'Broken',               '#B91C1C', 5, false, NULL, true, true)
on conflict (id) do update set
  name                = excluded.name,
  color               = excluded.color,
  "order"             = excluded."order",
  visible_to_customer = excluded.visible_to_customer,
  enabled             = true;

-- Everything else — the legacy rows, the duplicates, the disabled leftovers.
delete from public.pipeline_stages
 where id not in ('stage-greenware', 'stage-bisque', 'stage-glazing',
                  'stage-ready', 'stage-collected', 'stage-broken');

-- A second stage with the same name is what made Settings edits look inert.
create unique index if not exists pipeline_stages_name_key
  on public.pipeline_stages (lower(btrim(name)));

-- ---------- piece codes are unique -------------------------------------------
-- Existing collisions are suffixed rather than blanked, so no card loses its
-- label. Ordered by created_at: the first piece to claim a code keeps it.
with ranked as (
  select id,
         piece_code,
         row_number() over (
           partition by lower(btrim(piece_code))
           order by created_at, id
         ) as rn
    from public.pieces
   where piece_code is not null and btrim(piece_code) <> ''
)
update public.pieces p
   set piece_code = ranked.piece_code || '-' || ranked.rn
  from ranked
 where p.id = ranked.id
   and ranked.rn > 1;

create unique index if not exists pieces_piece_code_key
  on public.pieces (lower(btrim(piece_code)))
  where piece_code is not null and btrim(piece_code) <> '';
