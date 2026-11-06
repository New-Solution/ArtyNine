/**
 * Plain-assertion tests for onlinePayments.ts. No test framework — same style
 * as captcha.test.ts:
 *
 *   npx tsx src/utils/onlinePayments.test.ts
 *
 * The normalisation cases mirror case 15 of migration 0046's manual tests, so
 * the browser and online_payments_config() agree on what a stored row means.
 */

import {
  normalizeOnlinePayments,
  DEFAULT_ONLINE_PAYMENTS,
  paymentTone,
  isPaidStatus,
  isLapsedHold,
  toHalalas,
  birthdayFullPrice,
  estimateOnlineAmount,
  PAYMENT_STATUSES
} from './onlinePayments';
import { enumLabel } from './enumLabels';

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

console.log('normalizeOnlinePayments()');
assertEqual(normalizeOnlinePayments(undefined), DEFAULT_ONLINE_PAYMENTS, 'missing row -> defaults (off)');
assertEqual(normalizeOnlinePayments(null), DEFAULT_ONLINE_PAYMENTS, 'null -> defaults');
assertEqual(normalizeOnlinePayments([]), DEFAULT_ONLINE_PAYMENTS, 'array -> defaults');
assertEqual(
  normalizeOnlinePayments({ enabled: true, holdMinutes: 15, workshop: { mode: 'deposit', depositAmount: 100 }, birthday: { mode: 'full' } }),
  { enabled: true, holdMinutes: 15, workshop: { mode: 'deposit', depositAmount: 100 }, birthday: { mode: 'full', depositAmount: 100 } },
  'the seeded row, enabled'
);
assertEqual(
  normalizeOnlinePayments({ enabled: true, holdMinutes: 'abc', workshop: { mode: 'weird', depositAmount: 'x' } }),
  { enabled: true, holdMinutes: 15, workshop: { mode: 'deposit', depositAmount: 100 }, birthday: { mode: 'full', depositAmount: 100 } },
  'malformed row -> per-field defaults (0046 case 15)'
);
assertEqual(normalizeOnlinePayments({ enabled: 'true' }).enabled, false, 'enabled must be a real boolean');
assertEqual(normalizeOnlinePayments({ holdMinutes: 1 }).holdMinutes, 5, 'hold clamped up to 5');
assertEqual(normalizeOnlinePayments({ holdMinutes: 999 }).holdMinutes, 120, 'hold clamped down to 120');
assertEqual(normalizeOnlinePayments({ holdMinutes: 20.9 }).holdMinutes, 20, 'hold floored');
assertEqual(normalizeOnlinePayments({ workshop: { depositAmount: 0.5 } }).workshop.depositAmount, 100, 'deposit under 1 SAR -> default');
assertEqual(normalizeOnlinePayments({ workshop: { depositAmount: 75.555 } }).workshop.depositAmount, 75.56, 'deposit rounded to halalas');
assertEqual(normalizeOnlinePayments({ birthday: { mode: 'deposit', depositAmount: 250 } }).birthday, { mode: 'deposit', depositAmount: 250 }, 'birthday can be switched to deposit');

console.log('payment statuses');
assertEqual(paymentTone('Paid'), 'paid', 'Paid -> paid');
assertEqual(paymentTone('Deposit Paid'), 'paid', 'Deposit Paid -> paid');
assertEqual(paymentTone('Awaiting Payment'), 'waiting', 'Awaiting Payment -> waiting');
assertEqual(paymentTone('Needs Refund'), 'attention', 'Needs Refund -> attention');
assertEqual(paymentTone('Refunded'), 'refunded', 'Refunded -> refunded');
assertEqual(paymentTone('Expired'), 'closed', 'Expired -> closed');
assertEqual(paymentTone('Unpaid'), 'unpaid', 'Unpaid -> unpaid');
assertEqual(paymentTone(undefined), 'unpaid', 'missing -> unpaid');
assertEqual(isPaidStatus('Deposit Paid'), true, 'Deposit Paid is paid');
assertEqual(isPaidStatus('Awaiting Payment'), false, 'a hold is not paid');
for (const status of PAYMENT_STATUSES) {
  assertEqual(enumLabel('payment', status, 'ar') !== status, true, `Arabic label exists for ${status}`);
}

console.log('isLapsedHold()');
const now = Date.parse('2099-01-01T12:00:00Z');
assertEqual(isLapsedHold({ paymentStatus: 'Awaiting Payment', paymentExpiresAt: '2099-01-01T11:59:59Z' }, now), true, 'past expiry -> lapsed');
assertEqual(isLapsedHold({ paymentStatus: 'Awaiting Payment', paymentExpiresAt: '2099-01-01T12:00:00Z' }, now), true, 'expiry is inclusive, like the SQL <= now()');
assertEqual(isLapsedHold({ paymentStatus: 'Awaiting Payment', paymentExpiresAt: '2099-01-01T12:05:00Z' }, now), false, 'still held');
assertEqual(isLapsedHold({ paymentStatus: 'Deposit Paid', paymentExpiresAt: '2099-01-01T11:00:00Z' }, now), false, 'paid is never lapsed');
assertEqual(isLapsedHold({ paymentStatus: 'Awaiting Payment' }, now), false, 'no expiry -> not lapsed');

console.log('toHalalas()');
assertEqual(toHalalas(100), 10000, '100 SAR');
assertEqual(toHalalas(0.1 + 0.2), 30, 'float noise rounded');
assertEqual(toHalalas(1199.99), 119999, '1199.99 SAR');

console.log('estimates (mirror online_payment_terms)');
const dep = { mode: 'deposit' as const, depositAmount: 100 };
const full = { mode: 'full' as const, depositAmount: 100 };
assertEqual(estimateOnlineAmount(300, dep), { mode: 'deposit', dueNow: 100, balance: 200 }, 'deposit 100 of 300');
assertEqual(estimateOnlineAmount(60, dep), { mode: 'deposit', dueNow: 60, balance: 0 }, 'deposit never above the price (0046 case 3)');
assertEqual(estimateOnlineAmount(1200, full), { mode: 'full', dueNow: 1200, balance: 0 }, 'full price');
assertEqual(birthdayFullPrice({ price: 120, pricingType: 'Per child' }, 10), 1200, 'per child x guests (0046 case 4)');
assertEqual(birthdayFullPrice({ price: 1500, pricingType: 'Fixed price' }, 10), 1500, 'fixed price ignores guests (0046 case 4b)');
assertEqual(birthdayFullPrice(undefined, 10), 0, 'no package -> 0');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


