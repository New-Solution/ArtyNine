/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The HTTP contract for refund-payment. Mirrored (not imported — Vite and
 * Deno are different toolchains) by refundBookingOnline() in
 * src/context/AppContext.tsx.
 *
 * The request carries a booking id and nothing else: the payment id, the
 * amount and the booking's state are read from the database by the function.
 */

export interface RefundPaymentRequest {
  bookingId: string;
}

export type RefundPaymentCode =
  | 'unauthenticated'   // 401 no / invalid session
  | 'forbidden'         // 403 not active staff with Bookings or Events access
  | 'invalid_input'     // 400
  | 'not_found'         // 404 no such booking
  | 'not_online'        // 409 no Moyasar payment: paid at the studio, refund in person
  | 'wrong_status'      // 409 not waiting for a refund
  | 'in_progress'       // 409 another refund call holds this booking
  | 'amount_mismatch'   // 409 Moyasar's payment is not what the booking says was paid
  | 'not_refundable'    // 409 Moyasar says the payment was never completed
  | 'moyasar_error'     // 502 Moyasar refused or did not answer (message is Moyasar's)
  | 'internal_error';   // 500

export type RefundPaymentResponse =
  | {
      success: true;
      /** void: the charge was cancelled before settlement; refund: money sent
       *  back; moyasar_refunded / moyasar_voided: Moyasar already showed it
       *  returned (e.g. done in the dashboard), so only the booking changed. */
      method: 'void' | 'refund' | 'moyasar_refunded' | 'moyasar_voided';
      amountHalalas: number;
      /** False when the booking was already Refunded by someone else. */
      recorded: boolean;
      smsSent: boolean;
    }
  | { success: false; code: RefundPaymentCode; error: string };
