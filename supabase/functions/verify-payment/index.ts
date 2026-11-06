/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * verify-payment — the backend check Moyasar requires before a booking is
 * treated as paid.
 *
 * The payment step calls this twice for one payment, and either call alone is
 * enough:
 *   1. from Moyasar.js's on_completed, with the new payment's id, BEFORE the
 *      3-D Secure redirect — so the payment is on record even if the customer
 *      never comes back;
 *   2. from the callback page, with the `id` Moyasar appends to callback_url.
 * The auto-cancel job runs the same check before expiring a hold that has a
 * payment on record.
 *
 * WHAT IT DOES
 *   POST { paymentId } -> fetch GET /v1/payments/{id} from Moyasar with
 *   MOYASAR_SECRET_KEY -> record it in booking_payments -> if status is
 *   'paid', confirm_booking_payment() (migration 0046) checks currency, the
 *   exact halalas the booking owes, that the payment pays nothing else, and
 *   that the place is still free -> booking becomes Deposit Paid / Paid.
 *   See _shared/confirmPayment.ts.
 *
 * AUTHORIZATION — deliberately none (verify_jwt = false in config.toml)
 * A signed-out guest must be able to finish paying, and the request carries
 * nothing to trust: the ONLY input is a payment id, and everything decided
 * comes from Moyasar's record fetched with our secret key. The worst an
 * arbitrary caller can do is ask us to confirm a payment that really was paid
 * for the booking it names — which is the point. Ids that are not uuids are
 * refused before any request is made with the key. The answer for a
 * confirmed payment includes a booking summary with no personal data.
 *
 * SECRETS
 *   MOYASAR_SECRET_KEY   sk_test_… / sk_live_… — never logged or returned
 *   MOYASAR_MODE         optional 'test' | 'live'; refuses to run on a mismatch
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { verifyAndConfirmPayment } from '../_shared/confirmPayment.ts';
import { isMoyasarPaymentId, secretKeyProblem } from '../_shared/moyasarLogic.ts';
import type { VerifyPaymentRequest, VerifyPaymentResponse } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: VerifyPaymentResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST only.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const secretKey = Deno.env.get('MOYASAR_SECRET_KEY') ?? '';

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('verify-payment: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
    return json({ success: false, error: 'Server is not configured.' }, 500);
  }

  const keyProblem = secretKeyProblem(secretKey, Deno.env.get('MOYASAR_MODE'));
  if (keyProblem) {
    // The reason goes to the function log only; the caller learns nothing
    // about how the key is set up.
    console.error(`verify-payment: ${keyProblem}`);
    return json({ success: false, error: 'Payments are not configured.' }, 500);
  }

  let body: VerifyPaymentRequest;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400);
  }

  const paymentId = body?.paymentId;
  if (!isMoyasarPaymentId(paymentId)) {
    return json({ success: false, error: 'paymentId must be a Moyasar payment id.' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const result = await verifyAndConfirmPayment(admin, secretKey, paymentId);

  if (!result.ok) {
    switch (result.reason) {
      case 'invalid_id':
        return json({ success: false, error: 'paymentId must be a Moyasar payment id.' }, 400);
      case 'not_found':
        return json({ success: true, state: 'not_found', bookingId: null }, 200);
      case 'unauthorized':
        // Logged in verifyAndConfirmPayment. A key problem, not the customer's.
        return json({ success: false, error: 'Payments are not configured.' }, 500);
      default:
        // Moyasar or the database did not answer. Retrying is safe.
        return json({ success: false, error: 'Could not check the payment right now. Please try again.' }, 502);
    }
  }

  return json({
    success: true,
    state: result.state,
    bookingId: result.bookingId,
    message: result.message ?? null,
    booking: result.booking
  }, 200);
});
