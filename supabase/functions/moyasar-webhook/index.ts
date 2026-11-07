/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * moyasar-webhook — the backup path for payment results.
 *
 * The primary path is the customer's own browser: on_completed and the return
 * page both call verify-payment. This catches the cases where neither runs
 * (the tab closed mid-3-D Secure, a dropped connection) faster than the
 * auto-cancel job's check before expiry.
 *
 * SETUP (Moyasar dashboard -> Settings -> Webhooks -> Add Webhook)
 *   Endpoint:     https://<project>.supabase.co/functions/v1/moyasar-webhook
 *   HTTP method:  POST
 *   Secret token: the same value as this function's MOYASAR_WEBHOOK_SECRET
 *   Events:       payment_paid (required); payment_failed, payment_refunded,
 *                 payment_voided are useful for the audit trail.
 *
 * TRUST
 * Moyasar documents one authenticity check: the webhook's secret_token, sent
 * in the body. It is compared in constant time. Even then nothing in the body
 * is believed: the payment id is taken from it and the payment is fetched
 * from the Moyasar API with MOYASAR_SECRET_KEY, through the same
 * verifyAndConfirmPayment() verify-payment uses. A forged webhook with a
 * guessed token could at most make us re-check a real payment.
 *
 * WEBHOOK VERIFICATION
 * When the webhook is added, Moyasar sends type "webhook_verification" with a
 * code in data.verification_code. It is answered 200 before the secret_token
 * check; the code is written to the function log ("MOYASAR WEBHOOK
 * VERIFICATION CODE: ...") to be entered in the dashboard. No data is touched.
 *
 * RESPONSES (Moyasar retries any non-2xx 5 more times: immediately, then
 * 1 min, 10 min, 30 min, 1 h, 2 h)
 *   200  handled, or deliberately ignored (non-payment event, wrong mode)
 *   400  unreadable body — retrying will not help, but Moyasar should see it
 *   401  wrong or missing secret_token
 *   500  not configured, or Moyasar/the database did not answer — retried
 *
 * verify_jwt = false (config.toml): Moyasar sends no Supabase JWT.
 *
 * SECRETS: MOYASAR_WEBHOOK_SECRET, MOYASAR_SECRET_KEY, optional MOYASAR_MODE,
 * plus the platform's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { verifyAndConfirmPayment } from '../_shared/confirmPayment.ts';
import { parseWebhook, secretKeyProblem, tokensMatch, keyMode, webhookVerification } from '../_shared/moyasarLogic.ts';

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only.' });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Invalid JSON.' });
  }

  // Webhook verification (sent when the webhook is added in the dashboard):
  // handled before the secret_token check and any payment logic. Only the
  // code is logged — never the token or the body — and nothing is touched.
  const verification = webhookVerification(body);
  if (verification.isVerification) {
    if (verification.code) {
      console.log(`MOYASAR WEBHOOK VERIFICATION CODE: ${verification.code}`);
    } else {
      console.log('moyasar-webhook: webhook_verification event without a usable data.verification_code.');
    }
    return reply(200, { verification: 'received' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const webhookSecret = Deno.env.get('MOYASAR_WEBHOOK_SECRET') ?? '';
  const secretKey = Deno.env.get('MOYASAR_SECRET_KEY') ?? '';
  const keyProblem = secretKeyProblem(secretKey, Deno.env.get('MOYASAR_MODE'));

  if (!supabaseUrl || !serviceRoleKey || !webhookSecret || keyProblem) {
    console.error(`moyasar-webhook: not configured — ${keyProblem ?? 'missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / MOYASAR_WEBHOOK_SECRET'}`);
    return reply(500, { error: 'Not configured.' });
  }

  if (!tokensMatch(body?.secret_token, webhookSecret)) {
    console.error('moyasar-webhook: rejected a request with a wrong or missing secret_token.');
    return reply(401, { error: 'Unauthorized.' });
  }

  const parsed = parseWebhook(body);
  if (parsed.kind === 'invalid') {
    console.error(`moyasar-webhook: unreadable event ${body?.id ?? ''}: ${parsed.reason}`);
    return reply(400, { error: parsed.reason });
  }
  if (parsed.kind === 'ignored') {
    return reply(200, { ignored: parsed.reason });
  }

  // A live event reaching a test setup (or the reverse) is a dashboard
  // misconfiguration: acknowledge it so it is not retried, and log it.
  const mode = keyMode(secretKey);
  if (parsed.live !== null && mode && parsed.live !== (mode === 'live')) {
    console.error(`moyasar-webhook: ignored ${parsed.live ? 'live' : 'test'} event ${body?.id ?? ''} with a ${mode} key.`);
    return reply(200, { ignored: 'mode mismatch' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const result = await verifyAndConfirmPayment(admin, secretKey, parsed.paymentId);

  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'invalid_id') {
      // Moyasar does not know this payment under our key: nothing to retry.
      return reply(200, { ignored: result.reason });
    }
    // Moyasar or the database did not answer: let Moyasar retry.
    return reply(500, { error: 'Temporary failure, please retry.' });
  }

  return reply(200, { event: parsed.eventType, state: result.state });
});
