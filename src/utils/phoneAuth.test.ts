/**
 * Plain-assertion tests for phoneAuth.ts, using a stand-in Supabase client
 * that records what it was asked. No test framework — same style as the Edge
 * Function logic tests:
 *
 *   npx tsx src/utils/phoneAuth.test.ts
 */

import {
  toE164Saudi, maskE164Saudi, requestPhoneCode, verifyPhoneCode, setPassword,
  isPhoneSetupPending, needsCustomerName, completePhoneSetup, type PhoneAuthClient
} from './phoneAuth';

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
  /** Per-call updateUser errors, in order; falls back to updateError. */
  updateErrors?: Err[];
}) {
  let updateCall = 0;
  const calls: Call[] = [];
  const client = {
    auth: {
      signInWithOtp: async (...args: unknown[]) => { calls.push({ method: 'signInWithOtp', args }); return { data: {}, error: opts.otpError ?? null }; },
      verifyOtp: async (...args: unknown[]) => {
        calls.push({ method: 'verifyOtp', args });
        return { data: { session: opts.verify?.session ?? null, user: null }, error: opts.verify?.error ?? null };
      },
      updateUser: async (...args: unknown[]) => {
        calls.push({ method: 'updateUser', args });
        const error = opts.updateErrors ? opts.updateErrors[updateCall] ?? null : opts.updateError ?? null;
        updateCall++;
        return { data: {}, error };
      }
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
  {
    const { client, calls } = fakeClient({});
    await requestPhoneCode(client, '0501234567', async () => 'cf-token');
    assertEqual(calls[0].args[0], { phone: '+966501234567', options: { shouldCreateUser: true, captchaToken: 'cf-token' } }, 'captcha token sent with the code request');
  }
  {
    const { client, calls } = fakeClient({});
    await requestPhoneCode(client, '0501234567', async () => undefined);
    assertEqual(calls[0].args[0], { phone: '+966501234567', options: { shouldCreateUser: true } }, 'no token (CAPTCHA off) -> request unchanged');
  }
  {
    const { client } = fakeClient({ otpError: { message: 'captcha protection: request disallowed (no captcha response)', status: 400 } });
    assertEqual(await requestPhoneCode(client, '0501234567'), { ok: false, reason: 'captcha_failed' }, 'captcha refusal -> captcha_failed');
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
  {
    const { client, calls } = fakeClient({ verify: { session: {} }, link: { data: { status: 'linked', customer_id: 'CUST-1' } } });
    await verifyPhoneCode(client, '0501234567', '123456', undefined, async () => 'cf-token');
    assertEqual(calls[0].args[0], { phone: '+966501234567', token: '123456', type: 'sms', options: { captchaToken: 'cf-token' } }, 'captcha token sent with verify');
  }
  {
    let asked = 0;
    const { client } = fakeClient({});
    await verifyPhoneCode(client, '0501234567', '12345', undefined, async () => { asked++; return 'cf-token'; });
    assertEqual(asked, 0, 'bad code format does not use up a captcha token');
  }
  {
    const { client } = fakeClient({ verify: { session: null, error: { message: 'captcha protection: request disallowed', status: 400 } } });
    assertEqual(await verifyPhoneCode(client, '0501234567', '123456'), { ok: false, reason: 'captcha_failed' }, 'captcha refusal on verify -> captcha_failed');
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

  console.log('isPhoneSetupPending()');
  assertEqual(isPhoneSetupPending({ phone_confirmed_at: '2026-10-27T10:00:00Z', user_metadata: {} }), true, 'confirmed phone, no flag -> pending');
  assertEqual(isPhoneSetupPending({ phone_confirmed_at: '2026-10-27T10:00:00Z', user_metadata: { phone_setup_complete: true } }), false, 'flag true -> done');
  assertEqual(isPhoneSetupPending({ phone_confirmed_at: '2026-10-27T10:00:00Z', user_metadata: { phone_setup_complete: 'true' } }), true, 'only boolean true counts');
  assertEqual(isPhoneSetupPending({ phone_confirmed_at: '2026-10-27T10:00:00Z', user_metadata: null }), true, 'no metadata -> pending');
  assertEqual(isPhoneSetupPending({ phone_confirmed_at: null, user_metadata: {} }), false, 'email account (no confirmed phone) -> never pending');
  assertEqual(isPhoneSetupPending(null), false, 'signed out -> not pending');

  console.log('needsCustomerName()');
  assertEqual(needsCustomerName('Guest'), true, '"Guest" placeholder');
  assertEqual(needsCustomerName(' guest '), true, 'case and spaces ignored');
  assertEqual(needsCustomerName(''), true, 'empty');
  assertEqual(needsCustomerName(null), true, 'null');
  assertEqual(needsCustomerName('Noura Al-Amri'), false, 'a real name');

  console.log('completePhoneSetup()');
  {
    const { client, calls } = fakeClient({ link: { data: 'CUST-9' } });
    const res = await completePhoneSetup(client, { password: 'Str0ng!pass', phone: '966501234567', authId: 'uid-1', name: ' Noura ', email: 'noura@example.com' });
    assertEqual(res, { ok: true }, 'new account: password, name, complete');
    assertEqual(calls, [
      { method: 'updateUser', args: [{ password: 'Str0ng!pass' }] },
      { method: 'rpc', args: ['resolve_customer_record', { p_name: 'Noura', p_phone: '+966501234567', p_email: 'noura@example.com', p_auth_id: 'uid-1', p_source: null }] },
      { method: 'updateUser', args: [{ data: { name: 'Noura', phone_setup_complete: true } }] }
    ], 'password first, then the owner update (phone + name), completion last');
  }
  {
    const { client, calls } = fakeClient({});
    assertEqual(await completePhoneSetup(client, { password: 'Str0ng!pass', phone: '966501234567', authId: 'uid-1' }), { ok: true }, 'walk-in claim: password only');
    assertEqual(calls, [
      { method: 'updateUser', args: [{ password: 'Str0ng!pass' }] },
      { method: 'updateUser', args: [{ data: { phone_setup_complete: true } }] }
    ], 'no name -> no RPC, studio name untouched');
  }
  {
    const { client, calls } = fakeClient({ link: { data: 'CUST-9' } });
    await completePhoneSetup(client, { password: 'Str0ng!pass', phone: '966501234567', authId: 'uid-1', name: 'Noura', email: '  ' });
    assertEqual((calls[1].args[1] as { p_email: unknown }).p_email, null, 'blank email -> p_email null');
  }
  {
    const { client, calls } = fakeClient({ updateError: { message: 'weak', status: 422 } });
    assertEqual(await completePhoneSetup(client, { password: 'abc', phone: '966501234567', authId: 'uid-1', name: 'Noura' }), { ok: false, reason: 'weak_password' }, 'password refused -> weak_password');
    assertEqual(calls.map(c => c.method), ['updateUser'], 'nothing else attempted, not marked complete');
  }
  {
    const { client, calls } = fakeClient({ link: { data: null, error: { message: 'boom' } } });
    assertEqual(await completePhoneSetup(client, { password: 'Str0ng!pass', phone: '966501234567', authId: 'uid-1', name: 'Noura' }), { ok: false, reason: 'profile_failed' }, 'name save fails -> profile_failed');
    assertEqual(calls.map(c => c.method), ['updateUser', 'rpc'], 'not marked complete when the name was not saved');
  }
  {
    const { client } = fakeClient({ link: { data: 'CUST-9' }, updateErrors: [null, { message: 'network', status: 500 }] });
    assertEqual(await completePhoneSetup(client, { password: 'Str0ng!pass', phone: '966501234567', authId: 'uid-1', name: 'Noura' }), { ok: false, reason: 'update_failed' }, 'completion write fails -> update_failed (stays pending)');
  }
  {
    const { client, calls } = fakeClient({});
    assertEqual(await completePhoneSetup(client, { password: '', phone: '966501234567', authId: 'uid-1' }), { ok: false, reason: 'weak_password' }, 'empty password refused');
    assertEqual(calls.length, 0, 'empty password never reaches Supabase');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    (globalThis as any).process?.exit(1);
  }
}

main();
