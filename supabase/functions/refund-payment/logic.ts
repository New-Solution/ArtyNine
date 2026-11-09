/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * refund-payment's decisions, with every dependency (database client, fetch,
 * SMS sender, clock) passed in, so logic.test.ts runs all of it under tsx
 * with fakes. index.ts is only the Deno/HTTP plumbing.
 *
 * THE FLOW (refundBooking)
 *   1. Read the booking from the database: payment_status,
 *      moyasar_payment_id, online_amount_halalas. Nothing about the payment
 *      comes from the browser — the request is a booking id only.
 *   2. Refuse unless it is 'Needs Refund' (or a stale 'Refund Processing',
 *      see 3) and has a Moyasar payment.
 *   3. CLAIM it: claim_booking_refund() (0054) moves it to 'Refund
 *      Processing' in one conditional UPDATE. Only one caller can win; a
 *      double click, a second tab or a second staff member gets 'in_progress'
 *      and Moyasar is never called twice. A claim older than 5 minutes (the
 *      function died mid-way) can be taken over — safe because of step 4.
 *   4. FETCH the payment from Moyasar first and record it (evidence log). If
 *      Moyasar already shows it refunded / voided (a retry after a lost
 *      answer, or a refund made in the dashboard), nothing is sent to Moyasar:
 *      the booking is just completed. This is what makes retrying safe.
 *   5. Check Moyasar's payment is the one the booking paid: SAR, and exactly
 *      online_amount_halalas.
 *   6. VOID while Moyasar still allows it (authorized, or paid/captured within
 *      VOID_WINDOW_MS of the payment — Moyasar's limit is ~2 hours, we stop
 *      short of it); otherwise REFUND the full amount from the database. A
 *      void Moyasar refuses on a paid payment falls back to a refund, as the
 *      Moyasar guide advises.
 *   7. Success -> complete_booking_refund(): Refunded, refunded_at, method,
 *      refund id, timeline, bell — once — then the refunded SMS
 *      (_shared/refundCompletion.ts). Failure -> release_booking_refund():
 *      back to 'Needs Refund' with a timeline note, and Moyasar's message is
 *      returned to the console.
 */

import { fetchMoyasarPayment, postPaymentOperation, type FetchLike, type PaymentOperationResult } from '../_shared/moyasar.ts';
import { readPayment } from '../_shared/moyasarLogic.ts';
import { recordPaymentEvidence, refundEvidence } from '../_shared/paymentEvidence.ts';
import {
  completeBookingRefund,
  type RefundBookingRow,
  type RefundMethod,
  type RpcClient,
  type SmsSender
} from '../_shared/refundCompletion.ts';
import type { RefundPaymentCode, RefundPaymentResponse } from './contract.ts';

/** Void only well inside Moyasar's ~2 hour window for paid payments. */
export const VOID_WINDOW_MS = 100 * 60 * 1000;

/** The Admin Console pages whose staff may refund (canAccessPage ids). */
export const REFUND_PAGES = ['bookings', 'events-admin'] as const;

// -----------------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------------

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; httpStatus: number; code: RefundPaymentCode; error: string };

/**
 * Is the caller active console staff with the Bookings or the Events page?
 * staff_can(page) (0013) answers exactly that from auth.uid() — Super Admin
 * passes for every page — so it must be called through the CALLER's client
 * (their own JWT), never the service-role one.
 */
export async function authorizeRefundCaller(callerClient: Pick<RpcClient, 'rpc'>): Promise<AuthorizeResult> {
  for (const page of REFUND_PAGES) {
    const { data, error } = await callerClient.rpc('staff_can', { page });
    if (error) return { ok: false, httpStatus: 500, code: 'internal_error', error: 'Could not verify authorization.' };
    if (data === true) return { ok: true };
  }
  return { ok: false, httpStatus: 403, code: 'forbidden', error: 'Only staff with access to Bookings or Events can refund.' };
}

// -----------------------------------------------------------------------------
// What to ask Moyasar for
// -----------------------------------------------------------------------------

export type RefundPlan = 'void' | 'refund' | 'already_refunded' | 'already_voided' | 'not_refundable';

export function planRefund(status: string, createdAt: unknown, now: Date): RefundPlan {
  switch (status) {
    case 'refunded':
      return 'already_refunded';
    case 'voided':
      return 'already_voided';
    case 'authorized':
      return 'void';
    case 'paid':
    case 'captured': {
      const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
      if (Number.isFinite(created) && now.getTime() - created >= 0 && now.getTime() - created < VOID_WINDOW_MS) {
        return 'void';
      }
      return 'refund';
    }
    default:
      // initiated, failed, expired, verified…: no money to give back.
      return 'not_refundable';
  }
}

/**
 * The refund's own id, if Moyasar's answer carries one. Moyasar's docs only
 * say the answer is the payment with status 'refunded', so this is read
 * leniently and is often null; the full answer is in the evidence log.
 */
export function refundIdFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  if (typeof b.refund_id === 'string' && b.refund_id) return b.refund_id;
  if (Array.isArray(b.refunds) && b.refunds.length) {
    const last = b.refunds[b.refunds.length - 1];
    if (last && typeof last.id === 'string' && last.id) return last.id;
  }
  return null;
}

const statusOf = (body: unknown): string | null =>
  body && typeof body === 'object' && typeof (body as any).status === 'string' ? (body as any).status : null;

// -----------------------------------------------------------------------------
// The refund
// -----------------------------------------------------------------------------

export interface RefundDeps {
  /** Service-role client. */
  admin: RpcClient;
  secretKey: string;
  sendSms: SmsSender;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface RefundOutcome {
  httpStatus: number;
  body: RefundPaymentResponse;
}

const BOOKING_COLUMNS =
  'id, payment_status, moyasar_payment_id, online_amount_halalas, customer_phone, workshop_title, date';

const failure = (httpStatus: number, code: RefundPaymentCode, error: string): RefundOutcome =>
  ({ httpStatus, body: { success: false, code, error } });

export async function refundBooking(deps: RefundDeps, bookingIdInput: unknown, actor: string): Promise<RefundOutcome> {
  const { admin, secretKey, sendSms, fetchImpl } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.error(m));

  const bookingId = typeof bookingIdInput === 'string' ? bookingIdInput.trim() : '';
  if (!bookingId || bookingId.length > 200) return failure(400, 'invalid_input', 'bookingId is required.');

  // 1. The booking, from the database.
  const { data: row, error: readError } = await admin.from('bookings').select(BOOKING_COLUMNS).eq('id', bookingId).maybeSingle();
  if (readError) {
    log(`refund-payment: reading booking ${bookingId} failed: ${readError.message}`);
    return failure(500, 'internal_error', 'Could not read the booking.');
  }
  if (!row) return failure(404, 'not_found', 'Booking not found.');

  // 2. Only an online payment that is waiting for its refund.
  const paymentId: string = typeof row.moyasar_payment_id === 'string' ? row.moyasar_payment_id : '';
  if (!paymentId) {
    return failure(409, 'not_online', 'This booking was not paid online. Refund the customer in person and use "Mark as Refunded".');
  }
  if (row.payment_status !== 'Needs Refund' && row.payment_status !== 'Refund Processing') {
    return failure(409, 'wrong_status', `This booking is not waiting for a refund (payment status: ${row.payment_status ?? 'none'}).`);
  }
  const amountHalalas: number | null = Number.isInteger(row.online_amount_halalas) && row.online_amount_halalas > 0
    ? row.online_amount_halalas
    : null;
  if (amountHalalas === null) {
    return failure(409, 'amount_mismatch', 'This booking has no online amount on record, so it cannot be refunded here.');
  }
  const booking: RefundBookingRow = {
    id: row.id,
    customer_phone: row.customer_phone ?? null,
    workshop_title: row.workshop_title ?? null,
    date: row.date ?? null,
    online_amount_halalas: amountHalalas
  };

  // 3. Claim. One conditional UPDATE in the database; only one caller wins.
  const { data: claimed, error: claimError } = await admin.rpc('claim_booking_refund', { p_booking_id: bookingId });
  if (claimError) {
    log(`refund-payment: claim_booking_refund(${bookingId}) failed: ${claimError.message}`);
    return failure(500, 'internal_error', 'Could not start the refund.');
  }
  if (!(claimed === true || (Array.isArray(claimed) && claimed[0] === true))) {
    return failure(409, 'in_progress', 'A refund for this booking is already being processed, or it is no longer waiting for one. Refresh and check its status.');
  }

  // From here on the booking is ours ('Refund Processing'): every failure
  // must hand it back to 'Needs Refund'.
  const fail = async (httpStatus: number, code: RefundPaymentCode, error: string): Promise<RefundOutcome> => {
    const { error: releaseError } = await admin.rpc('release_booking_refund', {
      p_booking_id: bookingId,
      p_reason: error.slice(0, 300)
    });
    if (releaseError) log(`refund-payment: release_booking_refund(${bookingId}) failed: ${releaseError.message}`);
    return failure(httpStatus, code, error);
  };
  const evidence = (eventType: 'refund-check' | 'void' | 'refund', body: unknown) =>
    recordPaymentEvidence(admin, refundEvidence(eventType, bookingId, paymentId, body), log);

  // 4. Moyasar's own record first.
  const fetched = await fetchMoyasarPayment(paymentId, secretKey, fetchImpl);
  if (!fetched.ok) {
    log(`refund-payment: fetching ${paymentId} failed: ${fetched.reason} ${fetched.detail ?? ''}`);
    const why = fetched.reason === 'not_found' ? 'Moyasar does not know this payment under the current key.'
      : fetched.reason === 'unauthorized' ? 'Moyasar refused the API key.'
      : 'Moyasar did not answer.';
    return fail(502, 'moyasar_error', `Could not read the payment from Moyasar: ${why} Nothing was refunded.`);
  }
  await evidence('refund-check', fetched.payment);

  const facts = readPayment(fetched.payment);
  if (!facts || facts.id.toLowerCase() !== paymentId.toLowerCase()) {
    return fail(502, 'moyasar_error', 'Moyasar returned an unreadable payment. Nothing was refunded.');
  }

  // 5. Is it the payment this booking says it paid?
  if (facts.currency !== 'SAR' || facts.amountHalalas !== amountHalalas) {
    const theirs = facts.amountHalalas === null ? '?' : (facts.amountHalalas / 100).toFixed(2);
    return fail(409, 'amount_mismatch',
      `Moyasar's payment is ${theirs} ${facts.currency ?? ''} but the booking records ${(amountHalalas / 100).toFixed(2)} SAR. Nothing was refunded; check the payment in Moyasar.`);
  }

  // 6. Void, refund, or nothing to send.
  const plan = planRefund(facts.status, (fetched.payment as any)?.created_at, now());
  let method: RefundMethod;
  let refundId: string | null = null;

  if (plan === 'already_refunded' || plan === 'already_voided') {
    method = plan === 'already_refunded' ? 'moyasar_refunded' : 'moyasar_voided';
  } else if (plan === 'not_refundable') {
    return fail(409, 'not_refundable', `Moyasar shows this payment as "${facts.status}", so there is no money to return.`);
  } else {
    let result: PaymentOperationResult | null = null;
    method = plan;

    if (plan === 'void') {
      const voided = await postPaymentOperation(paymentId, 'void', secretKey, null, fetchImpl);
      await evidence('void', voided.body);
      if (voided.ok && statusOf(voided.body) === 'voided') {
        result = voided;
      } else if (!voided.ok && voided.reason === 'rejected' && (facts.status === 'paid' || facts.status === 'captured')) {
        // Past the void window after all: refund instead (Moyasar's advice).
        log(`refund-payment: void of ${paymentId} refused (${voided.message}); refunding instead.`);
        method = 'refund';
      } else {
        const msg = voided.ok
          ? `Moyasar answered the void but the payment is "${statusOf(voided.body) ?? 'unknown'}", not voided.`
          : voided.message;
        return fail(502, 'moyasar_error', `${msg} Press Refund again to retry — it checks Moyasar first, so it never refunds twice.`);
      }
    }

    if (method === 'refund') {
      result = await postPaymentOperation(paymentId, 'refund', secretKey, amountHalalas, fetchImpl);
      await evidence('refund', result.body);
      if (!(result.ok && statusOf(result.body) === 'refunded')) {
        const msg = result.ok
          ? `Moyasar answered the refund but the payment is "${statusOf(result.body) ?? 'unknown'}", not refunded.`
          : result.message;
        return fail(502, 'moyasar_error', `${msg} Press Refund again to retry — it checks Moyasar first, so it never refunds twice.`);
      }
    }

    refundId = result && result.ok ? refundIdFrom(result.body) : null;
  }

  // 7. The money is back. Record it once, then tell the customer.
  const completed = await completeBookingRefund(admin, sendSms, booking, {
    expectedStatus: 'Refund Processing',
    method,
    refundId,
    actor
  }, log);
  if (!completed.ok) {
    return fail(500, 'internal_error',
      'The money was returned through Moyasar, but saving the booking failed. Press Refund again to record it — it checks Moyasar first, so it will not refund twice.');
  }

  return {
    httpStatus: 200,
    body: {
      success: true,
      method,
      amountHalalas,
      recorded: completed.transitioned,
      smsSent: completed.smsSent
    }
  };
}
