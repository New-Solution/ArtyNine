/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure SMS helpers shared by both providers (mshastra.ts, meertek.ts) and the
 * provider switch (sms.ts).
 *
 * Zero Deno/Supabase imports, so it runs under plain Node/tsx in
 * smsLogic.test.ts — same arrangement as the functions' own logic.ts files.
 */

export interface SendSmsResult {
  success: boolean;
  /** Only set on failure, for debugging — the response body, never the request. */
  rawResponse?: string;
  error?: string;
}

export type SmsProvider = 'mshastra' | 'meertek';

/**
 * Normalizes a phone number to the international format both providers want:
 * digits only, no leading '+', e.g. "966501234567".
 *
 * Mirrors normalizeCustomerPhone() (src/utils/customerIdentity.ts) and its
 * SQL counterpart normalize_customer_phone() (0001_init.sql) exactly: strip
 * everything but digits, then drop a leading "00", then a leading "966",
 * then a leading "0" — leaving the bare national number — then prepend
 * "966". Not imported from the frontend (this runs under Deno, a separate
 * toolchain with no access to src/), so this is a deliberate,
 * intentionally-kept-in-sync mirror, not a shortcut.
 *
 * KSA-specific by design, matching the rest of this app's phone handling —
 * every customer/staff phone in this system is already assumed Saudi.
 */
export function toSaudiInternational(phone: string): string {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('966')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return `966${digits}`;
}

/** "966501234994" -> "9665****994", for logs. Short values are masked entirely. */
export function maskPhone(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return '****';
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

/**
 * Which provider SMS_PROVIDER selects. Unset or blank means mShastra, the
 * default. `unknown` is set when the value is something else — the caller
 * logs it and still uses mShastra, so a typo never stops SMS going out.
 */
export function pickSmsProvider(value: string | undefined | null): { provider: SmsProvider; unknown?: string } {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'meertek') return { provider: 'meertek' };
  if (v === '' || v === 'mshastra') return { provider: 'mshastra' };
  return { provider: 'mshastra', unknown: v };
}

/**
 * meertek answers "id,number,status", e.g. "4471923,966501234567,Sent" or
 * "0,966501234567,Invalid Mobile No.". Sent when the first field is anything
 * other than "0" (and not empty). `status` is the text after the second comma
 * — it may itself contain commas. A body without that three-field shape (an
 * "Unauthorized", an HTML error page) is never treated as sent: it comes back
 * as failed, with the whole body as the status. The number is deliberately
 * not returned, so it never reaches a log.
 */
export function parseMeertekResponse(body: string): { ok: boolean; id: string; status: string } {
  const text = String(body ?? '').trim();
  const parts = text.split(',');
  if (parts.length < 3) return { ok: false, id: '', status: text };
  const id = parts[0].trim();
  const status = parts.slice(2).join(',').trim();
  return { ok: id !== '' && id !== '0', id, status };
}
