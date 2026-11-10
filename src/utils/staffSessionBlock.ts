/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A customer-site booking refused because a staff session is signed in on the
 * same browser (see addBooking in AppContext). addBooking throws
 * `${STAFF_SESSION_BOOKING_ERROR}:<reason>`; the checkout reads it back with
 * staffSessionBlockReason() to show the right message and sign-out button.
 *
 *   staff-console  a staff console session is signed in on this browser;
 *   staff-account  the customer-site session itself is a staff account.
 *
 * Nothing is written in either case. No browser APIs, so this runs under
 * plain tsx in staffSessionBlock.test.ts.
 */

export const STAFF_SESSION_BOOKING_ERROR = 'staff-session-active';

export type StaffSessionBlockReason = 'staff-console' | 'staff-account';

export function staffSessionBookingError(reason: StaffSessionBlockReason): Error {
  return new Error(`${STAFF_SESSION_BOOKING_ERROR}:${reason}`);
}

/** The reason a booking error carries, or null for any other error. */
export function staffSessionBlockReason(err: unknown): StaffSessionBlockReason | null {
  const message = String((err as { message?: unknown } | null)?.message ?? '');
  if (!message.startsWith(STAFF_SESSION_BOOKING_ERROR + ':')) return null;
  const reason = message.slice(STAFF_SESSION_BOOKING_ERROR.length + 1);
  return reason === 'staff-account' ? 'staff-account' : 'staff-console';
}
