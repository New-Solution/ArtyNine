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
  paymentBreakdown,
  collectedAmount,
  studioBalanceDue,
  sarAmount,
  customerAmountView,
  staffCancelPayment,
  ONLINE_REFUND_DUE_NOTE,
  PAYMENT_STATUSES
} from './onlinePayments';
import { enumLabel } from './enumLabels';
import { cancellationSmsKind } from '../../supabase/functions/_shared/bookingSmsTemplates';

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
assertEqual(paymentTone('Refund Processing'), 'waiting', 'Refund Processing (0054) -> waiting');
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

console.log('paid vs total');
const dep150 = { totalPrice: 150, paymentStatus: 'Deposit Paid', paymentMode: 'deposit' as const, onlineAmount: '100.00', moyasarPaymentId: 'p1' };
assertEqual(paymentBreakdown(dep150), { online: true, mode: 'deposit', total: 150, paid: 100, balance: 50 }, 'deposit 100 of 150 (numeric string from Postgres)');
assertEqual(paymentBreakdown({ totalPrice: 1200, paymentStatus: 'Paid', paymentMode: 'full', onlineAmount: 1200, moyasarPaymentId: 'p2' }), { online: true, mode: 'full', total: 1200, paid: 1200, balance: 0 }, 'full payment');
assertEqual(paymentBreakdown({ totalPrice: 150, paymentStatus: 'Deposit Paid', paymentMode: 'deposit', onlineAmount: 100 }).online, false, 'no recorded Moyasar payment -> not paid online');
assertEqual(paymentBreakdown({ totalPrice: 150, paymentStatus: 'Deposit Paid', paymentMode: 'deposit', onlineAmount: 100, moyasarPaymentId: 'verified' }).online, true, 'confirmation screen: verified payment id carried');

console.log('never paid: expired and cancelled-unpaid holds');
const expired = { totalPrice: 150, paymentStatus: 'Expired', paymentMode: 'deposit' as const, onlineAmount: '100.00', moyasarPaymentId: null };
const cancelledHold = { totalPrice: 150, paymentStatus: 'Awaiting Payment', paymentMode: 'deposit' as const, onlineAmount: 100, moyasarPaymentId: null };
assertEqual(paymentBreakdown(expired), { online: false, mode: 'deposit', total: 150, paid: 150, balance: 0 }, 'expired hold: not paid online, no balance');
assertEqual(paymentBreakdown(cancelledHold), { online: false, mode: 'deposit', total: 150, paid: 150, balance: 0 }, 'cancelled unpaid hold: not paid online, no balance');
assertEqual(collectedAmount(expired), 0, 'expired hold collects nothing');
assertEqual(collectedAmount(cancelledHold), 0, 'cancelled unpaid hold collects nothing');
assertEqual(studioBalanceDue(expired), 0, 'expired hold: no studio balance');
assertEqual(studioBalanceDue(cancelledHold), 0, 'cancelled unpaid hold: no studio balance');
assertEqual(paymentBreakdown({ ...expired, moyasarPaymentId: 'p-declined' }).online, false, 'expired with a declined payment on record: still not paid');
assertEqual(paymentBreakdown({ ...cancelledHold, moyasarPaymentId: 'p-x' }).online, false, 'a payment id alone is not enough: status must say paid');

console.log('refund states keep the paid record, drop the balance');
const refundDue = { totalPrice: 150, paymentStatus: 'Needs Refund', paymentMode: 'deposit' as const, onlineAmount: 100, moyasarPaymentId: 'p3' };
assertEqual(paymentBreakdown(refundDue), { online: true, mode: 'deposit', total: 150, paid: 100, balance: 0 }, 'Needs Refund: paid 100 shown, no studio balance');
assertEqual(paymentBreakdown({ ...refundDue, paymentStatus: 'Refunded' }), { online: true, mode: 'deposit', total: 150, paid: 100, balance: 0 }, 'Refunded: paid 100 shown, no studio balance');
assertEqual(collectedAmount(refundDue), 0, 'Needs Refund is not revenue');
assertEqual(studioBalanceDue({ ...refundDue, paymentStatus: 'Refunded' }), 0, 'Refunded owes nothing');
assertEqual(paymentBreakdown({ totalPrice: 150, paymentStatus: 'Awaiting Payment', paymentMode: 'deposit', onlineAmount: 100 }), { online: false, mode: 'deposit', total: 150, paid: 150, balance: 0 }, 'unpaid hold is not online-paid');
assertEqual(paymentBreakdown({ totalPrice: 300, paymentStatus: 'Paid' }), { online: false, mode: null, total: 300, paid: 300, balance: 0 }, 'legacy booking unchanged');
assertEqual(collectedAmount(dep150), 100, 'revenue counts the deposit, not the total');
assertEqual(collectedAmount({ totalPrice: 300, paymentStatus: 'Paid' }), 300, 'legacy Paid counts the total (today)');
assertEqual(collectedAmount({ totalPrice: 500, paymentStatus: 'Deposit Paid' }), 500, "legacy Deposit Paid keeps today's rule");
assertEqual(collectedAmount({ ...dep150, paymentStatus: 'Refunded' }), 0, 'refunded collects nothing');
assertEqual(collectedAmount({ totalPrice: 150, paymentStatus: 'Awaiting Payment' }), 0, 'hold collects nothing');
assertEqual(studioBalanceDue(dep150), 50, 'balance due 50');
assertEqual(studioBalanceDue({ totalPrice: 300, paymentStatus: 'Paid' }), 0, 'legacy: no balance figure');
assertEqual(sarAmount(150), '150', 'integer amount');
assertEqual(sarAmount(99.5), '99.5', 'one decimal');
assertEqual(sarAmount(0.1 + 0.2), '0.3', 'float noise');

console.log('customerAmountView() — the My Bookings amount line');
// The reported bug: an unpaid pay-at-studio booking read "PAID AMOUNT 150 SAR".
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: 'Unpaid', status: 'Pending' }), { kind: 'due', amount: 150 }, 'unpaid pay-at-studio booking -> amount due at the studio, not Paid');
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: 'Unpaid', status: 'Checked In' }).kind, 'due', 'unpaid, checked in -> still due');
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: undefined, status: 'Pending' }).kind, 'due', 'missing status -> due, never Paid');
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: 'Unpaid', status: 'Cancelled' }), { kind: 'none' }, 'cancelled unpaid -> nothing owed, no amount');
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: 'Paid', status: 'Pending' }), { kind: 'paid', amount: 150, depositOnly: false }, 'marked Paid by staff -> Paid 150');
assertEqual(customerAmountView({ totalPrice: 500, paymentStatus: 'Deposit Paid', status: 'Pending' }), { kind: 'paid', amount: 500, depositOnly: true }, 'staff Deposit Paid -> total + deposit note, not "Paid 500"');
assertEqual(
  customerAmountView({ totalPrice: 150, paymentStatus: 'Deposit Paid', paymentMode: 'deposit', onlineAmount: 100, moyasarPaymentId: 'p1', status: 'Pending' }),
  { kind: 'online-paid', mode: 'deposit', paid: 100, balance: 50 },
  'online deposit -> deposit paid 100, balance 50'
);
assertEqual(
  customerAmountView({ totalPrice: 1200, paymentStatus: 'Paid', paymentMode: 'full', onlineAmount: 1200, moyasarPaymentId: 'p2', status: 'Pending' }),
  { kind: 'online-paid', mode: 'full', paid: 1200, balance: 0 },
  'online full payment -> paid 1200'
);
assertEqual(
  customerAmountView({ totalPrice: 300, paymentStatus: 'Awaiting Payment', paymentMode: 'deposit', onlineAmount: 100, status: 'Pending' }),
  { kind: 'awaiting', amount: 100 },
  'live hold -> awaiting 100, not Paid'
);
assertEqual(
  customerAmountView({ totalPrice: 300, paymentStatus: 'Awaiting Payment', paymentMode: 'deposit', onlineAmount: 100, status: 'Cancelled' }),
  { kind: 'none' },
  'hold cancelled before paying -> no amount'
);
assertEqual(
  customerAmountView({ totalPrice: 300, paymentStatus: 'Expired', paymentMode: 'deposit', onlineAmount: 100, status: 'Cancelled' }),
  { kind: 'none' },
  'expired hold -> no amount'
);
assertEqual(
  customerAmountView({ totalPrice: 300, paymentStatus: 'Awaiting Payment', paymentMode: 'deposit', onlineAmount: 100, moyasarPaymentId: 'p-x', status: 'Pending' }).kind,
  'awaiting',
  'a payment id alone does not make a hold paid'
);
assertEqual(customerAmountView({ totalPrice: 150, paymentStatus: 'Refunded', status: 'Cancelled' }), { kind: 'none' }, 'offline Refunded -> no "Paid" amount (may never have been paid)');
assertEqual(
  customerAmountView({ totalPrice: 150, paymentStatus: 'Refunded', paymentMode: 'deposit', onlineAmount: 100, moyasarPaymentId: 'p3', status: 'Cancelled' }),
  { kind: 'online-paid', mode: 'deposit', paid: 100, balance: 0 },
  'online deposit refunded -> shows the 100 actually paid'
);
for (const status of PAYMENT_STATUSES) {
  if (isPaidStatus(status)) continue;
  const v = customerAmountView({ totalPrice: 150, paymentStatus: status, status: 'Pending' });
  assertEqual(v.kind === 'paid' || v.kind === 'online-paid', false, `${status} with no payment recorded is never shown as paid`);
}

// 0054 — Refund Processing behaves like Needs Refund: never counted as collected.
{
  const processing = { totalPrice: 150, paymentStatus: 'Refund Processing', paymentMode: 'full' as const, onlineAmount: 150, moyasarPaymentId: 'p9', status: 'Cancelled' };
  const needsRefund = { ...processing, paymentStatus: 'Needs Refund' };
  assertEqual(collectedAmount(processing), 0, 'Refund Processing: not counted as revenue');
  assertEqual(customerAmountView(processing), customerAmountView(needsRefund), 'Refund Processing: customer sees the same as Needs Refund');
  assertEqual(enumLabel('payment', 'Refund Processing', 'ar'), 'جارٍ الاسترداد', 'Refund Processing: Arabic label');
}

// Staff Cancel dialog: "Refunded" for an online payment is a refund DUE.
{
  const online = { moyasarPaymentId: 'pay-1', paymentStatus: 'Paid' };
  const onlineDeposit = { moyasarPaymentId: 'pay-2', paymentStatus: 'Deposit Paid' };
  const studio = { moyasarPaymentId: undefined, paymentStatus: 'Paid' };
  const studioNull = { moyasarPaymentId: null, paymentStatus: 'Deposit Paid' };

  const r1 = staffCancelPayment(online, 'Refunded');
  assertEqual(r1.paymentStatus, 'Needs Refund', 'online Paid + Refunded -> Needs Refund, never Refunded');
  assertEqual(r1.note, ` — Refund due: ${ONLINE_REFUND_DUE_NOTE}`, 'online: timeline says to use the Refund button');
  assertEqual(ONLINE_REFUND_DUE_NOTE, 'Use the Refund button to return the money through Moyasar', 'note wording');
  assertEqual(cancellationSmsKind(r1.paymentStatus), null, 'online + Refunded: no refunded SMS at cancellation');
  assertEqual(staffCancelPayment(onlineDeposit, 'Refunded').paymentStatus, 'Needs Refund', 'online deposit + Refunded -> Needs Refund');

  assertEqual(staffCancelPayment(online, undefined), { paymentStatus: 'Paid', note: ' — Not refunded' }, 'online + Not refunded -> kept as Paid');
  assertEqual(cancellationSmsKind(staffCancelPayment(online, undefined).paymentStatus), 'notRefunded', 'online + Not refunded: not-refunded SMS as before');

  assertEqual(staffCancelPayment(studio, 'Refunded'), { paymentStatus: 'Refunded', note: ' — Refunded' }, 'studio Paid + Refunded -> Refunded (unchanged)');
  assertEqual(cancellationSmsKind(staffCancelPayment(studio, 'Refunded').paymentStatus), 'refunded', 'studio + Refunded: refunded SMS as before');
  assertEqual(staffCancelPayment(studioNull, 'Refunded').paymentStatus, 'Refunded', 'studio (null payment id) + Refunded -> Refunded');
  assertEqual(staffCancelPayment(studioNull, undefined), { paymentStatus: 'Deposit Paid', note: ' — Not refunded' }, 'studio + Not refunded -> kept');
  assertEqual(staffCancelPayment({ paymentStatus: 'Unpaid' }, 'Refunded').paymentStatus, 'Refunded', 'no payment id at all -> as chosen');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);


