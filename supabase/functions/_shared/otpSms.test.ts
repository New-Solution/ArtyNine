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
  'Your Arty verification code: 482913. Valid for 5 minutes.\nرمز التحقق الخاص بك: 482913. صالح لمدة 5 دقائق.',
  'exact registered template, code in both lines'
);
assertEqual(text.split('\n').length, 2, 'English and Arabic separated by exactly one line break');
assertEqual(text.includes('\n\n'), false, 'no blank line between them');
assertEqual(text.split('482913').length - 1, 2, 'the code appears exactly twice');
assertEqual(text.includes('\r'), false, 'no carriage returns');

// The Arabic line, code point by code point, so a lookalike character (a
// different Arabic letter form, a stray RTL mark) cannot slip in unnoticed.
const arabic = otpSms('{code}').split('\n')[1];
assertEqual(
  [...arabic].map(ch => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join(' '),
  [...'رمز التحقق الخاص بك: {code}. صالح لمدة 5 دقائق.'].map(ch => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join(' '),
  'Arabic line code points match the registered text'
);
assertEqual(/[‎‏‪-‮⁦-⁩]/.test(arabic), false, 'no hidden direction marks');

// The whole message, byte for byte (UTF-8): English + one 0x0A + Arabic.
const bytes = [...new TextEncoder().encode(otpSms('{code}'))];
const english = [...new TextEncoder().encode('Your Arty verification code: {code}. Valid for 5 minutes.')];
assertEqual(bytes[english.length], 0x0a, 'a single LF byte follows the English line');
assertEqual(bytes[english.length + 1] !== 0x0a, true, 'and is not followed by a second LF');
assertEqual(bytes.length, english.length + 1 + new TextEncoder().encode('رمز التحقق الخاص بك: {code}. صالح لمدة 5 دقائق.').length, 'total byte length = English + 1 + Arabic');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
  (globalThis as any).process?.exit(1);
}
