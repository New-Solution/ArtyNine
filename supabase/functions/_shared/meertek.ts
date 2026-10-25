/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * meertek SMS-sending primitive — the second provider, picked by
 * SMS_PROVIDER=meertek in sms.ts. Same contract as mshastra.ts: send one
 * message, never throw, return a SendSmsResult.
 *
 * MEERTEK_PROXY_TOKEN is read only here, from this Deno runtime's environment
 * (`supabase secrets set`). It travels in the request URL, so neither the URL
 * nor a fetch error's message (which can quote the URL) is ever logged. Logs
 * carry a masked phone number and the provider's status text — never the
 * token, the full number or the message.
 */

import { maskPhone, parseMeertekResponse, toSaudiInternational, type SendSmsResult } from './smsLogic.ts';

const MEERTEK_ENDPOINT = 'https://fp.meertek.com/send';

export async function sendSmsViaMeertek(phone: string, message: string): Promise<SendSmsResult> {
  const token = Deno.env.get('MEERTEK_PROXY_TOKEN');
  if (!token) {
    console.error('sendSms[meertek]: missing MEERTEK_PROXY_TOKEN in the function environment.');
    return { success: false, error: 'SMS is not configured.' };
  }

  const mobileno = toSaudiInternational(phone);
  const masked = maskPhone(mobileno);

  // URLSearchParams URL-encodes the message as UTF-8 — Arabic, emoji and line
  // breaks included.
  const params = new URLSearchParams({ proxy_token: token, mobileno, msgtext: message });

  let res: Response;
  try {
    res = await fetch(`${MEERTEK_ENDPOINT}?${params.toString()}`);
  } catch (err) {
    // Only the error's type: its message can contain the request URL, token and all.
    console.error(`sendSms[meertek]: network error sending to ${masked} (${err instanceof Error ? err.name : 'unknown error'}).`);
    return { success: false, error: 'Could not reach the SMS provider.' };
  }

  const body = await res.text();

  if (!res.ok) {
    console.error(`sendSms[meertek]: HTTP ${res.status} for ${masked}.`);
    return { success: false, error: `SMS provider returned HTTP ${res.status}.` };
  }

  const parsed = parseMeertekResponse(body);
  if (!parsed.ok) {
    console.error(`sendSms[meertek]: not sent to ${masked}: ${parsed.status || 'empty response'}`);
    // The status text only — the raw body also echoes the full number.
    return { success: false, rawResponse: parsed.status, error: parsed.status || 'SMS provider did not confirm delivery.' };
  }

  console.log(`sendSms[meertek]: delivered to ${masked} (id ${parsed.id}).`);
  return { success: true };
}
