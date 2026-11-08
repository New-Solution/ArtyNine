/**
 * Plain-assertion tests for bookingPaymentNote (onlinePayments.ts):
 *
 *   npx tsx src/utils/bookingPaymentNote.test.ts
 */

import { bookingPaymentNote, normalizeOnlinePayments } from './onlinePayments';

let passed = 0;
let failed = 0;
function check(name: string, got: string, want: string) {
  if (got === want) passed++; else { failed++; console.error(`FAIL: ${name} — got "${got}", want "${want}"`); }
}

const off = normalizeOnlinePayments({ enabled: false });
const on = normalizeOnlinePayments({ enabled: true, workshop: { mode: 'deposit', depositAmount: 100 }, birthday: { mode: 'full' } });
const fullWs = normalizeOnlinePayments({ enabled: true, workshop: { mode: 'full' } });

const STUDIO = 'Pay at the studio — free cancellation, nothing charged.';
check('payments off', bookingPaymentNote({ available: true, config: off, kind: 'workshop', total: 300 }).en, STUDIO);
check('no payment step in this build', bookingPaymentNote({ available: false, config: on, kind: 'workshop', total: 300 }).en, STUDIO);
check('payments off, Arabic', bookingPaymentNote({ available: true, config: off, kind: 'workshop' }).ar,
  'الدفع في الاستوديو — إلغاء مجاني، دون خصم أي مبلغ.');

check('deposit', bookingPaymentNote({ available: true, config: on, kind: 'workshop', total: 300 }).en,
  'A non-refundable deposit of 100 SAR is paid online when you book.');
check('deposit capped at the price', bookingPaymentNote({ available: true, config: on, kind: 'workshop', total: 60 }).en,
  'A non-refundable deposit of 60 SAR is paid online when you book.');
check('deposit, no total yet', bookingPaymentNote({ available: true, config: on, kind: 'workshop' }).en,
  'A non-refundable deposit of 100 SAR is paid online when you book.');
check('deposit, Arabic', bookingPaymentNote({ available: true, config: on, kind: 'workshop', total: 300 }).ar,
  'يُدفع عربون غير قابل للاسترداد بقيمة 100 ريال إلكترونيًا عند الحجز.');

check('full (workshop)', bookingPaymentNote({ available: true, config: fullWs, kind: 'workshop', total: 300 }).en,
  'Cancel more than 24 hours before for a full refund.');
check('full (birthday default)', bookingPaymentNote({ available: true, config: on, kind: 'birthday', total: 900 }).en,
  'Cancel more than 24 hours before for a full refund.');
check('full, Arabic', bookingPaymentNote({ available: true, config: fullWs, kind: 'workshop' }).ar,
  'ألغِ قبل أكثر من 24 ساعة لاسترداد المبلغ كاملًا.');

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
