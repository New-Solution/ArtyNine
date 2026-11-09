/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Moyasar API, server side. The only place MOYASAR_SECRET_KEY is used to
 * make a request: it is passed in by the caller (verify-payment,
 * auto-cancel-bookings, refund-payment), which reads it from its Edge Function environment.
 * It is never logged, returned, or sent anywhere but api.moyasar.com.
 *
 * No Deno-specific imports: `fetch` is injectable so the confirm flow can be
 * tested under tsx with a fake.
 */

import { isMoyasarPaymentId } from './moyasarLogic.ts';

export const MOYASAR_API = 'https://api.moyasar.com/v1';

/** A Moyasar request that never answers must not hold a checkout open. */
const TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FetchPaymentResult =
  | { ok: true; payment: unknown }
  | { ok: false; reason: 'invalid_id' | 'not_found' | 'unauthorized' | 'unavailable'; detail?: string };

/**
 * GET /v1/payments/{id}, authenticated with HTTP Basic: the secret key as the
 * username and an empty password (Moyasar API docs, "Authentication").
 */
export async function fetchMoyasarPayment(
  paymentId: string,
  secretKey: string,
  fetchImpl: FetchLike = fetch
): Promise<FetchPaymentResult> {
  if (!isMoyasarPaymentId(paymentId)) return { ok: false, reason: 'invalid_id' };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${MOYASAR_API}/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${secretKey}:`)}`,
        Accept: 'application/json'
      },
      signal: abort.signal
    });

    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 401 || res.status === 403) {
      // Wrong or revoked key — a configuration problem, not the customer's.
      return { ok: false, reason: 'unauthorized', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) return { ok: false, reason: 'unavailable', detail: `HTTP ${res.status}` };

    return { ok: true, payment: await res.json() };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { ok: false, reason: 'unavailable', detail: name === 'AbortError' ? 'timeout' : String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Void and refund (https://docs.moyasar.com/guides/payment-operations)
//
//   POST /v1/payments/{id}/void     no body; authorized, or paid/captured
//                                   within ~2 hours of the transaction
//   POST /v1/payments/{id}/refund   optional { amount } in halalas; paid or
//                                   captured
// Both answer with the payment, whose status becomes 'voided' / 'refunded'.
// Errors are { type, message, errors } (docs: /api/errors).
// Used only by refund-payment; the secret key is passed in, never logged.
// -----------------------------------------------------------------------------

export type PaymentOperation = 'void' | 'refund';

export type PaymentOperationResult =
  | { ok: true; httpStatus: number; body: unknown }
  | {
      ok: false;
      /** rejected: Moyasar answered 4xx (its message says why).
       *  unauthorized: wrong key. unavailable: 5xx, timeout, network. */
      reason: 'invalid_id' | 'rejected' | 'unauthorized' | 'unavailable';
      httpStatus: number | null;
      /** The parsed response body, when there was one (for the evidence log). */
      body: unknown;
      /** Human-readable, from Moyasar's own message when it gave one. */
      message: string;
    };

/** "Validation Failed: amount must be an integer" from a Moyasar error body. */
export function moyasarErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as Record<string, any>;
  const message = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : '';
  const details: string[] = [];
  if (b.errors && typeof b.errors === 'object' && !Array.isArray(b.errors)) {
    for (const [field, value] of Object.entries(b.errors)) {
      const list = Array.isArray(value) ? value : [value];
      for (const v of list) if (typeof v === 'string' && v.trim()) details.push(`${field} ${v.trim()}`);
    }
  } else if (Array.isArray(b.errors)) {
    for (const v of b.errors) if (typeof v === 'string' && v.trim()) details.push(v.trim());
  }
  const text = [message, details.join('; ')].filter(Boolean).join(': ');
  return text || fallback;
}

export async function postPaymentOperation(
  paymentId: string,
  operation: PaymentOperation,
  secretKey: string,
  /** refund only: the amount in halalas. Void takes no body. */
  amountHalalas: number | null,
  fetchImpl: FetchLike = fetch
): Promise<PaymentOperationResult> {
  if (!isMoyasarPaymentId(paymentId)) {
    return { ok: false, reason: 'invalid_id', httpStatus: null, body: null, message: 'Not a Moyasar payment id.' };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      Accept: 'application/json'
    };
    let body: string | undefined;
    if (operation === 'refund' && amountHalalas !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ amount: amountHalalas });
    }
    const res = await fetchImpl(`${MOYASAR_API}/payments/${encodeURIComponent(paymentId)}/${operation}`, {
      method: 'POST',
      headers,
      body,
      signal: abort.signal
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { unparsed: text.slice(0, 2000) };
    }

    if (res.ok) return { ok: true, httpStatus: res.status, body: parsed };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', httpStatus: res.status, body: parsed,
               message: moyasarErrorMessage(parsed, `Moyasar refused the API key (HTTP ${res.status}).`) };
    }
    if (res.status >= 500) {
      return { ok: false, reason: 'unavailable', httpStatus: res.status, body: parsed,
               message: moyasarErrorMessage(parsed, `Moyasar is unavailable (HTTP ${res.status}).`) };
    }
    return { ok: false, reason: 'rejected', httpStatus: res.status, body: parsed,
             message: moyasarErrorMessage(parsed, `Moyasar refused the ${operation} (HTTP ${res.status}).`) };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return {
      ok: false,
      reason: 'unavailable',
      httpStatus: null,
      body: null,
      message: name === 'AbortError' ? `Moyasar did not answer the ${operation} in time.` : `Could not reach Moyasar: ${String((err as Error)?.message ?? err)}`
    };
  } finally {
    clearTimeout(timer);
  }
}
