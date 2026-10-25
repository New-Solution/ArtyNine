/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one sendSms() every Edge Function calls. It picks the provider from the
 * SMS_PROVIDER secret:
 *
 *   unset / "mshastra" -> mShastra (_shared/mshastra.ts) — the default
 *   "meertek"          -> meertek  (_shared/meertek.ts)
 *
 * Any other value logs a warning and uses mShastra, so a typo never stops SMS.
 * Both providers share one contract — never throw, return a SendSmsResult — so
 * callers behave the same whichever is active.
 */

import { sendSms as sendSmsViaMshastra } from './mshastra.ts';
import { sendSmsViaMeertek } from './meertek.ts';
import { pickSmsProvider, type SendSmsResult } from './smsLogic.ts';

export type { SendSmsResult };

export async function sendSms(phone: string, message: string): Promise<SendSmsResult> {
  const { provider, unknown } = pickSmsProvider(Deno.env.get('SMS_PROVIDER'));
  if (unknown) {
    console.warn(`sendSms: unknown SMS_PROVIDER "${unknown}" — using mshastra.`);
  }
  return provider === 'meertek' ? sendSmsViaMeertek(phone, message) : sendSmsViaMshastra(phone, message);
}
