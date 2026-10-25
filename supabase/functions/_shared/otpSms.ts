/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one source of the phone verification (OTP) SMS text, sent by
 * send-sms-hook. It is the template registered with the SMS provider, so it
 * must stay byte-identical to that registration: English, a single line
 * break ("\n", no blank line), then Arabic, with the code in both lines. Do
 * not reword it here without
 * re-registering the template first.
 *
 * Zero Deno/Supabase imports, so it runs under Deno, Vite and plain Node alike.
 */

export function otpSms(code: string): string {
  return `Your Arty verification code: ${code}. Valid for 5 minutes.\nرمز التحقق الخاص بك: ${code}. صالح لمدة 5 دقائق.`;
}
