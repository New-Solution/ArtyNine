# Arty Café — Project Notes for Maintainers

For the long-term maintainers. This is the map: what runs where, what each
piece is for, and where to look when something goes wrong. Detailed procedures
live in the files linked from here; this file does not repeat them.

Last reviewed: 8 Nov 2026 (after migration 0051).

**Never write a secret value in this file, in a commit, or in a chat.** Names
only. Values live in the Supabase dashboard / CLI secrets and in the Cloudflare
Pages project settings.

---

## 1. Architecture

```
 Customer site  ─┐                       ┌─ Supabase Postgres (data, RLS, RPCs)
 (Cloudflare     │  supabase-js (anon    ├─ Supabase Auth (phone OTP / email)
  Pages)         ├─ key + user JWT) ───► ├─ Supabase Storage (photos)
 Staff console  ─┘                       └─ Supabase Edge Functions (Deno)
 (Cloudflare                                   │            │
  Pages)                                       ▼            ▼
                                        Moyasar API    SMS provider
                                        (payments)     (mShastra / meertek)
```

- **One React + Vite codebase** (`src/`) builds both the customer site and the
  staff console. Which one a deployment is depends on its
  `VITE_CUSTOMER_SITE_URL` / `VITE_STAFF_SITE_URL`. With neither set (local
  dev) the app switches areas in-app.
- **No application server.** The browser talks to Supabase directly. Every
  rule that matters (prices, seats, who can see what, who can mark something
  paid) is enforced **in Postgres** with RLS and `SECURITY DEFINER` functions,
  never trusted from the browser.
- **Edge Functions** do the things that need a secret: talking to Moyasar,
  sending SMS, creating staff logins, and the scheduled auto-cancel job
  (triggered every 5 minutes by **pg_cron** in the Supabase project).
- **Hosting:** Cloudflare Pages. Pushing `main` rebuilds the front end.
  Pushing does **not** apply migrations or deploy Edge Functions; both are
  manual (see §4 and §5).
- **Data access in the app:** `src/lib/supabaseDb.ts` (`sdb`, imported as
  `db` in `AppContext.tsx`) is a thin wrapper over Supabase tables. `db.x.clear()`
  is a live `DELETE` on production, not a cache clear. Since 0051 no app code
  calls it on a data table, and the database refuses a non–Super Admin
  statement that empties bookings, customers, pieces, workshops, sessions,
  events or the queue.

Key places in the code:

| Area | Where |
|---|---|
| Global state, all writes | `src/context/AppContext.tsx` |
| Checkout | `CheckoutInfoSection.tsx` → `CheckoutPaymentSection.tsx` → `MoyasarPaymentPanel.tsx` → `PaymentReturnSection.tsx` |
| Online payment helpers | `src/utils/onlinePayments.ts`, `src/lib/onlinePayment.ts` |
| Customer bookings page | `src/components/MyBookingsSection.tsx` |
| SMS texts (registered templates) | `supabase/functions/_shared/bookingSmsTemplates.ts`, `_shared/otpSms.ts`, `src/utils/pieceSmsTemplates.ts` |
| Arabic display of stored notifications | `src/utils/notificationText.ts` |
| System Health (staff) | `src/utils/systemTests.ts` |

---

## 2. External services

| Service | Used for | Where it is configured |
|---|---|---|
| **Supabase** | Postgres database, Auth (phone OTP + email/password), Storage (workshop and piece photos), Edge Functions | Supabase dashboard; `supabase/` in the repo |
| **Cloudflare Pages** | Hosting the customer site and the staff console | Cloudflare dashboard → Pages (two projects / deployments) |
| **Cloudflare Turnstile** | CAPTCHA on sign-in / sign-up (only when its key is set) | Site key in Pages env; secret key in Supabase → Authentication → Attack Protection |
| **Moyasar** | Card + Apple Pay payments; webhook as a backup confirmation path; refunds (done by hand in the Moyasar dashboard) | Moyasar dashboard (keys, webhook, Apple Pay domains) |
| **mShastra** | SMS provider (default) | Credentials as Supabase secrets |
| **meertek** | Alternative SMS provider, through a proxy endpoint (`fp.meertek.com/send`) | Token as a Supabase secret; picked with `SMS_PROVIDER=meertek` |
| **Apple Pay** | Via Moyasar; needs the domain file `public/.well-known/apple-developer-merchantid-domain-association` and the domain registered in Moyasar | Moyasar → Settings → Apple Pay Domains |
| **GitHub** | Source (`New-Solution/ArtyNine`) | — |

---

## 3. Configuration by NAME (never values)

### Cloudflare Pages environment variables (front end, build-time, public)

Everything prefixed `VITE_` is baked into the JavaScript and visible to anyone.
Only public values belong here. Change one → **redeploy** for it to take effect.

| Name | What it does |
|---|---|
| `VITE_SUPABASE_URL` | The Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | Supabase public (anon) key. Safe in the browser; RLS protects data. |
| `VITE_CUSTOMER_SITE_URL` | Link target for "Customer Site" from the console. Unset in local dev. |
| `VITE_STAFF_SITE_URL` | Link target for "Staff Login" from the customer site. Unset in local dev. |
| `VITE_PHONE_AUTH` | `"true"` turns on phone sign-in by SMS code (`src/utils/featureFlags.ts`). |
| `VITE_TURNSTILE_SITE_KEY` | Turnstile site key. Unset = no CAPTCHA widget. |
| `VITE_MOYASAR_PUBLISHABLE_KEY` | Moyasar publishable key (`pk_test_…` / `pk_live_…`). Unset = online payments cannot be switched on. |

Not read by the code (safe to remove from Cloudflare if present):
`VITE_MOYASAR_METHODS` (payment methods are fixed in `src/lib/onlinePayment.ts`,
`MOYASAR_METHODS`), `GEMINI_API_KEY`, `APP_URL`, `DISABLE_HMR` (AI Studio
template leftovers, removed from `.env.example` / `vite.config.ts` on 8 Nov 2026).

**Never** put the service-role key in Cloudflare or any `VITE_` variable.

### Supabase Edge Function secrets

Set with `npx supabase secrets set NAME=…`; list names with
`npx supabase secrets list` (values are never shown).

| Name | Used by | What it does |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | all | Provided by Supabase automatically. Service role bypasses RLS; used only server-side. |
| `MOYASAR_SECRET_KEY` | verify-payment, moyasar-webhook, auto-cancel-bookings | Moyasar secret key, to fetch payments. |
| `MOYASAR_MODE` | same | Optional `test` / `live`; the functions refuse to run if it doesn't match the key. |
| `MOYASAR_WEBHOOK_SECRET` | moyasar-webhook | The "secret token" configured on the Moyasar webhook. |
| `SMS_PROVIDER` | all SMS senders | Unset / `mshastra` (default) or `meertek`. |
| `MSHASTRA_USERNAME`, `MSHASTRA_PASSWORD`, `MSHASTRA_SENDER_ID` | SMS (mShastra) | mShastra account and sender name. |
| `MEERTEK_PROXY_TOKEN` | SMS (meertek) | Token for the meertek proxy endpoint. |
| `SEND_SMS_HOOK_SECRET` | send-sms-hook | The `v1,whsec_…` secret of the Supabase Auth "Send SMS" hook. |
| `STAFF_SITE_URL` | provision-staff | Where staff invitation emails point. |

Other secrets outside the functions: the Turnstile **secret** key (Supabase →
Authentication → Attack Protection); the scripts in `scripts/` read
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your own shell when you
run them.

---

## 4. Edge Functions

Deploy one: `npx supabase functions deploy <name>` (add `--yes` to skip the
prompt). `supabase/config.toml` turns JWT verification **off** for
`send-sms-hook`, `verify-payment` and `moyasar-webhook`; every other function
keeps it on. **Never run `supabase config push`** (see the warning in
`config.toml`).

| Function | Called by | What it does |
|---|---|---|
| `verify-payment` | the customer's browser after paying (and the 3-D Secure return page) | Fetches the payment from Moyasar with the secret key, logs it, and calls `confirm_booking_payment()`. The only normal path to "paid". |
| `moyasar-webhook` | Moyasar | Backup confirmation path: checks the secret token, re-fetches the payment, same confirm call. |
| `auto-cancel-bookings` | **pg_cron** in the Supabase project, **every 5 minutes** (job set up in the dashboard, not in a migration) | Cancels no-shows and expires unpaid holds, after first checking Moyasar for a payment that arrived without the customer coming back. Sends the no-show SMS. |
| `notify-own-booking` | the customer's browser after self-cancelling | Sends the cancellation SMS, only with a registered template that is true for the booking (none for unpaid or refund-due). |
| `send-sms` | staff console | Sends one SMS (staff only, `is_staff()` checked). |
| `send-sms-hook` | Supabase Auth | Delivers phone sign-in codes through our SMS provider. |
| `provision-staff` | staff console (admins) | Creates / invites staff logins and links them to `staff` rows. |

Shared code: `supabase/functions/_shared/` (SMS providers, Moyasar logic,
payment evidence, SMS templates). Changing a shared file affects every
function that imports it, but only takes effect for a function once **that
function is redeployed**.

Tests (plain assertions, no framework): `npx tsx <file>.test.ts`, see §10.

---

## 5. Migrations

Applied **by hand** in the Supabase SQL Editor, in order. Each new file ends
with a verification `select` (every column must be `true`) and a commented-out
`DO $$ … $$` test block that always ends in an error on purpose:
`ALL 00NN TESTS PASSED — rolled back` means success and nothing was kept.
After applying, set line 1 to `-- STATUS: APPLIED` in a commit.

Status below: **Applied** (header says so), **Applied (inferred)** for files
older than the STATUS convention (later applied migrations depend on them),
and ⚠ where the header disagrees with reality (see §11).

| # | What | Status |
|---|---|---|
| 0001 | Schema, RLS, security-definer helpers, config seed | Applied (inferred) |
| 0002 | Atomic seat allocation (`book_session_seats`) | Applied (inferred) |
| 0003 | Customer site write path | Applied (inferred) |
| 0004 | Assign a staff member to a birthday/event booking | Applied (inferred) |
| 0005 | Sign in with phone or email | Applied (inferred) |
| 0006 | Pottery pipeline clean-up | Applied (inferred) |
| 0007 | Pottery lifecycle: 3 customer-facing stages | Applied (inferred) |
| 0008 | Café table assignment for the Live Queue | Applied (inferred) |
| 0009 | Seed table inventory | Applied (inferred) |
| 0010 | Close walk-in account-takeover path | Applied (inferred) |
| 0011 | Close anonymous PII enumeration (`get_customer_summary`) | Applied (inferred) |
| 0012 | Unique staff work email | Applied (inferred) |
| 0013 | `customers` page permission in RLS | Applied (inferred) |
| 0014 | `pieces-admin` page permission in RLS | Applied (header: confirmed live) |
| 0015 | Pickup-reminder RPCs for the dashboard | Applied (inferred) |
| 0016 | Pickup-reminder SMS cooldown | Applied (inferred) |
| 0017 | Customer self-cancellation (`cancel_own_booking`) | Applied (inferred) |
| 0018 | Piece reassignment RPC (customer merge) | Applied (inferred) |
| 0019 | Pieces safety-check RPCs | Applied (inferred) |
| 0020 | Customer piece-count RPC | Applied (inferred) |
| 0021 | Storage buckets for photos | Applied (inferred) |
| 0022 | One live session per workshop slot | Applied (inferred) |
| 0023 | Batched seat counts | Applied (inferred) |
| 0024 | Workshop popularity counts | Applied (inferred) |
| 0025 | Drop `workshops.spots_left` | Applied (inferred) |
| 0026 | Birthday counts per date / slot | Applied (inferred) |
| 0027 | Atomic birthday slot allocation (`book_birthday_slot`) | Applied (inferred) |
| 0028 | Idempotent booking writes (retry can't double-book) | Applied (inferred) |
| 0029 | Booking RPC defaults + session guard | Applied (inferred) |
| 0030 | Queue surrogate key | Applied (inferred) |
| 0031 | In-app notification on self-cancel | Applied (inferred) |
| 0032 | Queue "without instructor" never links a session | Applied (inferred) |
| 0033 | Customer ids use a uuid suffix | Applied (inferred) |
| 0034 | `customers.preferred_lang` | Applied (inferred) |
| 0035 | Arabic content columns (workshops, packages) | Applied (confirmed 8 Nov 2026) |
| 0036 | `categories.name_ar` | Applied (confirmed 8 Nov 2026) |
| 0037 | Arabic birthday-package fields | Applied (confirmed 8 Nov 2026) |
| 0038 | Arabic workshop materials list | Applied (confirmed 8 Nov 2026) |
| 0039 | Arabic birthday-package lists | Applied (confirmed 8 Nov 2026) |
| 0040 | Stop anonymous writes to existing customer rows | Superseded by 0041 (its guard is live through 0041) |
| 0041 | Claim a customer record by verified phone | Applied |
| 0042 | No empty customer inserts | Applied |
| 0043 | Retire the sign-in lookup | Applied |
| 0044 | Signed-in customers always book on their own record | Applied |
| 0045 | Pieces point at a stage id | Applied |
| 0046 | Online payments: hold, verify, confirm | Applied |
| 0047 | Moyasar payment evidence log (append-only) | Applied |
| 0048 | Backstop trigger for payment holds; cancellation never marks unpaid as Refunded | Applied |
| 0049 | Bookings need a signed-in caller (no guest `customer_id`) | Applied |
| 0050 | Payments OFF: website bookings always `Unpaid` (+ backstop trigger) | Applied |
| 0051 | Data Reset only via `reset_all_data()` (Super Admin + phrase); guard refuses non–Super Admin table wipes | Applied |

Re-running an old test block after a later migration can fail by design (e.g.
0046/0048 guest cases are refused after 0049). That is not a regression.

---

## 6. Online payments end to end

Full runbook, deploy order and the manual test plan:
**[docs/manual-test-payments.md](manual-test-payments.md)**. Summary:

1. **Switch:** Settings → Online Payments (`app_settings` id `onlinePayments`).
   Workshop = deposit (default 100 SAR, never refunded), birthday = full price,
   hold 15 minutes. **Off = pay at the studio:** the checkout takes no payment,
   the booking is saved `Unpaid`, and the confirmation says "Pay at the studio"
   (0050 enforces `Unpaid` in the database). Until 8 Nov 2026 the off-mode
   checkout faked a payment and wrote `Paid`; the §8 query found no such
   bookings on 8 Nov 2026.
2. **Booking (customer must be signed in, 0049):** `book_session_seats` /
   `book_birthday_slot` create a **hold** — `Pending / Awaiting Payment`,
   price computed by the database, `payment_expires_at = now + hold`. The
   browser's price and status are ignored. A trigger (0048) refuses any
   non-staff website booking that isn't a proper hold.
3. **Paying:** Moyasar's form in `MoyasarPaymentPanel`. The amount comes from
   `booking_payment_quote()` (the database's number).
4. **Confirming:** `verify-payment` (or the webhook) fetches the payment from
   Moyasar with the secret key → `confirm_booking_payment()` checks currency,
   exact amount, single use → `Deposit Paid` / `Paid`. Paid after the hold
   expired: accepted if the place is still free, otherwise `Needs Refund` +
   staff notification.
5. **Expiry:** an expired hold stops taking its seat immediately;
   `auto-cancel-bookings` later marks it `Cancelled / Expired` (after checking
   Moyasar).
6. **Evidence:** every Moyasar response is stored as received in
   `moyasar_payment_events` (append-only; card token and webhook secret are
   refused by a constraint).

**Staff bookings are staff bookings.** A browser signed in to the staff
console that books on the customer site creates a normal staff booking (no
hold, no payment). That's by design and caused the 7 Nov "unpaid website
booking" scare.

### Refunds — always by hand

Nothing in the system moves money back. `Needs Refund` means "staff must act".

| Situation | What the system does | What staff do |
|---|---|---|
| Online **deposit**, customer cancels | Never refunded, stays `Deposit Paid` | Nothing |
| Online **full payment**, cancelled > 24h before | `Needs Refund`, staff notification with the Moyasar payment id | Moyasar dashboard → Payments → that payment → Refund. Then set the booking to `Refunded` in the console. |
| Paid **at the studio**, cancelled > 24h before | `Needs Refund`, staff notification "refund in person" | Refund at the desk, then set `Refunded`. |
| Any paid booking, ≤ 24h | Non-refundable, status kept | Nothing (unless the studio chooses to) |
| Never paid (Unpaid / unpaid hold) | Cancelled, stays unpaid | Nothing |
| Paid after the hold was gone / paid twice | `Needs Refund` + staff notification | Refund in Moyasar |

In the staff console, marking a booking "Refunded" does **not** return money;
the dialog says so.

### Testing with test keys

- Moyasar **test** keys in both places: `VITE_MOYASAR_PUBLISHABLE_KEY=pk_test_…`
  (Cloudflare, redeploy) and `MOYASAR_SECRET_KEY=sk_test_…` + `MOYASAR_MODE=test`
  (Supabase secrets). Settings → Online Payments shows "TEST key".
- Use an **incognito / private window**, signed in as a **customer** (phone
  sign-in), **never signed in to the staff console** in that browser — a
  staff session turns the booking into a staff booking with no payment.
- Test cards and every scenario: `docs/manual-test-payments.md` §2 onwards.
- Switching to live: change both keys together (`pk_live_…`, `sk_live_…`,
  `MOYASAR_MODE=live`); the functions refuse a mismatched pair.

---

## 7. SMS

- **Every SMS text must match a template registered with the SMS provider,
  character for character** (including the single `\n` between English and
  Arabic). Unregistered text is blocked or rejected by the provider.
- Booking cancellation texts: `supabase/functions/_shared/bookingSmsTemplates.ts`
  (`refunded`, `notRefunded`, `noShow`). Which one is sent is decided by
  `cancellationSmsKind()`; when none is true (never paid, refund due) **no SMS
  is sent**. To change that, register a new template first, then add it.
- Sign-in codes: `_shared/otpSms.ts`. Piece status / pickup: `src/utils/pieceSmsTemplates.ts`.
- Do not "improve" the wording of an existing template in code. If the wording
  must change, register the new text with the provider first.
- Templates not yet registered that would be useful: a plain "your booking
  was cancelled" (for unpaid cancellations) and "your refund is on its way"
  (for `Needs Refund`).

---

## 8. Common checks (SQL Editor, read-only)

Evidence log for one booking:

```sql
select received_at, source, event_type, status, amount_halalas, currency, moyasar_payment_id
from public.moyasar_payment_events
where booking_id = 'BOOKING-ID'
order by received_at;
```

Everything recorded about one Moyasar payment:

```sql
select * from public.booking_payments where id = 'MOYASAR-PAYMENT-ID';
select received_at, source, status, raw from public.moyasar_payment_events
where moyasar_payment_id = 'MOYASAR-PAYMENT-ID' order by received_at;
```

Stuck holds (expired more than 10 minutes ago, not yet expired by the job →
check the auto-cancel schedule):

```sql
select id, customer_name, date, time, online_amount, payment_expires_at
from public.bookings
where payment_status = 'Awaiting Payment'
  and payment_expires_at < now() - interval '10 minutes'
order by payment_expires_at;
```

Refunds staff still owe:

```sql
select id, customer_name, customer_phone, total_price, online_amount, moyasar_payment_id, updated_at
from public.bookings
where payment_status = 'Needs Refund'
order by updated_at;
```

Online setting as the database reads it:

```sql
select public.online_payments_config();
```

Website bookings marked paid with no online payment — the old simulated
checkout wrote these with payments off. Some may have been genuinely paid at
the studio later; the last timeline entry helps tell them apart. Read-only:

```sql
select id, created_at, customer_name, customer_phone, workshop_title, date, time,
       total_price, payment_status, status,
       timeline->-1->>'action' as last_timeline_action
from public.bookings
where source = 'Website'
  and payment_status in ('Paid', 'Deposit Paid')
  and moyasar_payment_id is null
order by created_at desc;
```

Which version of a function is live (look for the migration's marker comment):

```sql
select pg_get_functiondef('public.book_session_seats(jsonb,text)'::regprocedure);
```

---

## 9. Lessons learned

- **The database decides; the browser only displays.** Prices, payment status,
  seat counts and ownership are enforced in Postgres. A browser value is a
  suggestion.
- **A staff session changes the rules.** Test customer flows in a private
  window that has never signed in to the console.
- **Inside `SECURITY DEFINER`, `current_user` is the function owner.** To know
  who is calling, use `auth.uid()` / `is_staff()`, or `current_setting('role')`
  (0048's trigger).
- **`jsonb_populate_record` ignores column defaults** (fills NULL) — the booking
  RPCs restate the defaults (0029).
- **Deploy order matters.** Deploy an Edge Function that understands a new
  database state *before* applying the migration that creates it (0048 /
  `notify-own-booking`).
- **Never store the card token** (`source.token`) or the webhook secret; 0047
  refuses them with a constraint.
- **Cancellation must tell the truth:** never "refunded" for money that was
  never paid or not yet returned (0048).
- **Every migration keeps its STATUS line honest**, and re-running an old test
  block after later migrations may fail by design.
- **Copying from the SQL file:** paste the migration (top → verification
  `select`) and the test block (`DO $$` → `END $$;`, without `/*` `*/`) as two
  separate queries.
- **Settings → Data Reset deletes live data** (bookings, customers, queue,
  pieces, notifications…) for everyone. It is shown only to a Super Admin,
  needs "DELETE EVERYTHING" typed, and (0051) is a single call to
  `reset_all_data()`, which the database refuses for anyone but a Super Admin
  with that phrase. It leaves a "Data Reset" staff notification naming who ran
  it.
- **Never fake a payment in the UI.** The simulated checkout recorded `Paid`
  for money that never moved, for months. Payment status must come from the
  database or from a staff action.
- **Shell quoting on Windows:** `notepad supabase\migrations\…` typed into a
  bash shell drops the backslashes and creates an empty file in the repo root;
  use forward slashes.

---

## 10. Everyday commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Local dev | `npm run dev` (port 3000) |
| Type-check | `npm run lint` |
| Build | `npm run build` |
| Tests | `npx tsx src/utils/<name>.test.ts`, `npx tsx supabase/functions/_shared/<name>.test.ts`, `npx tsx supabase/functions/<fn>/logic.test.ts` (each prints `N passed, 0 failed`) |
| Deploy an Edge Function | `npx supabase functions deploy <name>` |
| Edge Function secrets | `npx supabase secrets list` / `npx supabase secrets set NAME=…` |
| Create the first Super Admin | `npm run create-super-admin` (service-role key from your shell) |

Other docs: `docs/manual-test-payments.md` (payments runbook + tests),
`docs/manual-test-admin.md`, `docs/manual-test-customer.md`,
`docs/manual-test-m1-capacity.md`, `docs/stage-3-ui-notes.md`,
`docs/parked-work.md` (deferred issues; updated 8 Nov 2026).

---

## 11. Open housekeeping (8 Nov 2026)

- **0051's limit:** a staff account can still delete rows one at a time
  (staff need DELETE for normal work); only "empty the table in one go" is
  refused.
- **0001–0034** have no STATUS line (older than the convention).
- **54 unused local variables** reported by `tsc --noUnusedLocals` (unused
  imports were removed); each needs a look, see `docs/parked-work.md`.
