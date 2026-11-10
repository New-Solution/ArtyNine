/**
 * Plain-assertion tests for saveErrors.ts. No test framework — same style as
 * captcha.test.ts:
 *
 *   npx tsx src/utils/saveErrors.test.ts
 */

import { isPermissionError, saveErrorText } from './saveErrors';

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

// --- isPermissionError ----------------------------------------------------------
check('RLS insert refusal', isPermissionError(new Error('Write failed on app_settings: new row violates row-level security policy for table "app_settings"')));
check('permission denied', isPermissionError(new Error('permission denied for table staff')));
check('staff trigger', isPermissionError(new Error('Only a Super Admin can change permissions')));
check('error code', isPermissionError({ message: 'failed (42501)' }));
check('plain string', isPermissionError('new row violates row-level security policy'));
check('network failure is not permission', !isPermissionError(new Error('Failed to fetch')));
check('null is not permission', !isPermissionError(null));
check('undefined is not permission', !isPermissionError(undefined));

// --- saveErrorText ------------------------------------------------------------
{
  const what = { en: 'the booking pop-up', ar: 'النافذة المنبثقة للحجز' };
  const perm = saveErrorText(new Error('new row violates row-level security policy'), what);
  check('permission EN names the thing', perm.en.includes('the booking pop-up') && perm.en.includes('permission'), perm.en);
  check('permission AR names the thing', perm.ar.includes('النافذة المنبثقة للحجز') && perm.ar.includes('صلاحية'), perm.ar);
  check('permission text has no raw server message', !perm.en.includes('row-level'), perm.en);

  const net = saveErrorText(new Error('Failed to fetch'), what);
  check('failure EN', net.en.startsWith('Could not save the booking pop-up.'), net.en);
  check('failure EN keeps detail', net.en.includes('(Failed to fetch)'), net.en);
  check('failure AR', net.ar.startsWith('تعذّر حفظ النافذة المنبثقة للحجز.'), net.ar);

  const bare = saveErrorText(null);
  check('no detail, no parentheses', bare.en === 'Could not save. Please try again.', bare.en);
  check('no "what" in Arabic falls back', bare.ar.includes('التغييرات'), bare.ar);
  const barePerm = saveErrorText('permission denied');
  check('no "what" permission EN', barePerm.en.includes('change this'), barePerm.en);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
