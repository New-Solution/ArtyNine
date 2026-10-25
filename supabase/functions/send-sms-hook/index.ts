/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * send-sms-hook — the Supabase Auth "Send SMS" hook.
 *
 * Supabase Auth owns phone OTPs: it generates the code, enforces expiry,
 * verification and rate limits, and calls this function only to DELIVER the
 * code. This function sends it through the shared sendSms() (_shared/sms.ts),
 * so the SMS_PROVIDER switch applies, using the one registered OTP template
 * (_shared/otpSms.ts).
 *
 * AUTHORIZATION
 * Supabase Auth calls this server-to-server with no user JWT, so the function
 * is deployed with JWT verification OFF (supabase/config.toml,
 * [functions.send-sms-hook] verify_jwt = false). What authenticates the
 * request instead is its Standard Webhooks signature, checked against
 * SEND_SMS_HOOK_SECRET (the "v1,whsec_…" value generated in the dashboard).
 * Anything unsigned, mis-signed or stale is refused before the body is read.
 *
 * WHAT IT REFUSES
 * - Missing secret, bad/missing signature, stale timestamp -> 401
 * - Unparseable body, missing phone, code that is not 6 digits -> 400
 * - Anything but a Saudi mobile number -> 400 (also blocks SMS toll fraud)
 *
 * LOGGING
 * Only the masked phone (9665****994) and the outcome. Never the code, the
 * message, the body, the headers or the secret.
 */

import { sendSms } from '../_shared/sms.ts';
import { otpSms } from '../_shared/otpSms.ts';
import { maskPhone } from '../_shared/smsLogic.ts';
import { verifyHookSignature, parseHookPayload, saudiMobileForSms, hookErrorBody } from './logic.ts';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SEND_FAILED = 'We could not send the verification code. Please try again in a moment.';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return json(hookErrorBody(405, 'POST only.'), 405);
  }

  const secret = Deno.env.get('SEND_SMS_HOOK_SECRET');
  if (!secret) {
    console.error('send-sms-hook: missing SEND_SMS_HOOK_SECRET in the function environment.');
    return json(hookErrorBody(500, SEND_FAILED), 500);
  }

  // The signature covers the raw bytes, so read the body as text first.
  const body = await req.text();

  const signed = await verifyHookSignature({
    secret,
    id: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signatureHeader: req.headers.get('webhook-signature'),
    body,
    nowSeconds: Math.floor(Date.now() / 1000)
  });
  if (!signed) {
    console.error('send-sms-hook: rejected a request with a missing, invalid or stale signature.');
    return json(hookErrorBody(401, 'Invalid signature.'), 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error('send-sms-hook: signed request with an unparseable body.');
    return json(hookErrorBody(400, SEND_FAILED), 400);
  }

  const payload = parseHookPayload(parsed);
  if (!payload) {
    console.error('send-sms-hook: signed request without a phone number or a 6-digit code.');
    return json(hookErrorBody(400, SEND_FAILED), 400);
  }

  const mobile = saudiMobileForSms(payload.phone);
  if (!mobile) {
    console.error(`send-sms-hook: refused non-Saudi-mobile number ${maskPhone(payload.phone)}.`);
    return json(hookErrorBody(400, 'Only Saudi mobile numbers are supported.'), 400);
  }

  const result = await sendSms(mobile, otpSms(payload.otp));
  if (!result.success) {
    // sendSms() already logged the provider outcome (masked number, no text).
    console.error(`send-sms-hook: code not delivered to ${maskPhone(mobile)}.`);
    return json(hookErrorBody(500, SEND_FAILED), 500);
  }

  console.log(`send-sms-hook: code delivered to ${maskPhone(mobile)}.`);
  return json({}, 200);
});
