/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure logic for send-sms-hook: the Supabase Auth "Send SMS" hook.
 *
 * Zero Deno/Supabase imports, so it runs under plain Node/tsx in
 * logic.test.ts — same arrangement as the other functions' logic.ts files.
 * Uses only Web Crypto (crypto.subtle), atob/btoa and TextEncoder, which Deno
 * and Node both provide; no signature library.
 *
 * SIGNATURE (Standard Webhooks, which Supabase Auth hooks use)
 *   secret header value  "v1,whsec_<base64 key>" (as generated in the dashboard)
 *   signed content       `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   algorithm            HMAC-SHA256, base64-encoded
 *   webhook-signature    one or more "v1,<base64>" separated by spaces
 *   freshness            webhook-timestamp within ±5 minutes of now
 */

import { toSaudiInternational } from '../_shared/smsLogic.ts';

/** How far webhook-timestamp may be from now, in seconds. */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** The HMAC key bytes from the dashboard secret ("v1,whsec_…", or a bare "whsec_…"), or null if malformed. */
export function hookSecretKey(secret: string): Uint8Array | null {
  const raw = String(secret ?? '').trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Constant-time string comparison (length is not secret). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** base64 HMAC-SHA256 of `content` under `key`. Exported for the tests. */
export async function hmacSha256Base64(key: Uint8Array, content: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(content));
  return toBase64(new Uint8Array(sig));
}

export interface SignatureInput {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signatureHeader: string | null;
  /** The raw request body, exactly as received — before any JSON parsing. */
  body: string;
  nowSeconds: number;
}

/** True only for a fresh request signed with this secret. Never throws. */
export async function verifyHookSignature(input: SignatureInput): Promise<boolean> {
  const { secret, id, timestamp, signatureHeader, body, nowSeconds } = input;
  if (!id || !timestamp || !signatureHeader) return false;

  const key = hookSecretKey(secret);
  if (!key) return false;

  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  let expected: string;
  try {
    expected = await hmacSha256Base64(key, `${id}.${timestamp}.${body}`);
  } catch {
    return false;
  }

  // Check every listed signature; accept if any v1 entry matches.
  let ok = false;
  for (const entry of signatureHeader.split(' ')) {
    const [version, sig] = entry.split(',', 2);
    if (version === 'v1' && sig && safeEqual(sig, expected)) ok = true;
  }
  return ok;
}

/** The two fields the hook uses, or null for any other shape. The code must be 6 digits. */
export function parseHookPayload(payload: unknown): { phone: string; otp: string } | null {
  const p = payload as { user?: { phone?: unknown }; sms?: { otp?: unknown } } | null;
  const phone = typeof p?.user?.phone === 'string' ? p.user.phone : '';
  const otp = typeof p?.sms?.otp === 'string' ? p.sms.otp : '';
  if (!phone || !/^\d{6}$/.test(otp)) return null;
  return { phone, otp };
}

/**
 * The number to send to, as 9665XXXXXXXX, or null when it is not a Saudi
 * mobile — the hook refuses those, which also blocks SMS toll fraud to
 * foreign numbers.
 */
export function saudiMobileForSms(phone: string): string | null {
  const intl = toSaudiInternational(phone);
  return /^9665\d{8}$/.test(intl) ? intl : null;
}

/** The error body Supabase Auth expects from a hook. */
export function hookErrorBody(httpCode: number, message: string) {
  return { error: { http_code: httpCode, message } };
}
