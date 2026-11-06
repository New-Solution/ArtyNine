/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision logic for the auto-cancel-bookings scheduled function.
 *
 * Zero Deno/Supabase imports, so it runs under plain Node/tsx in
 * logic.test.ts — same arrangement as send-sms/logic.ts and
 * provision-staff/logic.ts. index.ts does all the I/O; every rule about
 * *whether* to cancel and *what to say* lives here.
 *
 * The no-show rule is a deliberate mirror of the client-side timer this
 * replaces (AppContext.tsx): same 15-minute threshold, same statuses, same
 * Called-only gate. If it changes, it changes here — the client timer is gone.
 *
 * A second rule once lived here, cancelling Pending + Unpaid bookings 15
 * minutes after creation. It was removed: every online booking was "paid" at
 * booking time, so it matched nothing, and it would have cancelled any
 * pay-at-counter booking a quarter of an hour after it was taken.
 *
 * Online payments (migration 0046) brought back a pay-later state, with its
 * own explicit marker rather than "Unpaid": an 'Awaiting Payment' booking is a
 * hold with a payment_expires_at. isExpiredHold() is that rule. It never
 * touches 'Unpaid' (a pay-at-counter booking), and holds are never treated as
 * no-shows — a customer who has not paid yet has not been called yet.
 */

/** Minutes of grace before a called guest is treated as absent. */
export const GRACE_MINUTES = 15;

/** Kept as a named union so the response shape can carry a reason, and so
 *  a second rule can be added back without reshaping the contract. */
export type CancelReason = 'no_show' | 'payment_expired';

export interface BookingRow {
  id: string;
  status: string | null;
  date: string | null;
  time: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  workshop_title: string | null;
  /** Read so an unpaid online hold is never judged a no-show. */
  payment_status?: string | null;
}

/** An online hold (0046), as the expiry scan reads it. */
export interface HoldRow {
  id: string;
  status: string | null;
  payment_status: string | null;
  payment_expires_at: string | null;
}

export interface QueueRow {
  id: string;
  booking_id: string | null;
  phone: string | null;
  date: string | null;
  status: string | null;
}

/**
 * Digits-only national form. Mirrors normalizeCustomerPhone()
 * (src/utils/customerIdentity.ts) and normalize_customer_phone()
 * (0001_init.sql): strip non-digits, then a leading 00, then 966, then 0.
 *
 * Matching queue rows to bookings on the raw string missed '+966 50 …'
 * against '05…' for the same person, which is how a seated customer could
 * stay Pending and be cancelled while sitting at a table.
 */
export function normalizePhone(phone?: string | null): string {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('966')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/** Zero-pads a y-m-d date so '2026-8-3' and '2026-08-03' compare equal. */
export function normalizeDate(value?: string | null): string {
  const trimmed = String(value ?? '').trim();
  const parts = trimmed.split('-');
  if (parts.length !== 3) return trimmed;
  return `${parts[0].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

/**
 * A booking's start as an epoch milliseconds value, or null if unreadable.
 *
 * Mirrors parseBookingDateTimeToRiyadhDate() (src/utils/dateUtils.ts) and
 * booking_start_at() (migration 0017): handles '09:00 PM', '16:00', and the
 * '16:00 - 18:00' range form, whose first half is the start. The stored date
 * and time are Riyadh wall-clock, so the offset is applied explicitly rather
 * than relying on the runtime's zone — an Edge Function runs in UTC.
 */
export const RIYADH_UTC_OFFSET_HOURS = 3;

export function bookingStartMs(date?: string | null, time?: string | null): number | null {
  const day = normalizeDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  let raw = String(time ?? '').split(' - ')[0].trim().toUpperCase();
  if (!raw) return null;

  const isPm = raw.includes('PM');
  const isAm = raw.includes('AM');
  raw = raw.replace('PM', '').replace('AM', '').trim();

  const parts = raw.split(':');
  const hh = Number.parseInt(parts[0], 10);
  const mm = parts.length > 1 ? Number.parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  let hour = hh;
  if (isPm && hh < 12) hour = hh + 12;
  else if (isAm && hh === 12) hour = 0;

  const [y, m, d] = day.split('-').map(Number);
  // Build in UTC, then subtract Riyadh's offset to get the real instant.
  return Date.UTC(y, m - 1, d, hour, mm) - RIYADH_UTC_OFFSET_HOURS * 3600_000;
}

/**
 * The queue row belonging to a booking, if any.
 *
 * booking_id first — the real link. Phone is the fallback for rows written
 * before that link existed, compared normalized and scoped to the booking's
 * own day so last week's row for the same person is never picked up.
 */
export function findQueueRow(queue: QueueRow[], booking: BookingRow): QueueRow | undefined {
  const byId = queue.find(q => q.booking_id && String(q.booking_id) === String(booking.id));
  if (byId) return byId;

  const wanted = normalizePhone(booking.customer_phone);
  if (!wanted) return undefined;

  return queue.find(
    q => normalizePhone(q.phone) === wanted && normalizeDate(q.date) === normalizeDate(booking.date)
  );
}

/**
 * Whether a booking should be auto-cancelled as a no-show.
 *
 * Pending, at least 15 minutes past the session start, and the customer's
 * queue row is in Called. Called is the one state meaning "we asked for this
 * person and they did not come". Waiting means we have not asked yet; seated
 * or checked in means they are here; no row at all means they were never
 * queued. All three are protected — the studio decides, not the clock.
 */
export function isNoShow(booking: BookingRow, queue: QueueRow[], nowMs: number): boolean {
  if (String(booking.status ?? '') !== 'Pending') return false;
  // An unpaid online hold is the expiry rule's, never this one's.
  if (booking.payment_status === 'Awaiting Payment') return false;

  const startMs = bookingStartMs(booking.date, booking.time);
  if (startMs === null || nowMs - startMs < GRACE_MINUTES * 60_000) return false;

  return findQueueRow(queue, booking)?.status === 'Called';
}

/**
 * Whether an online hold has run out and should be marked expired.
 *
 * Pending + 'Awaiting Payment' + payment_expires_at reached. The database
 * already stopped counting its seat at that instant (session_seats_taken,
 * 0046); this is the tidy-up that makes the booking say so. Inclusive, like
 * the SQL's payment_expires_at <= now(). A hold the customer cancelled
 * themselves (status Cancelled) is left alone.
 */
export function isExpiredHold(hold: HoldRow, nowMs: number): boolean {
  if (hold.status !== 'Pending' || hold.payment_status !== 'Awaiting Payment') return false;
  if (!hold.payment_expires_at) return false;
  const expires = Date.parse(hold.payment_expires_at);
  return Number.isFinite(expires) && expires <= nowMs;
}

/** Timeline entry for an expired hold. No SMS and no notification are sent:
 *  nothing was charged, and the customer saw the hold end on the payment page. */
export const HOLD_EXPIRED_TIMELINE_ACTION = 'Payment not completed in time — hold released (System Action)';

/** Most holds a single run expires; the rest wait for the next run. */
export const HOLD_EXPIRY_BATCH = 200;

/** The timeline entry, matching the wording the client timer wrote. */
export const NO_SHOW_TIMELINE_ACTION = 'Did not show up — auto-cancelled (System Action)';

/** Appended to the booking's notes, as the client timer did. */
export const NO_SHOW_NOTE = 'Did not show up — auto-cancelled';

/** The in-app notification title. */
export const NO_SHOW_NOTIFICATION_TITLE = 'Booking Cancelled — Missed Session';

/**
 * What the customer is told.
 *
 * Deliberately not the refunded/not-refunded pair notifyBookingCancellation()
 * uses: this is not a refund decision. A no-show is non-refundable under the
 * cancellation policy, and saying so plainly is more use to the customer than
 * a generic "your booking was cancelled".
 */
export function noShowMessage(booking: BookingRow): string {
  const title = booking.workshop_title || 'your workshop';
  const when = formatBookingDate(booking.date);

  return `Arty Café: your booking for "${title}"${when} has been cancelled. We called for you and you had not arrived, so the place has been released. Per our cancellation policy this booking is not refundable. Please contact the studio if you think this is a mistake.`;
}

/** " on 31 August 2026", or empty when the date is unreadable. */
function formatBookingDate(date?: string | null): string {
  const day = normalizeDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const [y, m, d] = day.split('-').map(Number);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return ` on ${d} ${months[m - 1]} ${y}`;
}
