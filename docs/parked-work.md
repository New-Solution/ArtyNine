# Parked Work

Known issues and follow-ups that have been deliberately deferred, with the reason. Nothing here
is forgotten or accidental — each was found during other work and consciously left.

---

## LAUNCH BLOCKER

### The payment flow is simulated — no money moves — RESOLVED

Real payments arrived with Moyasar (migration 0046, Edge Functions `verify-payment` /
`moyasar-webhook`; runbook in `docs/manual-test-payments.md`). The leftover simulation — a fake
card / Apple Pay / STC Pay form and an 800ms timer that wrote `Paid` when online payments were OFF
— was removed on 8 Nov 2026: with payments off a website booking is now saved `Unpaid` ("Pay at the
studio"), and migration 0050 forces `Unpaid` in the database for non-staff callers. The false STC
Pay copy went with it. Bookings already written `Paid` by the simulation were left untouched; see
the query in `docs/PROJECT_NOTES.md` §8 to list them.

### Customer-triggered SMS has no access path — RESOLVED for self-cancel

`send-sms` stays staff-only. The customer self-cancel SMS now goes through its own narrowly
authorised Edge Function, `notify-own-booking` (proves the caller owns the booking, reads phone and
wording from the row). No booking-confirmation SMS or email is wanted (client decision), so there
is no other customer-triggered send today.

### N7 — password reset always reports success

A reset request rejected by Supabase (email rate limit, provider failure) still shows *"reset link
is on its way"*. The send result is never checked. The generic non-revealing wording is correct and
should stay — the bug is that it does not reflect reality.

`AdminDashboardSection.tsx:182-190` is the pattern to copy: it branches on the real result and
tells staff *"the text message could not be sent: …"* when the send fails. It is currently the only
place in the app that reports a true send outcome.

Affects `AppContext.tsx:1123` and its three callers — `AuthSection.tsx:257`,
`AdminLoginSection.tsx:53`, `CheckoutInfoSection.tsx:147`.

---

## Deployment — required step

### Verify a migration batch actually applied

**Do this after every batch.** During the capacity pass, `0023`–`0027` were applied in one sitting
and `0027` alone was missing — with no error seen. The failure presented as a function that did not
exist, which was misread for half an hour as a caching problem. Nothing surfaced it until a test
failed.

```sql
-- Every object migrations 0023–0030 are supposed to create.
select 'session_seats_summary'    as object, to_regprocedure('public.session_seats_summary(text[])')      is not null as present
union all select 'workshop_recent_bookings', to_regprocedure('public.workshop_recent_bookings(date,date)') is not null
union all select 'birthday_booking_counts',  to_regprocedure('public.birthday_booking_counts(date[],text)') is not null
union all select 'book_birthday_slot',       to_regprocedure('public.book_birthday_slot(jsonb,boolean)')   is not null
union all select 'workshops.spots_left gone',
  not exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='workshops' and column_name='spots_left')
union all select 'unique slot index (0022)',
  exists (select 1 from pg_indexes
           where schemaname='public' and indexname='workshop_sessions_live_slot_key')
union all select 'book_session_seats retry-safe (0028)',
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
    like '%Already written by an earlier attempt whose reply never arrived%'
union all select 'book_session_seats session guard (0029)',
  pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure)
    like '%not linked to a workshop session%'
union all select 'queue.queue_number column (0030)',
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='queue' and column_name='queue_number')
union all select 'queue date+number unique index (0030)',
  exists (select 1 from pg_indexes
           where schemaname='public' and indexname='queue_date_number_key')
union all select 'next_queue_number function (0030)',
  to_regprocedure('public.next_queue_number(date)') is not null
union all select 'next_queue_id gone (0030)',
  to_regprocedure('public.next_queue_id(date)') is null;
```

→ every row `present = true`. Anything false did not apply, whatever the editor appeared to say.

Generalise the pattern for future batches: assert the objects exist rather than trusting that
running the script means it ran.

### Dropping a primary key on a published table fails mid-transaction

Every table the app touches is in the `supabase_realtime` publication — 17 of them, listed in
`0002_capacity_rpc.sql:190-195`: `workshops`, `workshop_sessions`, `bookings`, `queue`, `pieces`,
`piece_history`, `categories`, `notifications`, `pipeline_stages`, `staff`, `workshop_options`,
`event_options`, `events`, `app_settings`, `customers`, `birthday_packages`, `studio_resources`.

A published table's **default replica identity is its primary key**. Drop the key and the table has
none, and Postgres then refuses every further UPDATE and DELETE on it:

```
ERROR 55000: cannot update table "x" because it does not have a replica identity
             and publishes updates
```

This bites **mid-transaction**, after the earlier steps have already run, so the whole migration
rolls back and has to be re-run from the top. `0030` hit it on its first attempt.

**The fix is `REPLICA IDENTITY FULL` for the duration, restored afterwards** — see `0030` step 5
for the pattern, including capturing the previous setting in case it was already FULL.

**Do NOT drop the table from the publication and re-add it.** `alter publication` needs ownership
of `supabase_realtime`, which `0002:179-183` records the SQL editor's role not having on this
project — it wraps every `add table` in an exception handler for exactly that reason. If the drop
succeeded and the re-add silently failed, the table would simply stop publishing and the affected
screen would go stale with no error anywhere.

Also expect a burst of realtime UPDATE events if the migration rewrites key values: a console left
open across it can end up holding both the old and the new row. Harmless and self-correcting, but
tell staff to reload afterwards.

Confirm membership and the current setting before planning any such migration:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
select relreplident from pg_class where oid = 'public.<table>'::regclass;  -- d, f, n or i
```

### Reload the PostgREST schema cache after adding or changing a function

```sql
notify pgrst, 'reload schema';
```

PostgREST caches the database schema, so a call to a genuinely new function can fail with
*"Could not find the function public.<name>(<args>) in the schema cache"* until it reloads. Cheap
to run, so do it as part of applying any migration that touches a function.

**Two things that make this error misleading.** The argument list in it is alphabetised by
PostgREST, not the order anything sent, so it reads as an argument-order mismatch and sends you
into the call site — it is not one. And the identical message appears when the function simply does
not exist, which is far more likely. **Check the function is really there before assuming a cache
problem** — that is what the verification query above is for.

One genuine third cause: a function with defaulted parameters resolves against a different
signature when a caller omits one. If the object exists, the cache has reloaded, and the call omits
an optional parameter, that is a real ambiguity.

---

## Needs client sign-off

### Birthday override UI — confirm dialog + timeline entry

`book_birthday_slot` (migration 0027) accepts `p_allow_override`, honoured only for callers
passing `is_staff()`. Staff-sourced bookings (`Admin`, `Walk-in`) currently pass `true`, which
preserves the behaviour staff had before the maxima were enforced at all.

That is a safe default, **not** the intended end state. The agreed design is:

- Staff are blocked by the same maxima as customers.
- The console names the limit and offers an explicit "Book anyway — this exceeds the daily
  maximum".
- The reason is recorded on the booking's timeline, so the exception is visible afterwards.

Rationale: the maxima are studio policy, not a physical constraint, and staff legitimately need
to exceed them (a private buyout). But staff double-book by accident far more often than they buy
out a studio, so a silent exemption solves the rare case and leaves the common one unprotected.

**Correction — the override is currently unreachable.** `addBooking` is called from exactly one
place, customer checkout, which always passes `source: 'Website'`. The wiring in `AppContext`
(`p_allow_override: source === 'Admin' || 'Walk-in'`) is therefore always false, because nothing
creates a booking with either source: the console creates *queue* rows, and the walk-ins shown on
the Bookings page are queue rows rendered in booking shape, not booking writes.

So the strict behaviour is already live — staff cannot exceed the maxima today, not because the
override is disabled but because staff cannot create birthday bookings through the app at all. The
mechanism in `book_birthday_slot` is correct and takes effect the moment a staff booking UI passes
`source: 'Admin'`. Nothing needs changing now; the note exists so the next person does not read the
wiring as active.

---

## Known limitations

### Customer "My Pieces" does not live-update

Customer pottery reads come from the `customer_pieces` / `customer_piece_history` views, which is
what keeps `damage_note` unselectable. Postgres emits `postgres_changes` for tables, not views, so
the list is correct on load but will not update while a customer sits on it. Staff, reading the
base tables, still get realtime.

Fixing it needs either a replication-backed alternative or a manual refresh control.

### Seat counts do not live-update

Same shape, different cause: seat counts come from RPCs (`session_seats_summary`), and an RPC
result is not a subscription. Counts are refetched on mount, when the session id set changes, when
the signed-in session changes, and via `notifySeatsChanged()` after any write that moves a seat.
Deliberate — seats are read far more often than they change, and `book_session_seats` holds the
real guarantee under a row lock.

### `parseBookingDateTimeToRiyadhDate` returns a browser-local Date

`dateUtils.ts:62` returns `new Date(y, m, d, h, min)`, which is built in the **browser's**
timezone, not Riyadh. Correct for the same-day comparisons it was written for, wrong for anything
absolute.

It is used by the session generator's past-slot guard and the workshop detail page's cutoff logic,
so a customer browsing from a different timezone may see a different set of bookable slots than a
customer in Jeddah.

Found while writing the `.ics` export on the booking confirmation screen, which deliberately does
not use it — that converts to UTC with a fixed +03:00 offset instead, so the calendar entry is
correct wherever it is opened.

Needs its own investigation before launch.

### A session expiring mid-checkout loses the form

`pendingBooking` is React state in `AppContext` and the checkout fields are local state in their
own components — none of it is persisted. So a session that expires while a customer is filling in
checkout takes the draft with it. The M3 fix explains why that happened rather than preventing it.
Persisting `pendingBooking` is separate work and is not done.

### The workshop info strip has no row logic

The Duration / Ages / Tutor / Location strip (`WorkshopDetailSection.tsx:369`) renders four
unconditional cells plus one per enabled, customer-visible, non-system workshop field. The cell
count is therefore `4 + N`, and no cell knows whether it ends a row — the borders are a flat
`border-b` on every cell plus `border-e` from `sm` up, with `last:border-e-0` clearing only the
final one.

With an odd count this shows in two places:

- **Mobile** (2 columns): the last row is half empty — one cell, one blank half.
- **Desktop** (4 columns from `lg`): cells that fall at the end of a row keep their `border-e`,
  because only the very last cell is cleared, so a stray vertical rule sits against the container
  edge. The same flat `border-b` also doubles against the container's bottom border on the last
  row. Both predate the mobile work.

Not currently reachable: the stored `workshopFieldConfig` holds 12 fields, all `system: true`, so
zero pass the filter and every workshop renders exactly 4 cells. It becomes reachable the moment
the client adds one custom customer-visible field in Settings.

Fixing it properly means row-aware borders — the cell count is dynamic, so that is either
`nth-child` arithmetic keyed to each breakpoint's column count, or extending the `gap-px` treatment
now used below `sm` to all widths. The latter is cleaner but changes the desktop rendering, which
was explicitly out of scope for the pass that introduced it.

### The migration warning covers the mobile tab bar — RESOLVED BY REMOVAL

`MigrationWarning` (`src/components/MigrationWarning.tsx:32`) is `fixed bottom-4 left-4 right-4` at
`z-[100]`, and the customer tab bar was `z-40`, so the warning rendered over the navigation and
covered it while showing.

Resolved without touching `MigrationWarning`: the mobile tab bar has been removed entirely — the
hamburger menu in the header already carries all five destinations, and a persistent bottom nav is
an app pattern rather than a site one. With no bottom navigation to cover, the overlap cannot
occur. The warning is unchanged and still the only fixed bottom-anchored element outside the
birthday flow.

### Every safe-area term evaluates to 0px — the viewport meta lacks `viewport-fit=cover`

`index.html:5` is:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

Without `viewport-fit=cover`, iOS keeps the layout viewport inside the safe area and never extends
it under the home indicator or the notch. `env(safe-area-inset-*)` therefore resolves to **`0px`**
on every device. Every safe-area term written in this codebase has been inert since it was added —
nothing is broken by it, but none of it has ever done anything either.

Currently one live consumer, after the tab bar's removal:

- `BirthdayBookingSection.tsx` — the mobile summary bar's toggle,
  `pb-[calc(0.875rem+env(safe-area-inset-bottom))]`. It is the bottom-most fixed element on that
  page, so it is the one place the inset would matter.

**Adding `viewport-fit=cover` is not a free change** and is deliberately not done here. It opts the
whole page into drawing under the system UI, so it would affect more than the one bar above:

- The birthday summary bar would gain real bottom padding on notched iPhones — the intended effect,
  and the only clearly positive one.
- Every page's content would extend under the home indicator at the bottom and under the status bar
  at the top. Anything flush to a screen edge would need its own inset handling, including the
  sticky header (`CustomerHeader.tsx:42`) and the footer.
- `100vh` / `100dvh` values start including the area behind the system UI, which changes the
  auth split-screen (`AuthSection.tsx:527`, `:534`, `:610`, all `calc(100vh-5rem)`) and the
  modals now capped at `calc(100dvh-2rem)`.

So it is a whole-app layout decision, not a meta-tag tweak. Worth doing deliberately if the site is
ever installed as a PWA or wrapped, where drawing edge-to-edge is expected; not worth doing for the
single bar that currently reads the inset.

### Modals still overflow on iOS when the software keyboard is up

`PrePaymentPopup` and the sign-in modal in `CheckoutInfoSection` are now capped at
`max-h-[calc(100dvh-2rem)]` with the body scrolling, so content taller than the screen is reachable
instead of clipped. That fixes the general case but not the keyboard case on iOS Safari: the
software keyboard does **not** shrink `dvh`. It reduces the *visual* viewport only, which is
exposed through `window.visualViewport` and nothing else — `100dvh` still resolves to the full
layout viewport with the keyboard open.

The practical effect on the sign-in modal at 375×667: the keyboard takes roughly half the screen,
the panel is still sized against all 667px, and the part behind the keyboard can only be reached by
scrolling. Better than being clipped dead, but the panel is not sized to what the customer can
actually see.

Fully solving it means listening to `visualViewport` `resize`/`scroll` and driving the cap from
`visualViewport.height` rather than `dvh`. That is a behavioural change with a listener and
teardown, so it was deliberately left out of the presentational pass that capped these two. It
belongs in one shared modal shell rather than being written twice — see the note about the two
notification bells for the same shape of problem.

### Two definitions of a consumed seat, already drifted

`getSessionSeatUsage` (`queueUtils.ts`) requires `q.type === 'With Instructor'` before counting a
queue row. `session_seats_taken` (migration 0002) does not filter on type at all — it counts any
queue row with a `session_id` and no `booking_id`. So a self-guided walk-in linked to a session is
counted by the database and not by the staff console.

Neither is obviously wrong; they simply disagree. Found while tracing the queue id collision
(migration 0030), deliberately left out of that change so its diff stayed about one thing.

### `addQueueItem` does not notify seat readers

Seat counts come from an RPC and are refetched via `notifySeatsChanged()`. Only the three booking
writes call it — `addQueueItem` does not. So a walk-in check-in consumes a seat that a customer
page already open will not see until something else triggers a refetch.

### Birthday maxima are declared twice

`BIRTHDAY_DAILY_MAX` / `BIRTHDAY_SAME_SLOT_MAX` in `src/utils/queueUtils.ts`, and again in
`book_birthday_slot` (migration 0027). The function enforces them and cannot read the TypeScript
constants. Warning comments sit on both sides.

Reading them from `app_settings` instead would cost a lookup on every booking to avoid a rare
edit — judged the wrong trade. Change both together.

---

## Diagnosed, not fixed

### AuthSection: a gap opens between the tab row and the form, mobile, one direction only

**Not diagnosed.** Four hypotheses were eliminated against evidence from the device; the mechanism
is still unknown. Do not start from a fifth theory — start from the measurement at the bottom of
this entry.

**Symptom.** On a phone: load Sign In, switch to Create Account, switch back to Sign In. A large
empty gap appears between the tab row (`AuthSection.tsx:628`) and the form. Tall → short only; the
reverse is clean.

**Two facts that constrain any explanation, both confirmed on-device:**

- **Stateful.** A cold load of Sign In, with no tab switching, has **no gap**. It only ever appears
  after a Create Account → Sign In switch.
- **Survives reduced motion.** With `prefers-reduced-motion: reduce` active, the gap is unchanged.
  Verified that the setting is actually being read: the tab pill at `:651` is
  `layoutId={prefersReducedMotion ? undefined : 'auth-tab-pill'}`, and it **jumps** rather than
  slides, so `useReducedMotion()` is returning `true`.

Those two together are what make this hard. With reduced motion on, `layout` is `false`,
`initial` is `false` and `exit` is `undefined` — every Framer behaviour in the subtree is disabled,
so the switch is a plain React re-render, which should not leave height behind. Yet the gap is
stateful, so it cannot be static CSS either.

**Eliminated, with what killed each:**

| Hypothesis | Killed by |
|---|---|
| Framer `layout` projection residue on `:616` | Pill jumps → `layout` is off → gap persists anyway |
| `min-h-full` on `:610` resolving against a stale grid row | No definite-height ancestor. `App.tsx`'s `<main className="flex-1 w-full">` is `display: block`, so its stretched height does not reach the grid; `.page-transition` sets no height; `:527`'s min-height is `lg:`-gated. `min-height: 100%` against an indefinite grid area resolves to `auto` |
| `align-content` stretching the auto-sized grid rows | Same cause — requires the grid container to be taller than its rows, which the chain above rules out |
| `AnimatePresence mode="wait"` holding the exiting form mounted | `animation-state.mjs:94` resolves `exit` as `props.exit ?? context.exit`; it does **not** fall back to `variants.exit`. The parent `motion.div` at `:616` has no variants, so both are `undefined`, which hits the early-skip at `:126` (`!prop && !typeState.prevProp`). No exit animation is created, so it resolves immediately. Also checked: no nested `motion` components exist inside either form (lines 707–870, 871–983), so nothing else can register with the presence context |

**Worth knowing — this is the third generation of the same shape.** `git log -S` on the block:
`5ff32b3` had an ungated `min-h-[550px]` on a stacking grid; `8e0fcaa` replaced it with an ungated
`min-h-[calc(100vh-5rem)]` plus `items-center`; `e59c1cc` gated the tall min-height to `lg:` but
left `min-h-full` on `:610` and `flex flex-col justify-center` on `:674`. Both of those are
vestigial — the residue of a container that used to be deliberately taller than its content. They
are not the current cause, but they are the reason a gap has somewhere to go if anything ever does
over-size that box, and they are the first thing to consider removing once the mechanism is known.

**Start here.** Reproduce the gap, then run this in the console. `childrenH` is the key output: it
says which direct child of the card owns the extra height, which is the question all four dead
hypotheses were circling.

```js
const card = document.querySelector('.max-w-md');
const form = card.querySelector('.flex.flex-col.justify-center');
console.log({
  cardStyle: card.getAttribute('style'),
  cardH: card.getBoundingClientRect().height,
  formStyle: form.getAttribute('style'),
  formH: form.getBoundingClientRect().height,
  formScrollH: form.scrollHeight,
  childCount: card.children.length,
  childrenH: [...card.children].map(c => [c.className.slice(0, 40), c.getBoundingClientRect().height])
});
```

If `formH > formScrollH`, the box is over-tall and `justify-center` at `:674` is merely revealing
it. If they match, the space is outside that element and the tab row's `mb-8` or `:610`'s padding
is where to look. Also worth checking whether a second form is still in the DOM — search the
subtree for the "Create Account" heading.

### No SMS or in-app notification on customer self-cancellation — RESOLVED

In-app: written inside `cancel_own_booking` (0031; wording updated in 0048). SMS:
`notify-own-booking`, which sends only a registered template that is true for the booking — none
for a booking that was never paid or a refund that is still due (no such template is registered
yet).

---

## Cleanup

### Customer notifications are matched on phone, not customer_id

`CustomerNotificationBell` (and the My Pieces banners before it) select a
customer's notifications with a digits-only comparison of `n.customerPhone`
against `currentUser.phone`. The `notifications` table is **already** scoped by
RLS to the signed-in customer (`notifications_customer_select`), so this second
filter adds nothing but a way to fail: a notification whose stored phone is
formatted differently from the customer's current one — a record created before
a number was normalised, or a customer whose number was corrected — never reaches
them, silently.

`customer_id` is the real link and is already on the row. Carried over unchanged
when the bell was built, deliberately: changing who sees which notification is
not a UI decision and should not ride along in a presentation pass.

### The notification bell is written twice

`AdminSidebar` builds its own bell inline (`:220-250`) around a hand-inlined SVG
rather than the lucide `Bell` the rest of the app uses, and clears by bulk-
deleting (`clearAllNotifications('staff')`). `CustomerNotificationBell` is a
separate component using lucide, marking individually read, and implementing the
outside-click and Escape handling the staff one lacks.

One shared component taking the icon, badge and panel, with the list and the
clear action passed in, is the better end state — the two will otherwise drift.
Not done here because it means editing the staff console, which the pass that
created the customer bell deliberately did not touch.

### The birthday band's text fails AA

The home page's birthday section sits on `brand-sage` (#7C8F80) with cream text.
Measured against that ground:

| | |
|---|---|
| `brand-cream` body copy, pill, ticket meta | **3.20:1** — under AA (4.5:1) |
| The 44px heading | 3.20:1 — passes as *large* text (3:1) |
| `brand-cream/80`, `/75`, `/50` tints | worse still |

#7C8F80 is mid-luminance, so nothing contrasts strongly with it in either
direction: cream is 3.20:1, white 3.45:1, and `brand-charcoal` only 4.52:1 —
passing with 0.02 of headroom, while `brand-ink` at 1.89:1 cannot be used on it
at all.

**Known and accepted for now, as a design decision.** Both alternatives were
built and rejected on the screen: a lighter band (`brand-sage-soft` #E7EBE4) made
the section read as empty, and charcoal-on-sage passes only by dropping every
tonal level — heading, body and captions all one colour, hierarchy carried by
size alone.

Revisit as an accessibility item rather than a colour preference. The realistic
fixes are a darker green than #7C8F80 that keeps cream above 4.5:1, or a
different treatment for the text block itself (a panel behind the copy), not
re-tinting the existing text.

### Deposit fallback hardcoded

The `500` deposit fallback is repeated in four places rather than read from one source.

### Data Reset — enforced server-side by 0051 (once applied)

Settings → Data Reset is Super Admin only in the UI and, from migration 0051, in the database:
the reset is one call to `reset_all_data()`, which refuses unless the caller is a Super Admin and
sends "DELETE EVERYTHING", and a guard trigger refuses any non–Super Admin statement that empties
bookings, customers, pieces, workshops, workshop_sessions, events or queue. Remaining limit: a staff
account can still delete rows one by one (staff need DELETE for normal work). notifications and
piece_history are not guarded (staff legitimately empty them; piece history cascades).

### 54 unused local variables

`tsc --noUnusedLocals` still reports 54 unused locals / destructured values (unused imports were
removed on 8 Nov 2026). Left alone on purpose: some are destructured from `useApp()` or kept for
behaviour; each needs a look rather than a bulk delete.

### Studio phone number hardcoded

Repeated across five components. Should come from `app_settings` alongside the other studio
details.

### Migration probes log errors on every public page load — FIXED

`checkMigrations()` (`src/lib/migrationCheck.ts`) pings every RPC with placeholder arguments on
mount to confirm it exists. Two of those pings were refused by design and surfaced as red console
errors on every signed-out page load — a `403` on `get_customer_summary` and a `400` on
`book_session_seats`. See "Investigated and explained" below for why each occurred.

**Fixed by removing both probes**, rather than skipping them for anonymous visitors or changing how
they're checked: each has a sibling probe from the same migration file that already succeeds
silently, so migration coverage is unchanged. `resolve_customer_record()` still verifies
`0003_customer_write_access.sql`; `release_booking_seats()`, `next_queue_number()` and
`session_seats_remaining()` still verify `0002_capacity_rpc.sql`. One migration applies as one
transaction, so any of those existing proves the removed probe's function exists too.

---

## Open from the QA report

Source: `ARTY_QA_Bug_Report.md` (manual testing, customer site sections 1–6 plus Live Queue).
Everything still open is reproduced here so this file is the single source.

Closed already: **H1** (duplicate session rows), **H2** (My Pieces), **M1** (seat-count display),
**N5** (generator past dates), **N2** (false email/SMS claim), **N8** (stat counted drafts),
**L3** (skill-level labels), **N6** (shared password state), **N7** (reset always reported success),
**L1** (native validation tooltips), **N3** (customer source always "Website"),
**N1** (confirmation links routed to password reset — *fixed, not yet verified, see below*),
**M3** (no notice when a session expired), **L2** (investigated, not reproducible — see below).

Also closed, with no item number because it was not in the QA report: **the workshop grid showed
Archived workshops to customers** (it filtered `!== 'Draft'`). Found while fixing N8 and recorded
in that entry, noted here so it is findable on its own.

Still open: **M2**, **N4**, **L4**, the Live Queue modals, the three staff/manager questions,
and I1/I2.

### Medium-high

- **M2 — participant stepper does not cap to real availability.** On a session with 3 or 4 seats
  genuinely left, the `+` button still increments to 6 with no warning. The customer fills in the
  whole Customer Information step before being blocked at Confirm or Payment. Not an overbooking
  risk — the block is real and no row is created — purely the wasted journey. **Two parts:** cap
  the stepper to live remaining seats, and settle whether the hard cap of 6 is a deliberate
  per-booking limit.

  **Client has now answered: there is no per-booking limit.** So the hard cap of 6 is a bug, not a
  policy, and both parts collapse into one change — the stepper's maximum becomes the live
  remaining seats and nothing else. No UI copy is needed to explain a limit that should not exist.
  Unblocked and ready to build; no code has changed yet.
- **M3 — FIXED, and smaller than reported.** The report asked for revalidation on route change.
  Investigation found detection already worked: `@supabase/auth-js` registers its own
  `visibilitychange` listener and emits `SIGNED_OUT` when a refresh genuinely fails, which the app
  already handled by clearing the customer. What was missing was any *explanation* — the UI simply
  became signed-out mid-session. A `sessionExpired` flag now surfaces on the auth screen and the
  checkout payment step. Three guards stop it firing on a deliberate sign-out or on first load;
  they fail silent rather than loud. No `window.focus` handler was added — the SDK's coverage is
  enough and the remaining gap is narrow and self-correcting. **Was never a cross-customer leak.**

### Medium

- **N1 — FIXED, NOT YET VERIFIED.** The recovery effect routed to the reset-password screen
  whenever the URL fragment contained `access_token`, which every Supabase auth link carries —
  signup confirmation and email-change included. Now keyed on `type === 'recovery'`, checked in
  both the fragment and the query string. A link error still routes there deliberately, because
  that screen is the one that can explain an expired link.

  **Verification is outstanding.** The confirmation email redirects to the Vercel deployment, so
  the attempt made during the fix exercised the old build. Three checks against the deployed build:

  1. A **signup confirmation** link must land the user signed in, *not* on "Set a new password".
  2. A **password reset** link must still reach the reset screen. This is the regression risk —
     the fix narrows the condition, so what needs proving is that it did not narrow too far.
  3. An **expired link** must still land somewhere that explains itself.

  Was confirmed **not** a security bypass when reported: unconfirmed accounts are refused login,
  and the original password works straight after confirming.
- **N2 — confirmation screen claims an SMS and email were sent.** *"A confirmation email and SMS
  with parking guidelines has been sent."* Neither is sent, and neither is supposed to be. Either
  drop the claim or send the notification.
- **N3 — FIXED.** Wider than reported: `resolveCustomer` passed `p_source: null` and the RPC
  defaults a null to `'Website'`, so *every* customer row was tagged Website regardless of origin,
  not just Live Queue walk-ins. Source is now threaded from each caller using the
  `CustomerAccount` vocabulary — `'Workshop Booking'`, `'Birthday Package'`, `'Live Queue'`,
  `'Admin Created'`. Creation only: the RPC matches on phone then email and its UPDATE branch never
  touches the column. **No backfill** — existing rows stay `Website`, because inferring origin from
  earliest bookings would replace an obviously-unset field with plausible guesswork.
- **N4 — phone-only walk-ins cannot self-claim an account.** A customer with no email on file is
  told to ask the studio to add one, so they cannot self-serve at all. The real fix is SMS OTP
  claiming, which is a known unstarted feature rather than an isolated bug.
- **N6 — FIXED.** Sign In and Create Account shared one `password` state. The live strength
  checklist under the Create Account field read that same shared value, so it would have sat
  unmoving while the customer typed — not in the report. Create Account now has its own
  `registerPassword`. Separate state rather than clearing on tab change: six places in that file
  switch screens, and a seventh added later would silently reintroduce it.
- **N7 — FIXED.** Split by kind. An infrastructure failure (429/5xx, rate limit, SMTP, provider,
  timeout) now returns a real error the customer can act on; a per-account failure stays behind the
  generic message, because naming those would turn the form into a way of discovering which
  addresses have accounts. The three call sites already branched on `res.success` and needed no
  change.
- **N8 — FIXED.** The home page stat counted every row in `workshops`. Both it and the "View All"
  count on the same page (not in the report, same bug) now read one `publishedWorkshops` list.
  Fixed alongside it: the workshop grid filtered `!== 'Draft'`, so **Archived** workshops stayed
  visible and bookable to customers, and the grid and the stat were counting by two different
  rules. Both are now `status === 'Published'`.

### Low

- **L1 — FIXED.** The app rules already existed and were simply never reached: native validation
  runs before the submit handler. The email input is now `type="text"` with `inputMode="email"` and
  `autoComplete="email"` so the mobile keyboard and autofill are unchanged, and `required` is
  dropped from `PhoneInput` with the asterisk moved into the label. Phone validation itself is
  untouched — whether non-Saudi numbers are accepted is still a client question.
- **L2 — CLOSED, not reproducible.** Reported as `cancel_own_booking` advancing `updated_at` when
  cancelling an already-cancelled booking. It does not: the function returns at the
  `already_cancelled` guard (`0017_cancel_own_booking.sql:151`) **before** the `update` at `:200`,
  so no write to `bookings` happens on that path, and there is no trigger on the table. The only
  other `updated_at = now()` in the function is on `queue`. Confirmed against the database — every
  cancelled row has `updated_at` later than `created_at`, but all are genuine first cancellations,
  so nothing there evidences a no-op write. Do not re-open from the report without a reproduction.
- **L3 — FIXED.** Renamed to "Any level" (no filter) and "Suitable for all levels" (the tag), so
  the two differ in kind and not just wording. Filter values are unchanged. The workshop card still
  renders the raw `All Levels` tag; mapping the display there too was judged not worth a third
  file.
- **L4 — stale "Registered" badge after an auth record is deleted directly in Supabase.** Exact
  mechanism confirmed: `customers.user_id` is `references auth.users(id) on delete set null`
  (`0001_init.sql`), so deleting the auth user correctly nulls `user_id` via the FK cascade. But
  `hasWebsiteAccount()` (`src/utils/accountUtils.ts`) treats the record as registered if *any* of
  three signals is present — `user_id`, `has_account`, or `password` — and only `user_id` is
  FK-protected. `has_account` and `password` are left exactly as they were, so the row ends up
  self-contradictory (`user_id` null, `has_account` still true) and the badge keeps reading
  "Registered". Caused by an out-of-band database edit, not any in-app flow — no in-app path
  deletes an `auth.users` row today, so this cannot be triggered from the app itself, and no fix
  is needed unless account deletion or merging is ever built into the app.

### Live Queue modals

- **Unbounded modal height.** Reported as **H3**: the "Add Walk-In to Queue" modal overflows past
  the visible area at a normal window size and does not scroll, hiding the "Add to Queue" button
  itself and blocking a core daily task until the window is resized. Four Live Queue modals share
  this shape. Fix: scrollable body (`overflow-y: auto`) or cap to viewport height with the actions
  pinned.

### Needs confirmation from staff or the manager

- ~~**Participant cap of 6**~~ — ANSWERED: no per-booking limit. See M2, now unblocked.
- **Customer-facing add-ons (`workshop_options`)** — the table and data exist but no customer
  selector was found in the booking flow. Staff-only by design, or missing? Blocks QA test 3.3.
- **A "Cancelled" tab for My Reservations** — cancelled bookings currently stay in Upcoming until
  the session time passes, which matches the spec. Product question whether a dedicated tab would
  be better.

### Inconclusive — needs re-testing with a sound method

- **I1 / I2 — cross-customer and staff-table access under RLS.** The original attempt used the
  Supabase SQL Editor with `set_config('request.jwt.claims', ...)`, which connects as superuser
  and bypasses PostgREST, so **neither the pass on `bookings` nor the leak on `pieces` should be
  trusted**. Re-test with a real authenticated `fetch()` against the REST endpoint using a genuine
  customer access token. Worth doing — this is the only untested part of the security surface, and
  the H2 work has since changed what customers read.
- **I3 — Arabic / RTL.** Not built yet. Nothing to test until it ships.

---

## Found during the capacity investigation

Diagnosed while looking at something else, deliberately not fixed.

- **Live Queue staff cancel releases nothing.** Cancelling from the Live Queue does not release
  the seat and sends no notification, unlike the other cancellation paths.
- **"Forfeited" marks a booking Refunded.** The Forfeited action on the Bookings page sets the
  payment status to Refunded, which is the opposite of what forfeiting a deposit means, and is
  wrong in the customer's records and in any revenue figure derived from them.
- **Five cancellation paths, five behaviours.** Customer self-cancel, staff cancel on Bookings,
  Live Queue cancel, auto-cancel, and no-show each differ in what they release, what they notify,
  and what they record. They should agree, and any difference should be deliberate.
- **Walk-in workshop occupancy drift.** Walk-in workshop customers did not decrement the old
  per-workshop counter. That counter is now gone and customer-facing seats are counted from the
  bookings and queue directly, so the *display* is correct — but this should be re-confirmed
  end-to-end for a walk-in, since it was never verified after the change.

---

## Found during concurrency testing — fixed in 0029

Both found while writing the Block 4 race tests in `docs/manual-test-m1-capacity.md`. Neither was
reachable through the UI, but both functions are executable by `anon`, so both were reachable by a
crafted request. **Both fixed in migration `0029`**; kept here as the record of what was wrong and
why, since neither is visible from the current function bodies.

### `book_session_seats` / `book_birthday_slot` bypass column defaults

Both RPCs insert with:

```sql
insert into public.bookings
select * from jsonb_populate_record(null::public.bookings, p_booking);
```

`jsonb_populate_record` over a **null** base produces a full row with `null` in every key the JSON
omitted, and `select *` inserts those nulls explicitly. An explicit null overrides a column default,
so defaults never apply through this path.

Not currently breaking anything — the client sends a complete object. The risk is future: any
column added later as `NOT NULL DEFAULT ...` will break customer checkout **at runtime with a
23502, not at deploy time**, and the migration adding it will look entirely safe.

Surfaced by a race-test payload missing `created_at`, which failed with *"null value in column
`created_at` of relation `bookings` violates not-null constraint"* despite `created_at` having a
`now()` default.

**Fixed in `0029`.** The payload is merged over a defaults object at the top of each function
(`defaults || p_booking`), so everything downstream sees one normalised object and any
caller-supplied key still wins. `id` and `date` are deliberately not defaulted — neither has a
default in the table, and a payload missing either is genuinely incomplete and must keep failing.

An explicit `null` in the payload also wins over the default and will still fail the constraint.
That is deliberate: omitting a key is an incomplete payload, sending `null` for it is a statement,
and only the first should be filled in.

The defaults are now duplicated from `0001_init` into both functions, with a warning comment on
each. They must be changed together.

### `book_session_seats` skips capacity checks when `p_session_id` is null

The row lock (`select ... for update` on `workshop_sessions`) and the capacity check both sit
inside `if p_session_id is not null then`. A request that passes `p_session_id: null` while
carrying a `session_id` **inside** `p_booking` inserts a seat-consuming booking with no capacity
check at all.

Not reachable through the UI — the client always passes the parameter — but the function is
executable by `anon`, so this is a crafted-request hole rather than a theoretical one.

`book_birthday_slot` had the same hole from the other direction, which the original entry missed.
It never looks at `session_id` — but `session_seats_taken` counts bookings by `session_id` **with
no `workshop_id` filter**, so a birthday-routed payload carrying a real `session_id` consumed
workshop seats through a function that checks only dates and slots. A second unguarded path to the
same outcome.

**Both fixed in `0029`.** `book_session_seats` now resolves the session as
`coalesce(p_session_id, p_booking->>'session_id')` and refuses when neither is present; the lock
and the capacity check no longer sit inside a conditional that can be skipped.
`book_birthday_slot` refuses any payload carrying a `session_id` at all.

Side effect worth knowing: `migrationCheck.ts` probes `book_session_seats` on every page load with
a null session, so that probe now returns the "not linked to a workshop session" refusal instead of
a 23502. `rpcExists` still passes — it only cares that the error is not function-not-found — but
the console text on a signed-out page load changed, and nothing else would explain why.

---

## For the client — scoping

- **Do item sales and counter payments belong in this app at all?** Both were partially built. They
  are point-of-sale concerns rather than booking concerns, and half-implementing them is worse
  than either finishing or removing them. Needs a decision before more work goes in either
  direction.

---

## Investigated and explained — no action needed

Recording these so they are not re-reported. Two errors used to appear in the browser console on
every page load when signed out:

- `403` on `get_customer_summary`
- `400` on `book_session_seats`

**RESOLVED — both probes removed.** They were deliberate probes, not faults: `MigrationWarning`
calls `checkMigrations()` (`src/lib/migrationCheck.ts`) on mount, which pinged every RPC with
placeholder arguments purely to see whether it exists, and `rpcExists` treated *any* error other
than "function not found" as proof the function is present, so both responses were the intended
outcome:

- `get_customer_summary` returned 403 because migration `0011` revoked it from `anon` to close an
  anonymous PII enumeration hole. Anonymous callers are *supposed* to be refused.
- `book_session_seats` returned 400 because the probe passed `{ p_booking: {}, p_session_id: null }`,
  which the function correctly rejected. A 400 here meant "exists, and validated its input".

**The one real (cosmetic) issue** was that these were logged as errors on every public page load,
which read as a fault to anyone opening devtools — including whoever reported it next. Fixed by
removing both requirement entries from `MIGRATION_REQUIREMENTS` rather than skipping them for
anonymous visitors or changing how they're checked: each has a sibling probe from the same
migration file (`resolve_customer_record()` for 0003; `release_booking_seats()`,
`next_queue_number()` and `session_seats_remaining()` for 0002) that already succeeds silently, so
migration coverage is unchanged.
