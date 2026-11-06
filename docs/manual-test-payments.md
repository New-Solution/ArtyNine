# Online Payments (Moyasar) — Runbook and Manual Test Plan

Scope: customer checkout with Moyasar for workshops (deposit) and birthdays
(full price), the hold/expiry model, verification, refunds wording, and the
switch from test to live keys. Code: migration `0046`, Edge Functions
`verify-payment`, `moyasar-webhook`, `auto-cancel-bookings`,
`notify-own-booking`; front end `CheckoutPaymentSection`,
`MoyasarPaymentPanel`, `PaymentReturnSection`, Settings → Online Payments.

## How it works (one paragraph)

When Settings → Online Payments is on, a website booking is created as a
**hold** (`payment_status = 'Awaiting Payment'`, `payment_expires_at = now +
hold minutes`) priced by the database. The customer pays in Moyasar's form;
the payment id goes to `verify-payment`, which fetches the payment from
Moyasar with the secret key and calls `confirm_booking_payment()`. Only that
function can mark a booking paid (`Deposit Paid` for a workshop deposit,
`Paid` for a full payment). An expired hold stops holding its seat at once; the
`auto-cancel-bookings` job marks it `Cancelled / Expired` after first checking
Moyasar for a payment that arrived without the customer coming back.

---

## 1. Deployment runbook (in order — each step needs the owner's go-ahead)

Nothing below happens on push. Pushing `main` only deploys the front end, and
the front end changes nothing for customers until step 6.

| # | Step | Command / place | Check |
|---|---|---|---|
| 1 | Apply the migration | Supabase SQL Editor: paste `supabase/migrations/0046_online_deposit_payments.sql` | The final verification row: every column `true`. Then run its MANUAL TESTS block: ends with `ALL 0046 TESTS PASSED — rolled back`. Then edit the file's first line to `-- STATUS: APPLIED` in a commit. |
| 2 | Edge Function secrets (test keys) | `npx supabase secrets set MOYASAR_SECRET_KEY=sk_test_… MOYASAR_MODE=test MOYASAR_WEBHOOK_SECRET=<long random string>` | `npx supabase secrets list` shows the three names (values hidden). |
| 3 | Deploy functions | `npx supabase functions deploy verify-payment` · `npx supabase functions deploy moyasar-webhook` · `npx supabase functions deploy auto-cancel-bookings` · `npx supabase functions deploy notify-own-booking` | `config.toml` turns JWT verification off for `verify-payment` and `moyasar-webhook`; confirm in the dashboard (Functions → each → "Verify JWT" off). |
| 4 | Webhook in Moyasar | Dashboard → Settings → Webhooks → Add Webhook. Endpoint `https://<project-ref>.supabase.co/functions/v1/moyasar-webhook`, method POST, secret token = `MOYASAR_WEBHOOK_SECRET`, events: `payment_paid`, `payment_failed`, `payment_refunded`, `payment_voided` | Moyasar shows the webhook active. |
| 5 | Front-end key | Hosting env: `VITE_MOYASAR_PUBLISHABLE_KEY=pk_test_…` (optional `VITE_MOYASAR_METHODS=creditcard`), rebuild/redeploy | Settings → Online Payments shows "Moyasar: TEST key" and the switch is no longer greyed out. |
| 6 | Turn it on | Settings → Online Payments → tick "Take payment online at checkout" → Save | Defaults: workshop deposit 100 SAR, birthday full price, hold 15 min. |

To turn it **off** at any moment: untick and save. Holds already created keep
working (they can still be paid or will expire); new bookings go back to the
old flow.

**Apple Pay / STC Pay** are off by default (cards: mada, Visa, Mastercard).
Apple Pay: register the exact customer domain in Moyasar (Settings → Apple Pay
Domains), put the downloaded file at
`public/.well-known/apple-developer-merchantid-domain-association` (no
extension), deploy, validate, then add `applepay` to `VITE_MOYASAR_METHODS`.
STC Pay: ask Moyasar to enable it on the account, then add `stcpay`.

---

## 2. Test cards (test keys only)

Any name of two words, any future expiry, any 3-digit CVC. Cards not on
Moyasar's list always fail. Source: docs.moyasar.com/guides/card-payments/test-cards.

| Card | Number | Result |
|---|---|---|
| Visa | `4111 1111 1111 1111` | paid |
| Visa (frictionless 3-D Secure) | `4111 1140 0576 5430` | paid |
| mada | `4201 3201 1111 1010` | paid |
| Mastercard | `5421 0801 0100 0000` | paid |
| mada declined | `4201 3212 3441 1220` | failed — DECLINED |
| mada insufficient funds | `4201 3200 0031 1101` | failed — INSUFFICIENT FUNDS |
| Visa 3-D Secure rejected | `4111 1157 8422 8433` | failed — authentication rejected |
| Mastercard declined | `5105 1051 0510 5100` | failed |

---

## 3. Test cases

Keep the Supabase SQL Editor open. Useful query:

```sql
select id, status, payment_status, payment_mode, total_price, online_amount,
       online_amount_halalas, payment_expires_at, moyasar_payment_id, paid_at
  from bookings order by created_at desc limit 5;
select id, booking_id, status, amount_halalas, outcome, message
  from booking_payments order by created_at desc limit 5;
```

### A. Happy paths

| ID | Steps | Expected |
|---|---|---|
| PAY-01 | Guest books a workshop (150 SAR × 2). Payment step → "Continue to Secure Payment (100 SAR)". | Booking row: `Pending / Awaiting Payment`, `total_price 300`, `payment_mode deposit`, `online_amount 100`, expiry ≈ +15 min. Form shows "Deposit due now 100 SAR", balance 200, countdown. |
| PAY-02 | Pay PAY-01 with Visa `4111…1111`. | Back on the site → "Checking your payment…" → confirmation screen. Row: `Deposit Paid`, `moyasar_payment_id` set, `paid_at` set. `booking_payments` row `paid / confirmed`. |
| PAY-03 | Signed-in customer, same with mada `4201 3201 1111 1010`. | As PAY-02; the booking appears in My Bookings as "Deposit paid 100 SAR · Balance 200 SAR at the studio". |
| PAY-04 | Birthday package 120 SAR/child × 10. | Review step and button say "Pay 1200 SAR"; row `payment_mode full`, `online_amount 1200`; after paying `Paid`. |
| PAY-05 | Birthday Fixed-price package (e.g. 1500) × 10 guests. | Estimated total and charge are 1500, not 15000. |
| PAY-06 | Workshop cheaper than the deposit (e.g. 60 SAR × 1). | Charges 60, not 100. |
| PAY-07 | Arabic: switch to العربية, repeat PAY-02. | Moyasar form in Arabic, right-to-left; every message on the payment step and return page in Arabic. |

### B. Failures and retries

| ID | Steps | Expected |
|---|---|---|
| PAY-10 | Pay with mada declined `4201 3212 3441 1220`. | Return page: "Payment not completed (DECLINED). Nothing was charged…", and the form again with the countdown still running. Row stays `Awaiting Payment`. `booking_payments` row `failed`. |
| PAY-11 | After PAY-10, pay with `4111…1111` in the re-offered form. | Confirmed. Two `booking_payments` rows (failed, paid). |
| PAY-12 | Visa 3-D Secure rejected `4111 1157 8422 8433`. | Same as PAY-10. |
| PAY-13 | Refresh the return page after confirmation. | No repeat: parameters were removed from the URL. |
| PAY-14 | Open the return page URL by hand with a random uuid: `/?payment=return&id=00000000-0000-4000-8000-000000000000`. | "Payment not found…"; nothing changes in the database. |

### C. Holds and expiry

Set Settings → Online Payments → hold to **5** minutes for these.

| ID | Steps | Expected |
|---|---|---|
| PAY-20 | Create a hold, do not pay, wait 5 minutes on the page. | Countdown reaches 0, form disabled, message "The time to pay ran out…". `select session_seats_taken('<session id>')` no longer counts it the moment it expired. |
| PAY-21 | After PAY-20, run the job: `curl -X POST https://<ref>.supabase.co/functions/v1/auto-cancel-bookings -H "Authorization: Bearer <service key>"`. | Row `Cancelled / Expired`, timeline "Payment not completed in time — hold released". No SMS, no notification. Response lists it with reason `payment_expired`. |
| PAY-22 | Press the button again after PAY-20. | A new hold with a new reference; the old one is not revived. |
| PAY-23 | Last seat: session with 1 seat left; browser A creates a hold; browser B tries to book. | B: "Only 0 seat(s) left". After A's hold expires, B can book. |
| PAY-24 | Pay, and close the tab on the 3-D Secure page before returning (use a frictionless card and close as soon as Moyasar shows success). | Within seconds the webhook confirms it (`booking_payments.outcome = confirmed`). With the webhook disabled: the job's run after expiry confirms it instead of expiring (`reconciled` in its response). |
| PAY-25 | Paid after expiry, place gone: set hold to 5 min, create hold A (last seat), let it expire, let B take the seat, then pay A's open form. | A's row `Cancelled / Needs Refund`; staff notification "Online payment needs a refund"; customer sees "Payment received — place no longer available…". |
| PAY-26 | An unpaid hold for **today** in the staff console. | It does not appear on the Live Queue until paid; once paid it is queued. |

### D. Tampering (all must fail safely)

| ID | Steps | Expected |
|---|---|---|
| PAY-30 | Devtools on the payment step: change the form's amount (e.g. `Moyasar.init` breakpoint, `amount: 100`). Pay. | `booking_payments.outcome = amount_mismatch`; booking stays unpaid; staff alerted once; customer told the studio will check. |
| PAY-31 | Guest calls the RPC directly with `payment_status: 'Paid', total_price: 1` (anon key). | Row is `Awaiting Payment` at the database price. |
| PAY-32 | Signed-in customer: `update bookings set payment_status='Paid'` via the REST API with their JWT. | 0 rows changed (no UPDATE policy). |
| PAY-33 | Call `confirm_booking_payment` with the anon key. | Permission denied. |
| PAY-34 | POST the same payment id to `verify-payment` 5 times. | Same answer each time; one `booking_payments` row; at most one staff alert. |
| PAY-35 | POST to `moyasar-webhook` with a wrong `secret_token`. | 401; nothing changes. |

### E. Cancellation and refunds

| ID | Steps | Expected |
|---|---|---|
| PAY-40 | Customer cancels a deposit-paid workshop > 24 h ahead. | Dialog: "The 100 SAR deposit is non-refundable." Row `Cancelled / Deposit Paid`. SMS: the existing *not eligible for a refund* template. |
| PAY-41 | Customer cancels a full-paid birthday > 24 h ahead. | Dialog promises the refund. Row `Refunded`, timeline names the Moyasar payment to refund. Staff refund it in the Moyasar dashboard. |
| PAY-42 | Customer cancels an unpaid hold. | "Nothing has been charged for it." No SMS. |
| PAY-43 | Staff cancel an online-paid booking (Bookings and Events/Birthday dialogs). | Amber note: amount, deposit or not, "Marking it refunded does not return any money", the Moyasar payment id. |

### F. Switch off

| ID | Steps | Expected |
|---|---|---|
| PAY-50 | Untick Online Payments, save; book a workshop. | Old flow (no Moyasar form); row is not a hold. |
| PAY-51 | Untick while a customer has the Moyasar form open. | Their hold can still be paid and confirmed. |

---

## 4. Going live

1. Moyasar account activated; live keys issued.
2. `npx supabase secrets set MOYASAR_SECRET_KEY=sk_live_… MOYASAR_MODE=live` — the functions refuse to run if the key and mode disagree.
3. Hosting env `VITE_MOYASAR_PUBLISHABLE_KEY=pk_live_…`, rebuild. Settings shows "LIVE key — real cards are charged".
4. Add the webhook again under the **live** account (webhooks are per mode) with the same secret token.
5. One real payment of a small amount (temporarily set the workshop deposit to 1 SAR, or use a cheap test workshop), check it end to end, then refund it in the Moyasar dashboard and set the deposit back.
6. Watch the first day: `select payment_status, count(*) from bookings where created_at > now() - interval '1 day' group by 1;` — any `Needs Refund`, or a growing `Expired` count, needs a look.

## 5. Known limits

- Refunds are manual in the Moyasar dashboard. The app records them; it does not move money.
- The browser shows an estimate before the hold; the amount charged is always the database's. If staff change the deposit while a customer is on the page, the form opens for the new amount.
- Birthday cancellation follows the 24 h rule (cancel_own_booking), not the Events settings' "cancellation notice days".
- Moyasar.js is pinned to `moyasar-payment-form@2.3.0` with SRI (`src/lib/onlinePayment.ts`). To upgrade, change the version and both hashes together.
