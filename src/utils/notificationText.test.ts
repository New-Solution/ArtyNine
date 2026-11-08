/**
 * Plain-assertion tests for the cancellation notices in notificationText.ts.
 * No test framework — same style as captcha.test.ts:
 *
 *   npx tsx src/utils/notificationText.test.ts
 *
 * The English messages are exactly what cancel_own_booking (0048) and
 * notifyBookingCancellation() (AppContext.tsx) store.
 */

import { localizeNotification } from './notificationText';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${e}, got ${a}`);
  }
}

const n = (title: string, message: string) => ({ title, message } as any);

console.log('cancellation notices -> Arabic');
const unpaid = n('Booking Cancelled', 'Your unpaid booking for "Wheel Throwing" on September 16, 2026 has been cancelled. Nothing was charged.');
assertEqual(localizeNotification(unpaid, 'ar'), {
  title: 'تم إلغاء الحجز',
  message: 'تم إلغاء حجزك غير المدفوع في "Wheel Throwing" بتاريخ 16 سبتمبر 2026. لم يُخصم أي مبلغ.'
}, 'unpaid cancellation (0046 hold / 0048 Unpaid)');
assertEqual(/استرداد|refund/i.test(localizeNotification(unpaid, 'ar').message), false, 'unpaid notice never mentions a refund');

const due = n('Booking Cancelled', 'Your booking for "Wheel Throwing" on September 16, 2026 has been cancelled. The studio will refund your payment.');
assertEqual(localizeNotification(due, 'ar'), {
  title: 'تم إلغاء الحجز',
  message: 'تم إلغاء حجزك في "Wheel Throwing" بتاريخ 16 سبتمبر 2026. سيعيد الاستوديو المبلغ المدفوع إليك.'
}, 'refund due (0048 Needs Refund)');

const kept = n('Booking Cancelled', 'Your booking for "Wheel Throwing" on September 16, 2026 has been cancelled. Per our cancellation policy, this booking was not eligible for a refund. Please contact Arty Café with any questions.');
assertEqual(localizeNotification(kept, 'ar').title, 'تم إلغاء الحجز', 'not refunded still translated (unchanged)');
assertEqual(localizeNotification(kept, 'ar').message.startsWith('تم إلغاء حجزك في "Wheel Throwing" بتاريخ 16 سبتمبر 2026. وفقًا'), true, 'not refunded message unchanged');

const refunded = n('Booking Cancelled — Refunded', 'Your booking for "Wheel Throwing" on September 16, 2026 has been cancelled, and 150 SAR has been refunded. We hope to see you again soon!');
assertEqual(localizeNotification(refunded, 'ar').title, 'تم إلغاء الحجز — تم الاسترداد', 'refunded still translated (unchanged)');

assertEqual(localizeNotification(unpaid, 'en'), { title: unpaid.title, message: unpaid.message }, 'English shown as stored');
const other = n('Booking Cancelled', 'Something else entirely.');
assertEqual(localizeNotification(other, 'ar'), { title: other.title, message: other.message }, 'unknown wording falls back to the stored text');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
