/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared mShastra SMS-sending primitive (SMS integration audit, Chunk 1).
 *
 * This is the only place MSHASTRA_USERNAME / MSHASTRA_PASSWORD are ever
 * read. They live exclusively in this Deno runtime's environment (set via
 * `supabase secrets set`, read here via Deno.env.get()) — never hardcoded,
 * never returned to a caller, never logged. The constructed request URL
 * (which embeds both credentials as query parameters, per mShastra's own
 * API design) is likewise never logged; only the phone number and the
 * success/failure outcome are.
 *
 * Deliberately generic — `sendSms(phone, message)` sends whatever message
 * text it's given to whatever phone number it's given. It has no notion of
 * "pickup reminder" or any other specific use case, so both the
 * notifications work (Chunk 2) and the later OTP work can call it as-is.
 */

import { toSaudiInternational, type SendSmsResult } from './smsLogic.ts';

export type { SendSmsResult };

const MSHASTRA_ENDPOINT = 'https://mshastra.com/sendurl.aspx';

/**
 * mShastra's required format: international, digits only, no leading '+'
 * (e.g. "966501234567") — the shared normalization in smsLogic.ts, also used
 * by meertek.ts.
 */
const normalizePhoneForMshastra = toSaudiInternational;

/**
 * Sends a single SMS via mShastra. Never throws — every failure path
 * (missing secrets, network error, non-2xx status, missing "Success" in
 * the body) returns { success: false, error }, so callers never need a
 * try/catch around this.
 */
export async function sendSms(phone: string, message: string): Promise<SendSmsResult> {
  const username = Deno.env.get('MSHASTRA_USERNAME');
  const password = Deno.env.get('MSHASTRA_PASSWORD');
  const senderId = Deno.env.get('MSHASTRA_SENDER_ID');

  if (!username || !password || !senderId) {
    console.error('sendSms: missing MSHASTRA_USERNAME / MSHASTRA_PASSWORD / MSHASTRA_SENDER_ID in the function environment.');
    return { success: false, error: 'SMS is not configured.' };
  }

  const mobileno = normalizePhoneForMshastra(phone);

  // URLSearchParams handles URL-encoding (including UTF-8/Arabic message
  // text) correctly on its own — no manual encodeURIComponent needed.
  const params = new URLSearchParams({
    user: username,
    pwd: password,
    mobileno,
    msgtext: message,
    senderid: senderId,
    CountryCode: 'ALL'
  });

  let res: Response;
  try {
    // Never log `params` or the constructed URL — they contain the
    // account password in plain text.
    res = await fetch(`${MSHASTRA_ENDPOINT}?${params.toString()}`);
  } catch (err) {
    console.error(`sendSms: network error sending to ${mobileno}:`, err instanceof Error ? err.message : String(err));
    return { success: false, error: 'Could not reach the SMS provider.' };
  }

  const body = await res.text();

  if (!res.ok) {
    console.error(`sendSms: mShastra returned HTTP ${res.status} for ${mobileno}.`);
    return { success: false, rawResponse: body, error: `SMS provider returned HTTP ${res.status}.` };
  }

  // Case-sensitive, per mShastra's own documented success signal.
  const ok = body.includes('Success');
  if (!ok) {
    console.error(`sendSms: mShastra response for ${mobileno} did not contain "Success".`);
    return { success: false, rawResponse: body, error: 'SMS provider did not confirm delivery.' };
  }

  console.log(`sendSms: delivered to ${mobileno}.`);
  return { success: true };
}
