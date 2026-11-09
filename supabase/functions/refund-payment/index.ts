/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * refund-payment — staff return a customer's online payment through the
 * Moyasar API, from the Bookings or Events detail panel, without opening the
 * Moyasar dashboard.
 *
 *   POST { bookingId }  (staff JWT)
 *
 * Everything else — the Moyasar payment id, the amount, whether a refund is
 * due — is read from the database. The decisions are in logic.ts (see its
 * header for the full flow and the double-click guard); this file is only
 * the HTTP and Deno plumbing.
 *
 * AUTHORIZATION
 *   verify_jwt = true (the CLI default; not listed in config.toml), and then
 *   checked here against Supabase Auth: the caller must be active console
 *   staff with the Bookings or the Events page (staff_can(), 0013; Super
 *   Admin always passes). Checked through the caller's own JWT, never a
 *   client-supplied role.
 *
 * DATABASE (migration 0054 must be applied first)
 *   claim_booking_refund / release_booking_refund / complete_booking_refund,
 *   service role only; moyasar_payment_events accepts source 'refund-payment'.
 *
 * SECRETS
 *   MOYASAR_SECRET_KEY   sk_test_… / sk_live_… — never logged or returned
 *   MOYASAR_MODE         optional 'test' | 'live'; refuses to run on a mismatch
 *   SMS_PROVIDER + provider secrets, for the refunded SMS (_shared/sms.ts)
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   platform
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { secretKeyProblem } from '../_shared/moyasarLogic.ts';
import { sendSms } from '../_shared/sms.ts';
import { authorizeRefundCaller, refundBooking } from './logic.ts';
import type { RefundPaymentRequest, RefundPaymentResponse } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: RefundPaymentResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ success: false, code: 'invalid_input', error: 'POST only.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const secretKey = Deno.env.get('MOYASAR_SECRET_KEY') ?? '';
  const keyProblem = secretKeyProblem(secretKey, Deno.env.get('MOYASAR_MODE'));

  if (!supabaseUrl || !anonKey || !serviceRoleKey || keyProblem) {
    console.error(`refund-payment: not configured — ${keyProblem ?? 'missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY'}`);
    return json({ success: false, code: 'internal_error', error: 'Refunds are not configured on the server.' }, 500);
  }

  // 1. Who is calling — verified by Supabase Auth, not decoded locally.
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });
  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser();
  if (callerAuthError || !callerAuth?.user) {
    return json({ success: false, code: 'unauthenticated', error: 'Sign in required.' }, 401);
  }

  // 2. Staff with Bookings or Events access.
  const auth = await authorizeRefundCaller(callerClient);
  if (!auth.ok) {
    if (auth.httpStatus === 500) console.error('refund-payment: staff_can() check failed.');
    return json({ success: false, code: auth.code, error: auth.error }, auth.httpStatus);
  }

  // 3. Input: a booking id, nothing else.
  let body: RefundPaymentRequest;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, code: 'invalid_input', error: 'Invalid request body.' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // The name for the timeline entry, from the staff row.
  const { data: staffRow } = await admin.from('staff').select('name').eq('user_id', callerAuth.user.id).maybeSingle();
  const actor = String(staffRow?.name ?? '').trim() || 'Staff';

  const outcome = await refundBooking({ admin, secretKey, sendSms }, body?.bookingId, actor);
  return json(outcome.body, outcome.httpStatus);
});
