/**
 * Plain-assertion tests for phoneAuth.ts, using a stand-in Supabase client
 * that records what it was asked. No test framework — same style as the Edge
 * Function logic tests:
 *
 *   npx tsx src/utils/phoneAuth.test.ts
 */

import { toE164Saudi, maskE164Saudi, requestPhoneCode, verifyPhoneCode, setPassword, type PhoneAuthClient } from './phoneAuth';

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

type Call = { method: string; args: unknown[] };
type Err = { message: string; status?: number } | null;

/** A stand-in client: each method returns what the test configured, and every call is recorded. */
function fakeClient(opts: {
  otpError?: Err;
  verify?: { session: unknown; error?: Err };
  link?: { data: unknown; error?: Err };
  updateError?: Err;
}) {
  const calls: Call[] = [];
  const client = {
    auth: {
      signInWithOtp: async (...args: unknown[]) => { calls.push({ method: 'signInWithOtp', args }); return { data: {}, error: opts.otpError ?? null }; },
      verifyOtp: async (...args: unknown[]) => {
        calls.push({ method: 'verifyOtp', args });
        return { data: { session: opts.verify?.session ?? null, user: null }, error: opts.verify?.error ?? null };
      },
      updateUser: async (...args: unknown[]) => { calls.push({ method: 'updateUser', args }); return { data: {}, error: opts.updateError ?? null }; }
    },
    rpc: async (...args: unknown[]) => { calls.push({ method: 'rpc', args }); return { data: opts.link?.data ?? null, error: opts.link?.error ?? null }; }
  };
  return { client: client as unknown as PhoneAuthClient, calls };
}

async function main() {
  console.log('toE164Saudi()');
  assertEqual(toE164Saudi('0501234567'), '+966501234567', 'local 05…');
  assertEqual(toE164Saudi('501234567'), '+966501234567', 'bare national number');
  assertEqual(toE164Saudi('966501234567'), '+966501234567', 'Supabase storage form (no +)');
  assertEqual(toE164Saudi('+966 50 123 4567'), '+966501234567', 'E.164 with spaces');
  assertEqual(toE164Saudi('00966501234567'), '+966501234567', '00966…');
  assertEqual(toE164Saudi('050-123-4567'), '+966501234567', 'dashes');
  assertEqual(toE164Saudi('٠٥٠١٢٣٤٥٦٧'), '+966501234567', 'Arabic-Indic digits');
  assertEqual(toE164Saudi('0112345678'), null, 'Saudi landline -> null');
  assertEqual(toE164Saudi('+447700900123'), null, 'foreign number -> null');
  assertEqual(toE164Saudi('05012345'), null, 'too short -> null');
  assertEqual(toE164Saudi(''), null, 'empty -> null');
  assertEqual(toE164Saudi(null), null, 'null -> null');

  console.log('maskE164Saudi()');
  assertEqual(maskE164Saudi('0501234594'), '+966 5•• ••• •94', 'first digit and last two shown');
  assertEqual(maskE164Saudi('+966 55 000 0012'), '+966 5•• ••• •12', 'any input form');
  assertEqual(maskE164Saudi('12345'), '', 'invalid number -> empty');

  console.log('requestPhoneCode()');
  {
    const { client, calls } = fakeClient({});
    assertEqual(await requestPhoneCode(client, '0501234567'), { ok: true, phone: '+966501234567' }, 'sends a code');
    assertEqual(calls, [{ method: 'signInWithOtp', args: [{ phone: '+966501234567', options: { shouldCreateUser: true } }] }],
      'E.164 phone, shouldCreateUser on (no enumeration)');
  }
  {
    const { client, calls } = fakeClient({});
    assertEqual(await requestPhoneCode(client, '12345'), { ok: false, reason: 'invalid_phone' }, 'invalid phone refused');
    assertEqual(calls.length, 0, 'invalid phone never reaches Supabase');
  }
  {
    const { client } = fakeClient({ otpError: { message: 'rate limit', status: 429 } });
    assertEqual(await requestPhoneCode(client, '0501234567'), { ok: false, reason: 'rate_limited' }, '429 -> rate_limited');
  }
  {
    const { client } = fakeClient({ otpError: { message: 'hook failed', status: 500 } });
    assertEqual(await requestPhoneCode(client, '0501234567'), { ok: false, reason: 'send_failed' }, 'other error -> send_failed');
  }

  console.log('verifyPhoneCode()');
  {
    const { client, calls } = fakeClient({ verify: { session: {} }, link: { data: { status: 'linked', customer_id: 'CUST-1' } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456', ' Noura '), { ok: true, status: 'linked', customerId: 'CUST-1' }, 'verified and linked');
    assertEqual(calls, [
      { method: 'verifyOtp', args: [{ phone: '+966501234567', token: '123456', type: 'sms' }] },
      { method: 'rpc', args: ['link_customer_by_verified_phone', { p_name: 'Noura' }] }
    ], 'verifyOtp(type sms), then the link RPC with only a name — no phone or ids');
  }
  {
    const { client } = fakeClient({ verify: { session: {} }, link: { data: { status: 'phone_in_use' } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456'), { ok: true, status: 'phone_in_use' }, 'phone_in_use passed through, no id');
  }
  {
    const { client, calls } = fakeClient({ verify: { session: {} }, link: { data: { status: 'created', customer_id: 'CUST-2' } } });
    await verifyPhoneCode(client, '0501234567', '١٢٣ ٤٥٦');
    assertEqual((calls[0].args[0] as { token: string }).token, '123456', 'Arabic-Indic code with a space normalised');
    assertEqual(calls[1].args[1], { p_name: null }, 'no name -> p_name null');
  }
  {
    const { client, calls } = fakeClient({});
    assertEqual(await verifyPhoneCode(client, '0501234567', '12345'), { ok: false, reason: 'invalid_code' }, '5-digit code refused');
    assertEqual(calls.length, 0, 'bad code format never reaches Supabase');
  }
  {
    const { client, calls } = fakeClient({ verify: { session: null, error: { message: 'Token has expired or is invalid', status: 403 } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456'), { ok: false, reason: 'invalid_code' }, 'wrong/expired code -> invalid_code');
    assertEqual(calls.map(c => c.method), ['verifyOtp'], 'no link attempt without a session');
  }
  {
    const { client } = fakeClient({ verify: { session: {} }, link: { data: null, error: { message: 'boom' } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456'), { ok: false, reason: 'link_failed' }, 'RPC error -> link_failed');
  }
  {
    const { client } = fakeClient({ verify: { session: {} }, link: { data: { status: 'something_else' } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456'), { ok: false, reason: 'link_failed' }, 'unknown status -> link_failed');
  }

  console.log('setPassword()');
  {
    const { client, calls } = fakeClient({});
    assertEqual(await setPassword(client, 'Str0ng!pass', ' Noura '), { ok: true }, 'password + name saved');
    assertEqual(calls, [{ method: 'updateUser', args: [{ password: 'Str0ng!pass', data: { name: 'Noura' } }] }], 'name trimmed into user metadata');
  }
  {
    const { client, calls } = fakeClient({});
    await setPassword(client, 'Str0ng!pass');
    assertEqual(calls[0].args[0], { password: 'Str0ng!pass' }, 'no name -> password only');
  }
  {
    const { client, calls } = fakeClient({});
    assertEqual(await setPassword(client, ''), { ok: false, reason: 'weak_password' }, 'empty password refused');
    assertEqual(calls.length, 0, 'empty password never reaches Supabase');
  }
  {
    const { client } = fakeClient({ updateError: { message: 'Password should be at least 6 characters', status: 422 } });
    assertEqual(await setPassword(client, 'abc'), { ok: false, reason: 'weak_password' }, '422 -> weak_password');
  }
  {
    const { client } = fakeClient({ updateError: { message: 'network', status: 500 } });
    assertEqual(await setPassword(client, 'Str0ng!pass'), { ok: false, reason: 'update_failed' }, 'other error -> update_failed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    (globalThis as any).process?.exit(1);
  }
}

main();
