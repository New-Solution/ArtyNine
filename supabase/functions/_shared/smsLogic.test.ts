/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for the pure SMS helpers in smsLogic.ts: phone
 * formatting and masking, the SMS_PROVIDER switch, and meertek response
 * parsing. No test framework — same style as send-sms/logic.test.ts:
 *
 *   npx tsx supabase/functions/_shared/smsLogic.test.ts
 */

import { maskPhone, parseMeertekResponse, pickSmsProvider, toSaudiInternational } from './smsLogic.ts';

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

console.log('toSaudiInternational()');
assertEqual(toSaudiInternational('0501234567'), '966501234567', 'local 05… -> 9665…');
assertEqual(toSaudiInternational('501234567'), '966501234567', 'bare national number -> 9665…');
assertEqual(toSaudiInternational('+966 50 123 4567'), '966501234567', '+966 with spaces -> 9665…');
assertEqual(toSaudiInternational('00966501234567'), '966501234567', '00966… -> 9665…');
assertEqual(toSaudiInternational('966501234567'), '966501234567', 'already 966… stays as is');
assertEqual(toSaudiInternational('+966 (0)50-123-4567'), '966501234567', 'stray (0) after the country code is dropped');
assertEqual(/^966\d+$/.test(toSaudiInternational('+966 50 123 4567')), true, 'no "+" and no leading 0 after 966');

console.log('maskPhone()');
assertEqual(maskPhone('966501234994'), '9665****994', 'keeps first 4 and last 3');
assertEqual(maskPhone('+966 50 123 4994'), '9665****994', 'masks after stripping non-digits');
assertEqual(maskPhone('12345'), '****', 'short value is masked entirely');
assertEqual(maskPhone(''), '****', 'empty value is masked entirely');

console.log('pickSmsProvider()');
assertEqual(pickSmsProvider(undefined), { provider: 'mshastra' }, 'unset -> mshastra (default)');
assertEqual(pickSmsProvider(''), { provider: 'mshastra' }, 'blank -> mshastra');
assertEqual(pickSmsProvider('mshastra'), { provider: 'mshastra' }, '"mshastra" -> mshastra');
assertEqual(pickSmsProvider('meertek'), { provider: 'meertek' }, '"meertek" -> meertek');
assertEqual(pickSmsProvider(' MeerTek '), { provider: 'meertek' }, 'case and surrounding spaces are ignored');
assertEqual(pickSmsProvider('twilio'), { provider: 'mshastra', unknown: 'twilio' }, 'unknown value -> mshastra, flagged');

console.log('parseMeertekResponse()');
assertEqual(parseMeertekResponse('4471923,966501234567,Sent'), { ok: true, id: '4471923', status: 'Sent' }, 'non-zero id -> sent');
assertEqual(parseMeertekResponse('4471923,966501234567,Sent\r\n'), { ok: true, id: '4471923', status: 'Sent' }, 'trailing newline is ignored');
assertEqual(
  parseMeertekResponse('0,966501234567,Message not match with template.'),
  { ok: false, id: '0', status: 'Message not match with template.' },
  'id 0 -> failed, template status kept'
);
assertEqual(
  parseMeertekResponse('0,966501234567,Invalid Mobile No.'),
  { ok: false, id: '0', status: 'Invalid Mobile No.' },
  'id 0 -> failed, invalid number status kept'
);
assertEqual(
  parseMeertekResponse('0,966501234567,Error, try again'),
  { ok: false, id: '0', status: 'Error, try again' },
  'a comma inside the status is kept'
);
assertEqual(parseMeertekResponse(''), { ok: false, id: '', status: '' }, 'empty body -> failed');
assertEqual(parseMeertekResponse('Unauthorized'), { ok: false, id: '', status: 'Unauthorized' }, 'body without the id,number,status shape -> failed, body as status');
assertEqual(parseMeertekResponse('<html>502 Bad Gateway</html>').ok, false, 'HTML error page -> failed, never sent');
assertEqual(parseMeertekResponse(',966501234567,Sent').ok, false, 'empty id -> failed');
assertEqual(parseMeertekResponse('0,966501234567,Invalid Mobile No.').status.includes('966501234567'), false, 'status never carries the phone number');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
  (globalThis as any).process?.exit(1);
}
