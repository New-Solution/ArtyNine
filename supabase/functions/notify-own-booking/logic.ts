/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision logic for notify-own-booking.
 *
 * Zero Deno/Supabase imports, so it runs under plain Node/tsx in
 * logic.test.ts — same arrangement as send-sms/logic.ts and
 * auto-cancel-bookings/logic.ts. index.ts does all the I/O; who is allowed
 * to trigger it and whether it was refunded live here.
 *
 * The SMS wording lives in ../_shared/bookingSmsTemplates.ts, shared with
 * auto-cancel-bookings and notifyBookingCancellation() (AppContext.tsx), so a
 * customer sees the same words regardless of who — or what — triggered the
 * cancellation.
 */

export interface BookingRow {
  id: string;
  customer_id: string | null;
  customer_phone: string | null;
  workshop_title: string | null;
  date: string | null;
  total_price: number | null;
  payment_status: string | null;
  status: string | null;
  /** Embedded via the customer_id -> customers.id foreign key (0001_init.sql:183).
   *  No longer read: every cancellation SMS is bilingual. */
  customers?: { preferred_lang: string | null } | null;
}

/** Whether the caller's own customer id matches this booking's owner. */
export function ownsBooking(booking: Pick<BookingRow, 'customer_id'>, callerCustomerId: string | null): boolean {
  return !!callerCustomerId && !!booking.customer_id && booking.customer_id === callerCustomerId;
}

/**
 * Mirrors cancelBooking()/cancel_own_booking's own refunded rule: the
 * booking's payment_status is the source of truth, not a client claim.
 */
export function wasRefunded(booking: Pick<BookingRow, 'payment_status'>): boolean {
  return booking.payment_status === 'Refunded';
}
