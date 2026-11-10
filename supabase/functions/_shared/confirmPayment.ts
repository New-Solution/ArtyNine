/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * verifyAndConfirmPayment() — fetch a payment from Moyasar, record it, and if
 * it is paid let confirm_booking_payment() (migration 0046) decide whether it
 * pays for its booking.
 *
 * Shared by:
 *   - verify-payment       (the payment step's on_completed, and the
 *                           callback page after 3-D Secure)
 *   - auto-cancel-bookings (before expiring a hold that has a payment on
 *                           record, in case the customer paid and never came
 *                           back to the site)
 *
 * SAFE TO REPEAT. Every caller may run it for the same payment any number of
 * times, concurrently:
 *   - booking_payments is upserted by payment id;
 *   - confirm_booking_payment() locks the booking and is idempotent;
 *   - a final failure outcome (mismatch, duplicate…) is answered from
 *     booking_payments.outcome without calling confirm again, so staff are
 *     alerted once per payment, not once per retry.
 *
 * Trust: the only input is a payment id. The amount, currency, status and
 * booking all come from Moyasar's own record, fetched with the secret key.
 *
 * No Deno/npm imports: the Supabase client and fetch are passed in, so
 * confirmPayment.test.ts drives this with fakes under tsx.
 */

import { fetchMoyasarPayment, type FetchLike } from './moyasar.ts';
import { fetchedPaymentEvidence, recordPaymentEvidence } from './paymentEvidence.ts';
import {
  readPayment,
  auditCopy,
  stateForUnpaidStatus,
  stateForOutcome,
  staffAlertFor,
  FINAL_FAILURE_OUTCOMES,
  type VerifyState
} from './moyasarLogic.ts';

/** The subset of a supabase-js client this uses. */
export interface AdminClient {
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
}

/** What a confirmation screen may show. No phone, email or customer id. */
export interface PaidBookingSummary {
  id: string;
  workshopTitle: string | null;
  date: string | null;
  time: string | null;
  participants: number | null;
  paymentStatus: string | null;
  paymentMode: string | null;
  onlineAmount: number | null;
  totalPrice: number | null;
}

export type VerifyResult =
  | {
      ok: true;
      state: VerifyState;
      paymentId: string;
      bookingId: string | null;
      /** Moyasar's status for the payment as fetched (paid, refunded, voided…). */
      paymentStatus: string;
      /** Moyasar's decline message, for 'failed'. */
      message?: string | null;
      /** Present for 'confirmed'. */
      booking?: PaidBookingSummary;
    }
  | {
      ok: false;
      /** invalid_id / not_found: the caller's problem (400/404).
       *  unauthorized / unavailable / database: ours (500/502). */
      reason: 'invalid_id' | 'not_found' | 'unauthorized' | 'unavailable' | 'database';
      detail?: string;
    };

const BOOKING_SUMMARY_COLUMNS =
  'id, workshop_title, date, time, participants, payment_status, payment_mode, online_amount, total_price';

function summarise(row: Record<string, any>): PaidBookingSummary {
  return {
    id: row.id,
    workshopTitle: row.workshop_title ?? null,
    date: row.date ?? null,
    time: row.time ?? null,
    participants: row.participants ?? null,
    paymentStatus: row.payment_status ?? null,
    paymentMode: row.payment_mode ?? null,
    onlineAmount: row.online_amount === null || row.online_amount === undefined ? null : Number(row.online_amount),
    totalPrice: row.total_price === null || row.total_price === undefined ? null : Number(row.total_price)
  };
}

function notificationId(): string {
  return `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export async function verifyAndConfirmPayment(
  admin: AdminClient,
  secretKey: string,
  paymentId: string,
  fetchImpl?: FetchLike,
  log: (msg: string) => void = (m) => console.error(m),
  /** When set, the fetched response is stored in moyasar_payment_events
   *  (migration 0047) under this source. verify-payment sets it;
   *  auto-cancel-bookings does not. */
  evidenceSource?: 'verify-payment' | 'return-page'
): Promise<VerifyResult> {
  // 1. Moyasar's own record.
  const fetched = await fetchMoyasarPayment(paymentId, secretKey, fetchImpl);
  if (!fetched.ok) {
    if (fetched.reason === 'unauthorized' || fetched.reason === 'unavailable') {
      log(`verifyAndConfirmPayment: fetching ${paymentId} failed: ${fetched.reason} ${fetched.detail ?? ''}`);
    }
    return { ok: false, reason: fetched.reason, detail: fetched.detail };
  }

  // 1b. Evidence: the full response as Moyasar returned it, minus
  //     source.token, BEFORE anything is decided, so every outcome (paid,
  //     failed, declined, mismatch, already processed, unreadable) is on
  //     record. Moyasar only returns masked card data (source.number like
  //     4111-11XX-XXXX-1111, no CVC); nothing is added. recordPaymentEvidence never throws, and its
  //     result is deliberately ignored: logging can't change the answer.
  if (evidenceSource) {
    await recordPaymentEvidence(admin, fetchedPaymentEvidence(evidenceSource, fetched.payment), log);
  }

  const facts = readPayment(fetched.payment);
  if (!facts || facts.id.toLowerCase() !== paymentId.toLowerCase()) {
    log(`verifyAndConfirmPayment: Moyasar returned an unreadable payment for ${paymentId}.`);
    return { ok: false, reason: 'unavailable', detail: 'unreadable payment' };
  }

  // 2. Does the booking it names exist? (booking_payments.booking_id is a
  //    foreign key, so an unknown id is stored as null.)
  let bookingExists = false;
  if (facts.bookingId) {
    const { data, error } = await admin.from('bookings').select('id').eq('id', facts.bookingId).maybeSingle();
    if (error) {
      log(`verifyAndConfirmPayment: reading booking ${facts.bookingId} failed: ${error.message}`);
      return { ok: false, reason: 'database', detail: error.message };
    }
    bookingExists = !!data;
  }

  // 3. What we decided last time, if anything.
  const { data: previous, error: previousError } = await admin
    .from('booking_payments').select('outcome').eq('id', facts.id).maybeSingle();
  if (previousError) {
    log(`verifyAndConfirmPayment: reading booking_payments ${facts.id} failed: ${previousError.message}`);
    return { ok: false, reason: 'database', detail: previousError.message };
  }

  // 4. Record what Moyasar says now. Kept even for declines: a customer's
  //    failed attempts are useful to staff answering "why didn't it work".
  const { error: upsertError } = await admin.from('booking_payments').upsert({
    id: facts.id,
    booking_id: bookingExists ? facts.bookingId : null,
    status: facts.status,
    amount_halalas: facts.amountHalalas,
    currency: facts.currency,
    source_type: facts.sourceType,
    message: facts.message,
    raw: auditCopy(fetched.payment),
    updated_at: new Date().toISOString()
  }, { onConflict: 'id' });
  if (upsertError) {
    // Not fatal: the booking decision does not depend on the audit row.
    log(`verifyAndConfirmPayment: recording payment ${facts.id} failed: ${upsertError.message}`);
  }

  // 5. Not paid: nothing to confirm. The booking stays 'Awaiting Payment' and
  //    the customer may try again until the hold ends.
  if (facts.status !== 'paid') {
    return {
      ok: true,
      state: stateForUnpaidStatus(facts.status),
      paymentId: facts.id,
      bookingId: facts.bookingId,
      paymentStatus: facts.status,
      message: facts.message
    };
  }

  // 6. Paid, and already judged a final failure: same answer, no second alert.
  const previousOutcome: string | null = previous?.outcome ?? null;
  if (previousOutcome && FINAL_FAILURE_OUTCOMES.has(previousOutcome)) {
    return { ok: true, state: stateForOutcome(previousOutcome), paymentId: facts.id, bookingId: facts.bookingId, paymentStatus: facts.status };
  }

  // 7. Paid: let the database decide.
  let outcome: string;
  let bookingPaymentStatus: string | null = null;
  if (!bookingExists) {
    outcome = 'not_found';
  } else {
    const { data, error } = await admin.rpc('confirm_booking_payment', {
      p_booking_id: facts.bookingId,
      p_payment_id: facts.id,
      p_amount_halalas: facts.amountHalalas,
      p_currency: facts.currency
    });
    if (error) {
      log(`verifyAndConfirmPayment: confirm_booking_payment(${facts.bookingId}, ${facts.id}) failed: ${error.message}`);
      return { ok: false, reason: 'database', detail: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    outcome = String(row?.outcome ?? 'not_found');
    bookingPaymentStatus = row?.booking_payment_status ?? null;
  }

  const { error: outcomeError } = await admin
    .from('booking_payments').update({ outcome, updated_at: new Date().toISOString() }).eq('id', facts.id);
  if (outcomeError) log(`verifyAndConfirmPayment: saving outcome for ${facts.id} failed: ${outcomeError.message}`);

  // 8. Money that cannot be kept: tell staff (once — see step 6).
  const alert = staffAlertFor(outcome, facts);
  if (alert) {
    const { error: notifyError } = await admin.from('notifications').insert({
      id: notificationId(),
      type: 'staff',
      title: alert.title,
      message: alert.message,
      timestamp: new Date().toISOString(),
      is_read: false,
      highlighted: true
    });
    if (notifyError) log(`verifyAndConfirmPayment: staff alert for ${facts.id} failed: ${notifyError.message}`);
  }

  const state = stateForOutcome(outcome, bookingPaymentStatus);

  // 9. A confirmed booking's summary, for the confirmation screen (a guest
  //    cannot read bookings themselves).
  let booking: PaidBookingSummary | undefined;
  if (state === 'confirmed' && facts.bookingId) {
    const { data, error } = await admin
      .from('bookings').select(BOOKING_SUMMARY_COLUMNS).eq('id', facts.bookingId).maybeSingle();
    if (error) log(`verifyAndConfirmPayment: reading summary for ${facts.bookingId} failed: ${error.message}`);
    if (data) booking = summarise(data);
  }

  return { ok: true, state, paymentId: facts.id, bookingId: facts.bookingId, paymentStatus: facts.status, booking };
}
