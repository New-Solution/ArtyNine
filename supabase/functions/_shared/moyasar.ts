/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Moyasar API, server side. The only place MOYASAR_SECRET_KEY is used to
 * make a request: it is passed in by the caller (verify-payment,
 * auto-cancel-bookings), which reads it from its Edge Function environment.
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
