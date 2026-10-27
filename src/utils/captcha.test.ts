/**
 * Plain-assertion tests for captcha.ts. No test framework — same style as
 * phoneAuth.test.ts:
 *
 *   npx tsx src/utils/captcha.test.ts
 */

import { CAPTCHA_ENABLED, TokenSlot, isCaptchaError } from './captcha';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run() {
  console.log('CAPTCHA_ENABLED');
  assertEqual(CAPTCHA_ENABLED, false, 'off when VITE_TURNSTILE_SITE_KEY is not set');

  console.log('TokenSlot');
  {
    const slot = new TokenSlot();
    let resets = 0;
    slot.onTaken = () => { resets++; };
    slot.put('t1');
    assertEqual(slot.hasToken, true, 'holds a token the widget produced');
    assertEqual(await slot.take(50), 't1', 'take() hands out the held token');
    assertEqual(slot.hasToken, false, 'a token is handed out only once');
    assertEqual(resets, 1, 'handing out a token resets the widget for the next one');
  }
  {
    const slot = new TokenSlot();
    let resets = 0;
    slot.onTaken = () => { resets++; };
    const pending = slot.take(500);
    slot.put('t2');
    assertEqual(await pending, 't2', 'take() waits for the next token');
    assertEqual(slot.hasToken, false, 'a token given to a waiting call is not kept');
    assertEqual(resets, 1, 'and the widget is reset after it');
  }
  {
    const slot = new TokenSlot();
    let timeouts = 0;
    slot.onTimeout = () => { timeouts++; };
    assertEqual(await slot.take(20), undefined, 'no token in time -> undefined');
    assertEqual(timeouts, 1, 'and the widget is told so');
    slot.put('late');
    assertEqual(slot.hasToken, true, 'a token after a timeout is kept for the next call, not given to the expired one');
  }
  {
    const slot = new TokenSlot();
    slot.put('old');
    slot.clear();
    assertEqual(await slot.take(20), undefined, 'an expired token is never handed out');
  }

  console.log('isCaptchaError()');
  assertEqual(isCaptchaError({ code: 'captcha_failed', message: 'x' }), true, 'Supabase error code');
  assertEqual(isCaptchaError({ message: 'captcha protection: request disallowed (no captcha response)' }), true, 'Supabase message');
  assertEqual(isCaptchaError({ message: 'Invalid login credentials' }), false, 'wrong password is not a captcha error');
  assertEqual(isCaptchaError(null), false, 'no error');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
