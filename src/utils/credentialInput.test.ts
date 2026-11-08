/**
 * Plain-assertion tests for sign-in credential handling. No test framework —
 * same style as captcha.test.ts:
 *
 *   npx tsx src/utils/credentialInput.test.ts
 *
 * The case from the field: an iPad capitalised the first letter of a staff
 * email ("Jxri.x95@gmail.com"). canonicalEmail() is what loginStaff(),
 * loginCustomer() and requestPasswordReset() send to Supabase Auth, so it must
 * fold case and surrounding spaces; CREDENTIAL_INPUT_PROPS stop the keyboard
 * changing the text in the first place (passwords are case-sensitive).
 */

import { canonicalEmail } from './validation';
import { CREDENTIAL_INPUT_PROPS } from './credentialInput';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('canonicalEmail() — what every sign-in sends');
assertEqual(canonicalEmail('Jxri.x95@gmail.com'), 'jxri.x95@gmail.com', 'iPad capital first letter is folded');
assertEqual(canonicalEmail('  jxri.x95@gmail.com  '), 'jxri.x95@gmail.com', 'surrounding spaces trimmed');
assertEqual(canonicalEmail('\tJXRI.X95@GMAIL.COM\n'), 'jxri.x95@gmail.com', 'all caps, tab and newline');
assertEqual(canonicalEmail('Jxri.x95@Gmail.Com '), canonicalEmail('jxri.x95@gmail.com'), 'every variant signs in as the same address');
assertEqual(canonicalEmail(undefined), '', 'missing -> empty');
assertEqual(canonicalEmail(null), '', 'null -> empty');
assertEqual(canonicalEmail('0501234567'), '0501234567', 'a phone number passes through (no @, routed as a phone)');

console.log('CREDENTIAL_INPUT_PROPS — the keyboard must not change credentials');
assertEqual(CREDENTIAL_INPUT_PROPS.autoCapitalize, 'none', 'no auto-capitalisation (iPadOS / iOS)');
assertEqual(CREDENTIAL_INPUT_PROPS.autoCorrect, 'off', 'no auto-correct');
assertEqual(CREDENTIAL_INPUT_PROPS.spellCheck, false, 'no spell-check');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
