/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for bookingSmsTemplates.ts. No test framework — same
 * style as the other logic tests:
 *
 *   npx tsx supabase/functions/_shared/bookingSmsTemplates.test.ts
 */

import { bookingCancellationSms, smsBookingDate, smsAmount, FALLBACK_WORKSHOP_TITLE } from './bookingSmsTemplates.ts';

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

const input = { workshopTitle: 'Wheel Throwing', date: '2026-09-16', amount: 150 };

console.log('bookingCancellationSms() — exact registered templates');
assertEqual(
  bookingCancellationSms('refunded', input),
  'Your booking "Wheel Throwing" on 16/09/2026 was cancelled and 150 SAR refunded.\nتم إلغاء حجزك "Wheel Throwing" بتاريخ 16/09/2026 واسترداد 150 ريال.',
  'refunded'
);
assertEqual(
  bookingCancellationSms('notRefunded', input),
  'Your booking "Wheel Throwing" on 16/09/2026 was cancelled and is not eligible for a refund per our cancellation policy.\nتم إلغاء حجزك "Wheel Throwing" بتاريخ 16/09/2026، وهو غير مؤهل للاسترداد حسب سياسة الإلغاء.',
  'not refunded'
);
assertEqual(
  bookingCancellationSms('noShow', input),
  'Your booking "Wheel Throwing" on 16/09/2026 was cancelled as you were not present when called. It is non-refundable.\nتم إلغاء حجزك "Wheel Throwing" بتاريخ 16/09/2026 لعدم الحضور عند النداء، وهو غير قابل للاسترداد.',
  'no-show'
);

console.log('line break — a single "\\n", never a blank line');
for (const kind of ['refunded', 'notRefunded', 'noShow'] as const) {
  const sms = bookingCancellationSms(kind, input);
  assertEqual(sms.split('\n').length, 2, `${kind}: exactly one line break`);
  assertEqual(sms.includes('\n\n'), false, `${kind}: no blank line`);
  assertEqual(sms.includes('\r'), false, `${kind}: no carriage return`);
}

console.log('values');
assertEqual(smsBookingDate('2026-9-6'), '06/09/2026', 'date zero-padded DD/MM/YYYY');
assertEqual(smsBookingDate('bad'), 'bad', 'unreadable date sent as stored');
assertEqual(smsAmount(150.5), '150.5', 'amount is the number alone');
assertEqual(
  bookingCancellationSms('notRefunded', { workshopTitle: null, date: '2026-09-16' }).startsWith(`Your booking "${FALLBACK_WORKSHOP_TITLE}"`),
  true,
  'missing title falls back to Arty Workshop'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
  (globalThis as any).process?.exit(1);
}
