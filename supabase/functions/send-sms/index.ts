/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * send-sms — SMS integration audit, Chunk 1 (backend foundation only).
 *
 * Sends a single SMS via the active provider (_shared/sms.ts) to any phone
 * number, on behalf of any currently-active staff session. Not wired to
 * any UI trigger yet — that's Chunk 2. Not deployed by this chunk.
 *
 * AUTHORIZATION: any authenticated, currently-active staff session (any
 * role, not Super-Admin-only) — mirrors is_staff() exactly, because this
 * function makes no privileged writes of its own. See the Chunk 1 report
 * for the full reasoning.
 *
 * Unlike provision-staff, this function never touches the service-role
 * key: the caller-scoped client (the caller's own JWT, anon key) is
 * sufficient, because the only fact this function needs to establish —
 * "is the caller currently active staff?" — is exactly what is_staff()
 * itself answers, and RLS already restricts that RPC's result to the
 * caller's own identity. Reusing is_staff() also means this check can
 * never drift from the definition every RLS policy in this schema
 * already trusts, rather than a hand-reimplemented copy of its query.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { sendSms } from '../_shared/sms.ts';
import { validateSendSmsInput } from './logic.ts';
import type { SendSmsRequest, SendSmsResponse } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: SendSmsResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST only.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !anonKey) {
    console.error('send-sms: missing SUPABASE_URL / SUPABASE_ANON_KEY in the function environment.');
    return json({ success: false, error: 'Server is not configured.' }, 500);
  }

  // 1. Who is calling? Verified against Supabase's own Auth server via
  // this caller-scoped client — never a locally-decoded JWT payload. Same
  // pattern as provision-staff/index.ts.
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser();
  if (callerAuthError || !callerAuth?.user) {
    return json({ success: false, error: 'Sign in required.' }, 401);
  }

  // 2. Is the caller currently active staff? is_staff() is SECURITY
  // DEFINER but evaluates strictly against auth.uid() — calling it through
  // the caller-scoped client (their own JWT) answers "is *this* caller
  // staff", not "is anyone staff".
  const { data: isStaff, error: isStaffError } = await callerClient.rpc('is_staff');
  if (isStaffError) {
    console.error('send-sms: is_staff() check failed:', isStaffError.message);
    return json({ success: false, error: 'Could not verify authorization.' }, 500);
  }
  if (!isStaff) {
    return json({ success: false, error: 'Staff sign-in required.' }, 403);
  }

  // 3. Parse and validate input.
  let body: SendSmsRequest;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400);
  }

  const validation = validateSendSmsInput(body);
  if (!validation.valid) {
    return json({ success: false, error: validation.error }, 422);
  }

  // 4. Send. sendSms() never throws — every failure path already returns
  // a structured result.
  const result = await sendSms(validation.phone, validation.message);
  return json(
    result.success ? { success: true } : { success: false, error: result.error },
    result.success ? 200 : 502
  );
});
