/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for the auto-cancel decision rules. No test
 * framework — logic.ts has zero Deno dependencies specifically so this runs
 * under the tsx devDependency already installed here:
 *
 *   npx tsx supabase/functions/auto-cancel-bookings/logic.test.ts
 *
 * The rule under test is the one the client-side timer enforced before this
 * function replaced it, so these double as a regression net for that move:
 * a Called guest is a no-show, a Waiting one is not.
 */

import {
  isNoShow,
  isExpiredHold,
  bookingStartMs,
  findQueueRow,
  normalizePhone,
  noShowMessage,
  NO_SHOW_NOTIFICATION_TITLE,
  NO_SHOW_TIMELINE_ACTION,
  GRACE_MINUTES,
  type BookingRow,
  type QueueRow
} from './logic.ts';

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}\n      got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
  }
}

// 2026-08-31 21:00 Riyadh == 18:00 UTC.
const START_MS = Date.UTC(2026, 7, 31, 18, 0);
const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: 'ART-99',
  status: 'Pending',
  date: '2026-08-31',
  time: '09:00 PM',
  customer_name: 'Enas Alqarni',
  customer_phone: '+966 50 456 39',
  workshop_title: 'Clay Pottery',
  ...over
});
const q = (status: string, over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'Q-1',
  booking_id: 'ART-99',
  phone: '+966 50 456 39',
  date: '2026-08-31',
  status,
  ...over
});

const LATE = START_MS + 16 * 60_000;
const EARLY = START_MS + 5 * 60_000;

console.log('--- start-time parsing (mirrors booking_start_at) ---');
assertEqual(bookingStartMs('2026-08-31', '09:00 PM'), START_MS, '09:00 PM Riyadh -> 18:00 UTC');
assertEqual(bookingStartMs('2026-08-31', '21:00'), START_MS, '21:00 is the same instant');
assertEqual(bookingStartMs('2026-08-31', '21:00 - 23:00'), START_MS, 'range uses its start');
assertEqual(bookingStartMs('2026-08-31', '12:00 AM'), Date.UTC(2026, 7, 30, 21, 0), '12:00 AM is midnight');
assertEqual(bookingStartMs('2026-08-31', '12:00 PM'), Date.UTC(2026, 7, 31, 9, 0), '12:00 PM is noon');
assertEqual(bookingStartMs('2026-08-31', 'noon'), null, 'unreadable time -> null');
assertEqual(bookingStartMs('', '21:00'), null, 'missing date -> null');

console.log('\n--- no-show: only a Called guest ---');
assertEqual(isNoShow(booking(), [q('Called')], LATE), true, 'Called + 16 min late -> cancelled as no-show');
assertEqual(isNoShow(booking(), [q('Waiting')], LATE), false, 'Waiting is protected');
assertEqual(isNoShow(booking(), [q('In Progress')], LATE), false, 'seated is protected');
assertEqual(isNoShow(booking(), [q('Completed')], LATE), false, 'completed is protected');
assertEqual(isNoShow(booking(), [q('Cancelled')], LATE), false, 'cancelled row is not a no-show');
assertEqual(isNoShow(booking(), [], LATE), false, 'no queue row -> protected');
assertEqual(isNoShow(booking(), [q('Called')], EARLY), false, 'Called but only 5 min late -> not yet');
assertEqual(
  isNoShow(booking(), [q('Called')], START_MS + GRACE_MINUTES * 60_000),
  true,
  'exactly 15 min late -> fires'
);
assertEqual(isNoShow(booking({ status: 'Checked In' }), [q('Called')], LATE), false, 'Checked In booking is never touched');
assertEqual(isNoShow(booking({ status: 'Cancelled' }), [q('Called')], LATE), false, 'already Cancelled is never re-cancelled');
assertEqual(isNoShow(booking({ status: 'Completed' }), [q('Called')], LATE), false, 'Completed booking is never touched');

console.log('\n--- queue matching ---');
assertEqual(normalizePhone('+966 50 456 39'), '5045639', 'strips +966 and spaces');
assertEqual(normalizePhone('050 456 39'), '5045639', 'strips leading 0');
assertEqual(normalizePhone('00966 50 456 39'), '5045639', 'strips 00966');
assertEqual(!!findQueueRow([q('Called', { phone: 'nonsense' })], booking()), true, 'booking_id wins over phone');
assertEqual(
  !!findQueueRow([q('Called', { booking_id: null, phone: '050 456 39' })], booking()),
  true,
  'falls back to normalized phone'
);
assertEqual(
  !!findQueueRow([q('Called', { booking_id: null, date: '2026-08-30' })], booking()),
  false,
  'a different day does not match'
);
assertEqual(
  !!findQueueRow([q('Called', { booking_id: null, phone: '' })], booking({ customer_phone: '' })),
  false,
  'no phone -> no false match'
);
assertEqual(
  isNoShow(booking(), [q('Called', { booking_id: null, date: '2026-08-30' })], LATE),
  false,
  "yesterday's Called row does not cancel today's booking"
);

console.log('\n--- customer wording ---');
const noShowMsg = noShowMessage(booking());
assertEqual(noShowMsg.includes('not refundable'), true, 'no-show states it is not refundable');
assertEqual(noShowMsg.includes('called for you'), true, 'no-show explains it was called');
assertEqual(noShowMsg.includes('31 August 2026'), true, 'message names the date');
assertEqual(NO_SHOW_NOTIFICATION_TITLE.includes('Missed Session'), true, 'notification title names the reason');
assertEqual(NO_SHOW_TIMELINE_ACTION, 'Did not show up — auto-cancelled (System Action)', 'no-show timeline text unchanged');
assertEqual(noShowMessage(booking({ date: 'bad' })).includes('undefined'), false, 'bad date never prints undefined');

console.log('\n--- online payment holds (0046) ---');
assertEqual(isNoShow(booking({ payment_status: 'Awaiting Payment' }), [q('Called')], START_MS + 60 * 60_000), false, 'an unpaid hold is never a no-show');
const hold = { id: 'ART-1', status: 'Pending', payment_status: 'Awaiting Payment', payment_expires_at: '2026-08-31T18:00:00Z' };
assertEqual(isExpiredHold(hold, START_MS), true, 'expiry is inclusive');
assertEqual(isExpiredHold(hold, START_MS - 1), false, 'not yet expired');
assertEqual(isExpiredHold({ ...hold, payment_status: 'Unpaid' }, START_MS), false, 'Unpaid (pay at counter) is never expired');
assertEqual(isExpiredHold({ ...hold, status: 'Cancelled' }, START_MS), false, 'a self-cancelled hold is left alone');
assertEqual(isExpiredHold({ ...hold, payment_expires_at: null }, START_MS), false, 'no expiry, no expiring');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
