/**
 * Phone sign-in by SMS code — the browser half of the phone OTP flow.
 *
 * Supabase Auth owns the code (generation, expiry, attempts, rate limits) and
 * delivers it through the send-sms-hook Edge Function. These wrappers only
 * call it, then link the verified phone to the customer record through
 * link_customer_by_verified_phone() (migration 0041), which reads the phone
 * from the session itself — nothing here sends a phone, customer id or auth id
 * to the database.
 *
 * The client is passed in rather than imported, so this module has no
 * dependency on how the app builds its Supabase clients (and can be tested
 * with a stand-in). Pass the CUSTOMER client, never the staff one.
 *
 * Failures come back as a `reason` code, not a sentence, so the screen can
 * show it in either language.
 *
 * Used by PhoneOtpFlow (AuthSection, CheckoutInfoSection) and AppContext's
 * loginCustomer(), all behind VITE_PHONE_AUTH (utils/featureFlags.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeCustomerPhone } from './customerIdentity';
import { parseArabicDigits } from './phoneUtils';

/** Just the two surfaces these wrappers use. */
export type PhoneAuthClient = Pick<SupabaseClient, 'auth' | 'rpc'>;

/** What link_customer_by_verified_phone() can answer (see 0041). */
export type PhoneLinkStatus = 'linked' | 'created' | 'already_linked' | 'phone_in_use' | 'not_verified' | 'error';

export type PhoneAuthFailure =
  | 'invalid_phone'     // not a Saudi mobile number
  | 'rate_limited'      // too many codes requested; try again later
  | 'send_failed'       // the code could not be sent
  | 'invalid_code'      // not 6 digits, wrong, or expired
  | 'link_failed'       // verified, but the customer record could not be linked
  | 'weak_password'     // Supabase refused the password
  | 'update_failed';    // the password could not be saved

export type Failure = { ok: false; reason: PhoneAuthFailure };

const LINK_STATUSES: readonly PhoneLinkStatus[] = ['linked', 'created', 'already_linked', 'phone_in_use', 'not_verified', 'error'];

/**
 * "+9665XXXXXXXX" (E.164, what Supabase Auth expects) for a Saudi mobile in
 * any common form — 05…, 5…, 9665…, +966…, 00966…, with spaces, dashes or
 * Arabic-Indic digits — or null when it is not one.
 */
export function toE164Saudi(input?: string | null): string | null {
  const national = normalizeCustomerPhone(parseArabicDigits(String(input ?? '')));
  return /^5\d{8}$/.test(national) ? `+966${national}` : null;
}

/**
 * "+966 5•• ••• •94" — what the screen shows after a code is sent. Only the
 * first national digit and the last two are visible. Render it inside a
 * left-to-right span so it reads the same in Arabic.
 */
export function maskE164Saudi(input?: string | null): string {
  const e164 = toE164Saudi(input);
  if (!e164) return '';
  const national = e164.slice(4);
  return `+966 ${national[0]}•• ••• •${national.slice(-2)}`;
}

/**
 * Asks Supabase to text a code. Creates the auth user on first use: turning
 * that off would make an unknown number answer differently from a known one,
 * which is exactly the enumeration the flow avoids. The answer is the same
 * whether or not the number is on file.
 */
export async function requestPhoneCode(
  client: PhoneAuthClient,
  phone: string
): Promise<{ ok: true; phone: string } | Failure> {
  const e164 = toE164Saudi(phone);
  if (!e164) return { ok: false, reason: 'invalid_phone' };

  const { error } = await client.auth.signInWithOtp({ phone: e164, options: { shouldCreateUser: true } });
  if (error) {
    // The status only — never the number.
    console.error(`requestPhoneCode failed (status ${(error as { status?: number }).status ?? 'unknown'}).`);
    return { ok: false, reason: (error as { status?: number }).status === 429 ? 'rate_limited' : 'send_failed' };
  }
  return { ok: true, phone: e164 };
}

/**
 * Checks the code, which signs the visitor in, then links their verified
 * phone to the customer record. `name` is used only if a brand-new record is
 * created.
 */
export async function verifyPhoneCode(
  client: PhoneAuthClient,
  phone: string,
  code: string,
  name?: string
): Promise<{ ok: true; status: PhoneLinkStatus; customerId?: string } | Failure> {
  const e164 = toE164Saudi(phone);
  if (!e164) return { ok: false, reason: 'invalid_phone' };

  const token = parseArabicDigits(String(code ?? '')).replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return { ok: false, reason: 'invalid_code' };

  const { data, error } = await client.auth.verifyOtp({ phone: e164, token, type: 'sms' });
  if (error || !data?.session) return { ok: false, reason: 'invalid_code' };

  const { data: link, error: linkError } = await client.rpc('link_customer_by_verified_phone', {
    p_name: name?.trim() || null
  });
  if (linkError) {
    console.error('link_customer_by_verified_phone failed:', linkError.message);
    return { ok: false, reason: 'link_failed' };
  }

  const status = (link as { status?: string } | null)?.status as PhoneLinkStatus | undefined;
  if (!status || !LINK_STATUSES.includes(status)) return { ok: false, reason: 'link_failed' };

  const customerId = (link as { customer_id?: unknown }).customer_id;
  return typeof customerId === 'string' && customerId
    ? { ok: true, status, customerId }
    : { ok: true, status };
}

/**
 * Sets the signed-in visitor's password (first time, or after "forgot
 * password" by code). Strength rules are the caller's to check first
 * (validatePasswordRule); Supabase's own minimum still applies and comes back
 * as weak_password.
 */
export async function setPassword(
  client: PhoneAuthClient,
  password: string,
  name?: string
): Promise<{ ok: true } | Failure> {
  if (!password) return { ok: false, reason: 'weak_password' };

  const trimmedName = name?.trim();
  const { error } = await client.auth.updateUser(
    trimmedName ? { password, data: { name: trimmedName } } : { password }
  );
  if (error) {
    const status = (error as { status?: number }).status;
    return { ok: false, reason: status === 422 ? 'weak_password' : 'update_failed' };
  }
  return { ok: true };
}
