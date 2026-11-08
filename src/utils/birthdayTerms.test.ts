/**
 * Plain-assertion tests for the birthday-terms helpers in types.ts:
 *
 *   npx tsx src/utils/birthdayTerms.test.ts
 *
 * The cancellation rule is fixed at 24 hours (cancel_own_booking, 0048). Terms
 * saved while the "Cancellation window (days)" setting existed still carry a
 * {cancellationDays} token; these pin how that wording is rewritten.
 */

import {
  REFUND_NOTICE_HOURS,
  DEFAULT_BIRTHDAY_TERMS,
  fixCancellationTermsLine,
  fixCancellationTerms,
  renderTermsLine
} from '../types';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const eq = (name: string, got: string, want: string) => check(name, got === want, `got "${got}", want "${want}"`);

check('the rule is 24 hours', REFUND_NOTICE_HOURS === 24);

// --- English legacy wording ------------------------------------------------------
eq('seeded 0001 line',
  fixCancellationTermsLine('Changes or cancellations must be made at least {cancellationDays} days before the scheduled event to receive a refund of the deposit.'),
  'Changes or cancellations must be made more than 24 hours before the scheduled event to receive a refund of the deposit.');
eq('no "at least"', fixCancellationTermsLine('Cancel {cancellationDays} days ahead.'), 'Cancel more than 24 hours ahead.');
eq('singular day', fixCancellationTermsLine('At least {cancellationDays} day before.'), 'more than 24 hours before.');
eq('bare token', fixCancellationTermsLine('Window: {cancellationDays}'), 'Window: 24');

// --- Arabic legacy wording -------------------------------------------------------
eq('Arabic "N أيام على الأقل"',
  fixCancellationTermsLine('يجب الإلغاء قبل {cancellationDays} أيام على الأقل من موعد الفعالية لاسترداد العربون.'),
  'يجب الإلغاء قبل أكثر من 24 ساعة من موعد الفعالية لاسترداد العربون.');
eq('Arabic "على الأقل N أيام"',
  fixCancellationTermsLine('قبل على الأقل {cancellationDays} أيام'), 'قبل أكثر من 24 ساعة');
eq('Arabic "N يومًا"', fixCancellationTermsLine('قبل {cancellationDays} يومًا'), 'قبل أكثر من 24 ساعة');

// --- Untouched lines -------------------------------------------------------------
eq('line without the token is unchanged', fixCancellationTermsLine('Outside food is not allowed.'), 'Outside food is not allowed.');

// --- renderTermsLine -------------------------------------------------------------
eq('deposit filled in', renderTermsLine('A deposit of {deposit} SAR is required.', { deposit: 500 }), 'A deposit of 500 SAR is required.');
eq('render also fixes the legacy rule',
  renderTermsLine('Pay {deposit} SAR; cancel at least {cancellationDays} days before.', { deposit: 300 }),
  'Pay 300 SAR; cancel more than 24 hours before.');

// --- defaults and whole documents -----------------------------------------------
check('default terms no longer use the token',
  !JSON.stringify(DEFAULT_BIRTHDAY_TERMS).includes('{cancellationDays}'));
check('default terms state the 24-hour rule',
  DEFAULT_BIRTHDAY_TERMS.trailingItems.some(l => l.includes('more than 24 hours')));
{
  const fixed = fixCancellationTerms({
    version: 'v1',
    title: 'T',
    leadingItems: ['a {cancellationDays} days'],
    suppliesIntro: 'b',
    supplies: [],
    trailingItems: ['at least {cancellationDays} days before'],
    trailingItemsAr: ['قبل {cancellationDays} أيام على الأقل']
  });
  check('document: leading fixed', fixed.leadingItems[0] === 'a more than 24 hours', fixed.leadingItems[0]);
  check('document: trailing fixed', fixed.trailingItems[0] === 'more than 24 hours before', fixed.trailingItems[0]);
  check('document: Arabic trailing fixed', fixed.trailingItemsAr?.[0] === 'قبل أكثر من 24 ساعة', fixed.trailingItemsAr?.[0]);
  check('document: version kept', fixed.version === 'v1');
  check('document: absent Arabic stays absent', fixed.leadingItemsAr === undefined && fixed.suppliesAr === undefined);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
