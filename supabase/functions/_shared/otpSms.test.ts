/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for otpSms(). No test framework — same style as the
 * other logic tests:
 *
 *   npx tsx supabase/functions/_shared/otpSms.test.ts
 */

import { otpSms } from './otpSms.ts';

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

console.log('otpSms()');
const text = otpSms('482913');

assertEqual(
  text,
  'Your Arty verification code: 482913. Valid for 5 minutes.\n\nرمز التحقق الخاص بك: 482913. صالح لمدة 5 دقائق.',
  'exact registered template, code in both lines'
);
assertEqual(text.split('\n\n').length, 2, 'English and Arabic separated by one blank line');
assertEqual(text.split('482913').length - 1, 2, 'the code appears exactly twice');
assertEqual(text.includes('\r'), false, 'no carriage returns');

// The Arabic line, code point by code point, so a lookalike character (a
// different Arabic letter form, a stray RTL mark) cannot slip in unnoticed.
const arabic = otpSms('{code}').split('\n\n')[1];
assertEqual(
  [...arabic].map(ch => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join(' '),
  [...'رمز التحقق الخاص بك: {code}. صالح لمدة 5 دقائق.'].map(ch => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join(' '),
  'Arabic line code points match the registered text'
);
assertEqual(/[‎‏‪-‮⁦-⁩]/.test(arabic), false, 'no hidden direction marks');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
  (globalThis as any).process?.exit(1);
}
