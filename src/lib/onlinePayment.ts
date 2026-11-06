/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The browser side of online payments (Moyasar).
 *
 * What the browser is trusted with: nothing that decides money. It asks the
 * database for the amount a held booking owes (booking_payment_quote, 0046),
 * opens Moyasar's form for that amount with the booking id in metadata, and
 * hands the resulting payment id to verify-payment. Whether the booking is
 * paid is decided server-side, from Moyasar's own record.
 *
 * MOYASAR.JS
 * Loaded on demand from jsDelivr, as Moyasar's docs do
 * (https://docs.moyasar.com/guides/card-payments/basic-integration), but
 * pinned to an exact version with Subresource Integrity rather than "latest".
 * The static `moyasar.umd.js` is used, not `.min.js`: jsDelivr generates the
 * min file on request and warns against SRI on generated files. To upgrade,
 * change the version and both hashes together:
 *   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
 */

import { getDataClient, supabase } from './supabase';

export const MOYASAR_FORM_VERSION = '2.3.0';
const CDN = `https://cdn.jsdelivr.net/npm/moyasar-payment-form@${MOYASAR_FORM_VERSION}/dist`;
export const MOYASAR_JS_URL = `${CDN}/moyasar.umd.js`;
export const MOYASAR_CSS_URL = `${CDN}/moyasar.css`;
const MOYASAR_JS_SRI = 'sha384-zaoyfKoayFfcaZQLYxWEYqjG/of8gAw5lYVmKz68FG4j8tm27LqmqNFuIPlNtdLd';
const MOYASAR_CSS_SRI = 'sha384-kXA6TcBKVzqpjpsbaJciletoxOQ3kNhUKCCMPpZaXA2MOhJMTaqVspZdFxXo5iTA';

/** The subset of the Moyasar.init config used here (form v2.3.0). */
export interface MoyasarInitConfig {
  element: string | HTMLElement;
  amount: number;            // halalas
  currency: 'SAR';
  description: string;
  publishable_api_key: string;
  callback_url: string;
  methods: string[];
  supported_networks?: string[];
  language?: 'en' | 'ar';
  metadata?: Record<string, string>;
  fixed_width?: boolean;
  apple_pay?: { country: string; label: string; validate_merchant_url?: string };
  on_completed?: (payment: { id: string; status: string }) => Promise<void>;
  on_failure?: (error: unknown) => Promise<void>;
}

interface MoyasarGlobal {
  init(config: MoyasarInitConfig): void;
}

declare global {
  interface Window {
    Moyasar?: MoyasarGlobal;
  }
}

let loading: Promise<MoyasarGlobal> | null = null;

/** Loads Moyasar.js and its stylesheet once. Rejects if the CDN is unreachable
 *  or the file does not match its integrity hash. */
export function loadMoyasar(): Promise<MoyasarGlobal> {
  if (window.Moyasar) return Promise.resolve(window.Moyasar);
  if (loading) return loading;

  loading = new Promise<MoyasarGlobal>((resolve, reject) => {
    if (!document.querySelector(`link[href="${MOYASAR_CSS_URL}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = MOYASAR_CSS_URL;
      link.integrity = MOYASAR_CSS_SRI;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }

    const script = document.createElement('script');
    script.src = MOYASAR_JS_URL;
    script.integrity = MOYASAR_JS_SRI;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => (window.Moyasar ? resolve(window.Moyasar) : reject(new Error('Moyasar.js loaded without Moyasar')));
    script.onerror = () => reject(new Error('Moyasar.js could not be loaded'));
    document.head.appendChild(script);
  }).catch(err => {
    loading = null; // allow a retry
    throw err;
  });

  return loading;
}

/**
 * Methods offered in the form. Cards (mada, Visa, Mastercard) by default.
 * Apple Pay needs the domain registered in the Moyasar dashboard (Settings →
 * Apple Pay Domains, file at /.well-known/apple-developer-merchantid-domain-association)
 * and STC Pay needs Moyasar to enable it on the account — add them through
 * VITE_MOYASAR_METHODS (e.g. "creditcard,applepay,stcpay") once done.
 */
const SUPPORTED_METHODS = ['creditcard', 'applepay', 'stcpay'];
export const MOYASAR_METHODS: string[] = (() => {
  const raw = String(import.meta.env.VITE_MOYASAR_METHODS || 'creditcard');
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(m => SUPPORTED_METHODS.includes(m));
  return list.length ? Array.from(new Set(list)) : ['creditcard'];
})();

/** What the database says a held booking owes. Null when it is not (or no
 *  longer) an unexpired hold. */
export interface PaymentQuote {
  amountHalalas: number;
  amount: number;
  totalPrice: number;
  mode: 'deposit' | 'full';
  expiresAt: string;
}

export async function fetchPaymentQuote(bookingId: string): Promise<PaymentQuote | null> {
  const client = getDataClient();
  if (!client) throw new Error('Supabase is not configured.');
  const { data, error } = await client.rpc('booking_payment_quote', { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !Number.isInteger(row.online_amount_halalas)) return null;
  return {
    amountHalalas: row.online_amount_halalas,
    amount: Number(row.online_amount),
    totalPrice: Number(row.total_price),
    mode: row.payment_mode === 'full' ? 'full' : 'deposit',
    expiresAt: row.payment_expires_at
  };
}

/** verify-payment's answer. See supabase/functions/verify-payment/contract.ts. */
export type VerifyState =
  | 'confirmed' | 'pending' | 'failed' | 'needs_refund' | 'duplicate'
  | 'mismatch' | 'not_awaiting' | 'not_found';

export interface VerifiedBooking {
  id: string;
  workshopTitle: string | null;
  date: string | null;
  time: string | null;
  participants: number | null;
  paymentStatus: string | null;
  paymentMode: string | null;
  onlineAmount: number | null;
  totalPrice: number | null;
}

export type VerifyOutcome =
  | { ok: true; state: VerifyState; bookingId: string | null; message: string | null; booking?: VerifiedBooking }
  | { ok: false; error: string };

/**
 * Asks verify-payment to check a payment with Moyasar. Never throws. Safe to
 * call repeatedly for the same payment (the server is idempotent).
 */
export async function verifyPayment(paymentId: string): Promise<VerifyOutcome> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  try {
    const { data, error } = await supabase.functions.invoke('verify-payment', { body: { paymentId } });
    let body: any = data;
    if (error) {
      // Non-2xx: the JSON body is still the function's answer when there is one.
      try {
        body = await (error as any)?.context?.json?.();
      } catch {
        body = null;
      }
      if (!body) return { ok: false, error: error.message || 'verify-payment failed' };
    }
    if (!body?.success) return { ok: false, error: String(body?.error || 'verify-payment failed') };
    return {
      ok: true,
      state: body.state as VerifyState,
      bookingId: body.bookingId ?? null,
      message: body.message ?? null,
      booking: body.booking ?? undefined
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// -----------------------------------------------------------------------------
// The return trip. 3-D Secure leaves the site and comes back to callback_url
// with ?payment=return&id=<payment id>&status=…&message=…. React state is gone
// by then, so the little needed to finish is kept in sessionStorage. It is a
// convenience only: the payment id in the URL is enough on its own.
// -----------------------------------------------------------------------------

export const PAYMENT_RETURN_PARAM = 'payment';
export const PAYMENT_RETURN_VALUE = 'return';
const PENDING_KEY = 'arty_pending_payment';

export interface PendingPayment {
  bookingId: string;
  /** What the customer was booking, for the confirmation screen. */
  workshopId?: string;
  isBirthday?: boolean;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  startedAt: number;
}

export function rememberPendingPayment(p: PendingPayment) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage: the URL still carries the payment id */
  }
}

export function readPendingPayment(): PendingPayment | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p.bookingId === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function forgetPendingPayment() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** The page Moyasar returns to. Same page, marked so startup recognises it. */
export function paymentCallbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}?${PAYMENT_RETURN_PARAM}=${PAYMENT_RETURN_VALUE}`;
}

/** The payment id when this page load is a return from Moyasar, else null. */
export function readPaymentReturn(search: string = window.location.search): string | null {
  const params = new URLSearchParams(search);
  if (params.get(PAYMENT_RETURN_PARAM) !== PAYMENT_RETURN_VALUE) return null;
  const id = params.get('id');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** Removes the return parameters so a refresh does not re-run the return. */
export function clearPaymentReturnFromUrl() {
  try {
    const url = new URL(window.location.href);
    for (const k of [PAYMENT_RETURN_PARAM, 'id', 'status', 'message']) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* ignore */
  }
}
