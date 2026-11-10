/**
 * Plain-assertion tests for staffSessionBlock.ts. No test framework:
 *
 *   npx tsx src/utils/staffSessionBlock.test.ts
 */

import { staffSessionBookingError, staffSessionBlockReason } from './staffSessionBlock';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`, detail ?? '');
  }
}

check('staff-console round-trips', staffSessionBlockReason(staffSessionBookingError('staff-console')) === 'staff-console');
check('staff-account round-trips', staffSessionBlockReason(staffSessionBookingError('staff-account')) === 'staff-account');
check('other errors are not a block', staffSessionBlockReason(new Error('Only 1 seat(s) left')) === null);
check('message merely mentioning it is not a block', staffSessionBlockReason(new Error('x staff-session-active:staff-console')) === null);
check('null is not a block', staffSessionBlockReason(null) === null);
check('undefined is not a block', staffSessionBlockReason(undefined) === null);
check('string thrown is not a block', staffSessionBlockReason('staff-session-active:staff-console') === null);
check('unknown reason falls back to staff-console',
  staffSessionBlockReason(new Error('staff-session-active:something')) === 'staff-console');

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
