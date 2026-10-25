/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for send-sms-hook/logic.ts. No test framework — same
 * style as the other functions' logic tests:
 *
 *   npx tsx supabase/functions/send-sms-hook/logic.test.ts
 */

import {
  hookSecretKey, hmacSha256Base64, verifyHookSignature, parseHookPayload,
  saudiMobileForSms, hookErrorBody, TIMESTAMP_TOLERANCE_SECONDS
} from './logic.ts';

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

// A made-up secret in the dashboard's format: "v1,whsec_" + base64 key bytes.
const KEY_B64 = btoa('arty-test-hook-secret-0123456789');
const SECRET = `v1,whsec_${KEY_B64}`;
const OTHER_SECRET = `v1,whsec_${btoa('a-completely-different-secret!!')}`;
const NOW = 1_800_000_000;
const ID = 'msg_2abc';
const BODY = JSON.stringify({ user: { id: 'u1', phone: '966501234567' }, sms: { otp: '123456' } });

async function sign(secret: string, id: string, ts: string, body: string): Promise<string> {
  return `v1,${await hmacSha256Base64(hookSecretKey(secret)!, `${id}.${ts}.${body}`)}`;
}

async function main() {
  console.log('hookSecretKey()');
  assertEqual(hookSecretKey(SECRET)?.length, 32, 'v1,whsec_ prefix stripped, key decoded');
  assertEqual(hookSecretKey(`whsec_${KEY_B64}`)?.length, 32, 'bare whsec_ prefix accepted');
  assertEqual(hookSecretKey(''), null, 'empty secret -> null');
  assertEqual(hookSecretKey('v1,whsec_%%%not-base64%%%'), null, 'malformed base64 -> null');

  console.log('hmacSha256Base64() — known vector');
  // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
  assertEqual(
    await hmacSha256Base64(new TextEncoder().encode('Jefe'), 'what do ya want for nothing?'),
    'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=',
    'matches the RFC 4231 HMAC-SHA256 vector'
  );

  console.log('verifyHookSignature()');
  const ts = String(NOW);
  const good = await sign(SECRET, ID, ts, BODY);
  const base = { secret: SECRET, id: ID, timestamp: ts, signatureHeader: good, body: BODY, nowSeconds: NOW };

  assertEqual(await verifyHookSignature(base), true, 'valid signature -> accepted');
  assertEqual(await verifyHookSignature({ ...base, body: BODY.replace('123456', '654321') }), false, 'tampered body -> rejected');
  assertEqual(await verifyHookSignature({ ...base, id: 'msg_other' }), false, 'different webhook-id -> rejected');
  assertEqual(await verifyHookSignature({ ...base, secret: OTHER_SECRET }), false, 'wrong secret -> rejected');
  assertEqual(await verifyHookSignature({ ...base, signatureHeader: `v1,${'A'.repeat(44)}` }), false, 'wrong signature value -> rejected');
  assertEqual(await verifyHookSignature({ ...base, signatureHeader: good.replace('v1,', 'v2,') }), false, 'non-v1 signature -> rejected');
  assertEqual(await verifyHookSignature({ ...base, signatureHeader: `v1,bogus ${good}` }), true, 'several signatures, one valid -> accepted');
  assertEqual(await verifyHookSignature({ ...base, signatureHeader: null }), false, 'missing signature header -> rejected');
  assertEqual(await verifyHookSignature({ ...base, id: null }), false, 'missing webhook-id -> rejected');
  assertEqual(await verifyHookSignature({ ...base, timestamp: null }), false, 'missing timestamp -> rejected');
  assertEqual(await verifyHookSignature({ ...base, secret: '' }), false, 'missing secret -> rejected');

  const oldTs = String(NOW - TIMESTAMP_TOLERANCE_SECONDS - 1);
  assertEqual(
    await verifyHookSignature({ ...base, timestamp: oldTs, signatureHeader: await sign(SECRET, ID, oldTs, BODY) }),
    false,
    'correctly signed but older than 5 minutes -> rejected'
  );
  const futureTs = String(NOW + TIMESTAMP_TOLERANCE_SECONDS + 1);
  assertEqual(
    await verifyHookSignature({ ...base, timestamp: futureTs, signatureHeader: await sign(SECRET, ID, futureTs, BODY) }),
    false,
    'correctly signed but more than 5 minutes ahead -> rejected'
  );
  const edgeTs = String(NOW - TIMESTAMP_TOLERANCE_SECONDS);
  assertEqual(
    await verifyHookSignature({ ...base, timestamp: edgeTs, signatureHeader: await sign(SECRET, ID, edgeTs, BODY) }),
    true,
    'exactly 5 minutes old -> accepted'
  );
  assertEqual(await verifyHookSignature({ ...base, timestamp: '17e8' }), false, 'non-numeric timestamp -> rejected');

  // The Standard Webhooks / Svix documentation example, verified independently.
  assertEqual(
    await verifyHookSignature({
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: '1614265330',
      signatureHeader: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
      body: '{"test": 2432232314}',
      nowSeconds: 1614265330
    }),
    true,
    'published Standard Webhooks example vector -> accepted'
  );

  console.log('parseHookPayload()');
  assertEqual(parseHookPayload(JSON.parse(BODY)), { phone: '966501234567', otp: '123456' }, 'phone + 6-digit code');
  assertEqual(parseHookPayload({ user: { phone: '966501234567' }, sms: { otp: '12345' } }), null, '5-digit code -> null');
  assertEqual(parseHookPayload({ user: { phone: '966501234567' }, sms: { otp: '12a456' } }), null, 'non-digit code -> null');
  assertEqual(parseHookPayload({ user: { phone: '966501234567' }, sms: { otp: 123456 } }), null, 'numeric (not string) code -> null');
  assertEqual(parseHookPayload({ user: {}, sms: { otp: '123456' } }), null, 'missing phone -> null');
  assertEqual(parseHookPayload(null), null, 'null payload -> null');

  console.log('saudiMobileForSms()');
  assertEqual(saudiMobileForSms('966501234567'), '966501234567', 'Supabase format (no +) -> 9665…');
  assertEqual(saudiMobileForSms('+966501234567'), '966501234567', 'E.164 -> 9665…');
  assertEqual(saudiMobileForSms('0501234567'), '966501234567', 'local 05… -> 9665…');
  assertEqual(saudiMobileForSms('966112345678'), null, 'Saudi landline -> refused');
  assertEqual(saudiMobileForSms('+447700900123'), null, 'foreign number -> refused');
  assertEqual(saudiMobileForSms('96650123456'), null, 'one digit short -> refused');

  console.log('hookErrorBody()');
  assertEqual(hookErrorBody(401, 'nope'), { error: { http_code: 401, message: 'nope' } }, 'Supabase hook error shape');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    // deno-lint-ignore no-process-exit -- also valid under plain Node/tsx.
    (globalThis as any).process?.exit(1);
  }
}

main();
