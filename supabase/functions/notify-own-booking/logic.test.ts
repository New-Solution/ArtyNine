/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for notify-own-booking/logic.ts. No test framework —
 * same style as the other logic tests:
 *
 *   npx tsx supabase/functions/notify-own-booking/logic.test.ts
 */

import { ownsBooking, wasRefunded, cancellationSms, shouldSendCancellationSms } from './logic.ts';

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('ownsBooking()');
assertEqual(ownsBooking({ customer_id: 'C1' }, 'C1'), true, 'own booking');
assertEqual(ownsBooking({ customer_id: 'C1' }, 'C2'), false, "someone else's booking");
assertEqual(ownsBooking({ customer_id: null }, 'C1'), false, 'unowned booking');
assertEqual(ownsBooking({ customer_id: 'C1' }, null), false, 'caller with no customer record');

console.log('cancellationSms() — what cancel_own_booking (0048) leaves behind');
// Never paid: Unpaid stays Unpaid; a hold stays Awaiting Payment.
assertEqual(cancellationSms({ payment_status: 'Unpaid' }), null, 'unpaid pay-at-studio cancellation -> no SMS');
assertEqual(shouldSendCancellationSms({ payment_status: 'Unpaid' }), false, 'unpaid -> nothing sent');
assertEqual(cancellationSms({ payment_status: 'Awaiting Payment' }), null, 'unpaid online hold -> no SMS');
// Refund due (online full >24h, or paid at the studio >24h).
assertEqual(cancellationSms({ payment_status: 'Needs Refund' }), null, 'refund due, not done -> no SMS');
// Paid and kept (online deposit; any paid booking within 24h).
assertEqual(cancellationSms({ payment_status: 'Deposit Paid' }), 'notRefunded', 'deposit kept -> not refunded');
assertEqual(cancellationSms({ payment_status: 'Paid' }), 'notRefunded', 'paid within 24h -> not refunded');
// Only staff write Refunded now.
assertEqual(cancellationSms({ payment_status: 'Refunded' }), 'refunded', 'already refunded by staff -> refunded');
assertEqual(wasRefunded({ payment_status: 'Needs Refund' }), false, 'Needs Refund is not refunded');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
  (globalThis as any).process?.exit(1);
}
