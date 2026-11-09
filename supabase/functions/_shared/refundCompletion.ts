/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * completeBookingRefund() — the single "the money is back" step, shared by
 * refund-payment (staff pressed Refund) and moyasar-webhook (a
 * payment_refunded / payment_voided event, e.g. a refund made in the Moyasar
 * dashboard).
 *
 * EXACTLY ONCE. complete_booking_refund() (migration 0054) is a single
 * conditional UPDATE: it moves the booking to 'Refunded' only while
 * payment_status still equals p_expected_status, and in the same transaction
 * appends the timeline entry and writes the customer's refunded bell
 * notification (the stored "Booking Cancelled — Refunded" wording
 * notificationText.ts renders in Arabic). It returns true only for the call
 * that made the change, and only that call sends the SMS — the registered
 * "refunded" template from bookingSmsTemplates.ts. A second click, a retried
 * webhook, or a webhook racing a staff refund changes nothing and sends
 * nothing.
 *
 * The SMS is best-effort, like every other booking SMS: the refund and the
 * status change have already happened, so a failed send is logged, never
 * turned into a failure.
 *
 * No Deno/npm imports: the client and the SMS sender are passed in, so
 * refund-payment/logic.test.ts drives this with fakes under tsx.
 */

import { bookingCancellationSms } from './bookingSmsTemplates.ts';

export interface RpcClient {
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
}

export type SmsSender = (phone: string, message: string) => Promise<{ success: boolean; error?: string }>;

/** The booking columns this needs, as read from the database. */
export interface RefundBookingRow {
  id: string;
  customer_phone: string | null;
  workshop_title: string | null;
  date: string | null;
  online_amount_halalas: number | null;
}

/** How the money went back; stored in bookings.refund_method (0054). */
export type RefundMethod = 'void' | 'refund' | 'moyasar_refunded' | 'moyasar_voided';

export type CompleteRefundResult =
  | { ok: true; transitioned: boolean; smsSent: boolean }
  | { ok: false; error: string };

/** SAR from halalas, for the SMS: 10000 -> 100, 10050 -> 100.5. */
export function sarFromHalalas(halalas: number | null | undefined): number | null {
  return Number.isInteger(halalas) ? (halalas as number) / 100 : null;
}

export async function completeBookingRefund(
  admin: RpcClient,
  sendSms: SmsSender,
  booking: RefundBookingRow,
  opts: {
    expectedStatus: 'Refund Processing' | 'Needs Refund';
    method: RefundMethod;
    refundId: string | null;
    actor: string;
  },
  log: (msg: string) => void = (m) => console.error(m)
): Promise<CompleteRefundResult> {
  const { data, error } = await admin.rpc('complete_booking_refund', {
    p_booking_id: booking.id,
    p_expected_status: opts.expectedStatus,
    p_method: opts.method,
    p_refund_id: opts.refundId,
    p_actor: opts.actor
  });
  if (error) {
    log(`completeBookingRefund: complete_booking_refund(${booking.id}) failed: ${error.message}`);
    return { ok: false, error: error.message };
  }

  const transitioned = data === true || (Array.isArray(data) && data[0] === true);
  if (!transitioned) return { ok: true, transitioned: false, smsSent: false };

  // Only the call that moved the booking to Refunded gets here.
  const amount = sarFromHalalas(booking.online_amount_halalas);
  const phone = String(booking.customer_phone ?? '').trim();
  if (!phone) {
    log(`completeBookingRefund: refunded SMS for booking ${booking.id} not sent — no phone number on file.`);
    return { ok: true, transitioned: true, smsSent: false };
  }
  if (amount === null) {
    log(`completeBookingRefund: refunded SMS for booking ${booking.id} not sent — no online amount on file.`);
    return { ok: true, transitioned: true, smsSent: false };
  }

  try {
    const sms = bookingCancellationSms('refunded', {
      workshopTitle: booking.workshop_title,
      date: booking.date,
      amount
    });
    const result = await sendSms(phone, sms);
    if (!result.success) {
      log(`completeBookingRefund: refunded SMS for booking ${booking.id} failed: ${result.error ?? 'unknown error'}`);
      return { ok: true, transitioned: true, smsSent: false };
    }
    return { ok: true, transitioned: true, smsSent: true };
  } catch (err) {
    log(`completeBookingRefund: refunded SMS for booking ${booking.id} threw: ${String((err as Error)?.message ?? err)}`);
    return { ok: true, transitioned: true, smsSent: false };
  }
}

// -----------------------------------------------------------------------------
// Webhook: a payment_refunded / payment_voided event
// -----------------------------------------------------------------------------

export type WebhookRefundAction =
  | 'completed'          // Needs Refund -> Refunded, bell + SMS sent by this call
  | 'already_refunded'   // nothing to do (no second SMS)
  | 'in_progress'        // refund-payment holds it and will finish it
  | 'alerted'            // money returned for a booking not waiting for a refund: staff told
  | 'no_booking';        // no booking has this payment

export type WebhookRefundResult =
  | { ok: true; action: WebhookRefundAction; bookingId: string | null }
  | { ok: false; error: string };

/**
 * Moyasar says (and a fresh fetch with the secret key confirmed) that a
 * payment is refunded or voided. Bring the booking that holds it in line:
 *
 *   Needs Refund       -> Refunded, through the same exactly-once
 *                         complete_booking_refund() as refund-payment, so the
 *                         customer gets the bell and SMS once
 *   Refunded           -> nothing (no duplicate SMS)
 *   Refund Processing  -> nothing: a refund-payment call holds it and will
 *                         complete it; if that call died, the next Refund
 *                         click sees Moyasar's refunded status and completes
 *                         it without calling Moyasar again
 *   anything else      -> left as it is (an active, paid booking is not
 *                         silently flipped); staff get one alert to check it
 */
export async function applyMoyasarRefundEvent(
  admin: RpcClient,
  sendSms: SmsSender,
  paymentId: string,
  moyasarStatus: 'refunded' | 'voided',
  log: (msg: string) => void = (m) => console.error(m)
): Promise<WebhookRefundResult> {
  const { data: row, error } = await admin
    .from('bookings')
    .select('id, status, payment_status, customer_name, customer_phone, workshop_title, date, online_amount_halalas')
    .eq('moyasar_payment_id', paymentId)
    .maybeSingle();
  if (error) {
    log(`applyMoyasarRefundEvent: reading the booking for ${paymentId} failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
  if (!row) return { ok: true, action: 'no_booking', bookingId: null };

  switch (row.payment_status) {
    case 'Refunded':
      return { ok: true, action: 'already_refunded', bookingId: row.id };
    case 'Refund Processing':
      return { ok: true, action: 'in_progress', bookingId: row.id };
    case 'Needs Refund': {
      const done = await completeBookingRefund(admin, sendSms, row as RefundBookingRow, {
        expectedStatus: 'Needs Refund',
        method: moyasarStatus === 'refunded' ? 'moyasar_refunded' : 'moyasar_voided',
        refundId: null,
        actor: 'Moyasar'
      }, log);
      if (!done.ok) return { ok: false, error: done.error };
      return { ok: true, action: done.transitioned ? 'completed' : 'already_refunded', bookingId: row.id };
    }
    default: {
      const { error: notifyError } = await admin.from('notifications').insert({
        id: `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}-r`,
        type: 'staff',
        title: `Online payment ${moyasarStatus} in Moyasar`,
        message: `Moyasar reports payment ${paymentId} as ${moyasarStatus}, but booking ${row.id} (${row.customer_name ?? ''}, `
          + `${row.customer_phone ?? ''}) is ${row.status ?? '?'} / ${row.payment_status ?? '?'}, not waiting for a refund. `
          + 'Nothing was changed. Check the booking and update it if the customer is no longer paid.',
        timestamp: new Date().toISOString(),
        is_read: false,
        highlighted: true
      });
      if (notifyError) {
        log(`applyMoyasarRefundEvent: staff alert for ${paymentId} failed: ${notifyError.message}`);
        return { ok: false, error: notifyError.message };
      }
      return { ok: true, action: 'alerted', bookingId: row.id };
    }
  }
}
