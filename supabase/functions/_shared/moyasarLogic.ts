/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision logic for Moyasar payments. Zero Deno/Supabase imports, so it
 * runs under tsx in moyasarLogic.test.ts — same arrangement as
 * auto-cancel-bookings/logic.ts.
 *
 * Who decides what:
 *   - Moyasar decides whether money moved: we only ever believe a payment we
 *     fetched ourselves with the secret key (never a browser's or a webhook
 *     body's claim).
 *   - confirm_booking_payment() (migration 0046) decides whether that money
 *     pays for the booking: currency, exact halalas, one payment per booking,
 *     place still free.
 *   - This file turns both into one answer for the customer's screen and, when
 *     money arrived that cannot be kept, one alert for staff.
 */

/** Moyasar payment ids are uuids. Anything else is refused before any request
 *  is made with the secret key. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMoyasarPaymentId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** 'test' | 'live' from a secret or publishable key prefix, else null. */
export function keyMode(key?: string | null): 'test' | 'live' | null {
  const k = String(key ?? '');
  if (/^(sk|pk)_test_/.test(k)) return 'test';
  if (/^(sk|pk)_live_/.test(k)) return 'live';
  return null;
}

/**
 * Checks the secret key against MOYASAR_MODE when that is set. Mixing a live
 * key into a test setup (or the reverse) fails silently otherwise: every
 * payment would simply be "not found".
 */
export function secretKeyProblem(secret?: string | null, expectedMode?: string | null): string | null {
  const mode = keyMode(secret);
  if (!mode || !String(secret).startsWith('sk_')) return 'MOYASAR_SECRET_KEY is missing or is not a secret key (sk_test_… / sk_live_…).';
  const expected = String(expectedMode ?? '').trim().toLowerCase();
  if (expected && expected !== mode) return `MOYASAR_SECRET_KEY is a ${mode} key but MOYASAR_MODE is "${expected}".`;
  return null;
}

/** The fields we use from a fetched Moyasar payment. */
export interface MoyasarPaymentFacts {
  id: string;
  /** initiated | paid | failed | authorized | captured | refunded | voided | verified | expired */
  status: string;
  /** Smallest unit (halalas for SAR). */
  amountHalalas: number | null;
  currency: string | null;
  /** metadata.booking_id, set by the payment step when it opens the form. */
  bookingId: string | null;
  sourceType: string | null;
  /** Moyasar's approval/decline message, e.g. "INSUFFICIENT FUNDS". */
  message: string | null;
}

export function readPayment(raw: unknown): MoyasarPaymentFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, any>;
  if (!isMoyasarPaymentId(p.id) || typeof p.status !== 'string') return null;
  const metadata = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
  const bookingId = typeof metadata.booking_id === 'string' && metadata.booking_id.trim()
    ? metadata.booking_id.trim()
    : null;
  const source = p.source && typeof p.source === 'object' ? p.source : {};
  return {
    id: p.id,
    status: p.status,
    amountHalalas: Number.isInteger(p.amount) ? p.amount : null,
    currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : null,
    bookingId,
    sourceType: typeof source.type === 'string' ? source.type : null,
    message: typeof source.message === 'string' ? source.message : null
  };
}

/**
 * What is kept of the fetched payment in booking_payments.raw. Moyasar already
 * masks card numbers; this keeps the audit-useful fields and drops the rest
 * (transaction URLs, tokens, IP).
 */
export function auditCopy(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const p = raw as Record<string, any>;
  const source = p.source && typeof p.source === 'object' ? p.source : {};
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    fee: p.fee,
    refunded: p.refunded,
    captured: p.captured,
    description: p.description,
    metadata: p.metadata,
    created_at: p.created_at,
    updated_at: p.updated_at,
    source: {
      type: source.type,
      company: source.company,
      name: source.name,
      number: source.number,   // masked by Moyasar
      message: source.message
    }
  };
}

/** What the customer's screen is told. */
export type VerifyState =
  | 'confirmed'      // booking is paid (deposit or full)
  | 'pending'        // payment not finished yet (3-D Secure under way)
  | 'failed'         // declined / failed / voided — booking still unpaid, can retry
  | 'needs_refund'   // money received, place gone: studio refunds
  | 'duplicate'      // money received twice / for an already-paid booking: studio refunds
  | 'mismatch'       // money received but not what this booking owes: studio checks
  | 'not_awaiting'   // booking no longer waiting for payment (cancelled by staff…): studio checks
  | 'not_found';     // no such payment, or it names no booking we know

/** Moyasar status -> state, for every payment that is NOT 'paid'. */
export function stateForUnpaidStatus(status: string): VerifyState {
  return status === 'initiated' ? 'pending' : 'failed';
}

/** confirm_booking_payment() outcomes, as listed in migration 0046. */
export type ConfirmOutcome =
  | 'confirmed' | 'confirmed_late' | 'already_confirmed' | 'needs_refund'
  | 'already_paid_other' | 'payment_used_elsewhere' | 'amount_mismatch'
  | 'not_awaiting' | 'not_found';

/**
 * Outcomes that are final for a given payment: asking again gives the same
 * answer, so verify-payment answers from booking_payments.outcome instead of
 * calling confirm_booking_payment() (and alerting staff) a second time.
 */
export const FINAL_FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  'already_paid_other', 'payment_used_elsewhere', 'amount_mismatch', 'not_awaiting', 'not_found'
]);

/**
 * The customer-facing state for an outcome. `bookingPaymentStatus` matters for
 * 'already_confirmed': a payment that already turned its booking into Needs
 * Refund is still a refund case when asked about again.
 */
export function stateForOutcome(outcome: string, bookingPaymentStatus?: string | null): VerifyState {
  switch (outcome) {
    case 'confirmed':
    case 'confirmed_late':
      return 'confirmed';
    case 'already_confirmed':
      return bookingPaymentStatus === 'Needs Refund' ? 'needs_refund' : 'confirmed';
    case 'needs_refund':
      return 'needs_refund';
    case 'already_paid_other':
    case 'payment_used_elsewhere':
      return 'duplicate';
    case 'amount_mismatch':
      return 'mismatch';
    case 'not_awaiting':
      return 'not_awaiting';
    default:
      return 'not_found';
  }
}

export interface StaffAlert {
  title: string;
  message: string;
}

/**
 * The staff notification for money that arrived and cannot simply be kept, for
 * the outcomes confirm_booking_payment() does NOT already alert on itself
 * (it alerts for needs_refund and already_paid_other).
 */
export function staffAlertFor(
  outcome: string,
  facts: Pick<MoyasarPaymentFacts, 'id' | 'amountHalalas' | 'currency' | 'bookingId'>
): StaffAlert | null {
  const amount = facts.amountHalalas === null ? '?' : (facts.amountHalalas / 100).toFixed(2);
  const money = `${amount} ${facts.currency ?? ''}`.trim();
  const booking = facts.bookingId ?? '(none)';
  switch (outcome) {
    case 'amount_mismatch':
      return {
        title: 'Online payment does not match its booking',
        message: `Moyasar payment ${facts.id} of ${money} does not match what booking ${booking} owes, so the booking was not marked paid. Check the booking, then refund the payment in the Moyasar dashboard or adjust the booking.`
      };
    case 'not_awaiting':
      return {
        title: 'Online payment for a booking that was not waiting',
        message: `Moyasar payment ${facts.id} of ${money} arrived for booking ${booking}, which was no longer waiting for payment (cancelled or changed by staff). Refund it in the Moyasar dashboard or rebook the customer.`
      };
    case 'payment_used_elsewhere':
      return {
        title: 'Online payment already used',
        message: `Moyasar payment ${facts.id} names booking ${booking} but already paid for a different booking. Nothing was changed. Check both bookings.`
      };
    case 'not_found':
      return {
        title: 'Online payment for an unknown booking',
        message: `Moyasar payment ${facts.id} of ${money} was paid but names booking ${booking}, which does not exist. Refund it in the Moyasar dashboard.`
      };
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Webhooks (https://docs.moyasar.com/api/other/webhooks/webhook-reference)
//
// Moyasar POSTs { id, type, created_at, secret_token, account_name, live,
// data } where data is the payment for payment_* events. The ONLY documented
// authenticity check is secret_token, the value set when the webhook was
// created in the dashboard; no signature header is documented. So the token
// is compared, and then — whatever the body says — the payment is fetched
// again from the API with the secret key before anything is decided.
// -----------------------------------------------------------------------------

/** Constant-time string comparison, so the token cannot be guessed by timing. */
export function tokensMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export type WebhookParse =
  | { kind: 'payment'; eventType: string; paymentId: string; live: boolean | null }
  | { kind: 'ignored'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * Reads a webhook body. Every payment_* event is treated the same way (fetch
 * and decide), so a misspelt or new event name — the docs list both
 * payment_failed and payment_faild, and payment_abandoned only in the API —
 * still works. Non-payment events (card_auth_*) are acknowledged and ignored.
 */
export function parseWebhook(body: unknown): WebhookParse {
  if (!body || typeof body !== 'object') return { kind: 'invalid', reason: 'body is not an object' };
  const b = body as Record<string, any>;
  const type = typeof b.type === 'string' ? b.type : '';
  if (!type.startsWith('payment_')) return { kind: 'ignored', reason: `event ${type || '(none)'}` };
  const paymentId = b.data && typeof b.data === 'object' ? b.data.id : undefined;
  if (!isMoyasarPaymentId(paymentId)) return { kind: 'invalid', reason: 'data.id is not a payment id' };
  return { kind: 'payment', eventType: type, paymentId, live: typeof b.live === 'boolean' ? b.live : null };
}

export type WebhookVerification =
  | { isVerification: false }
  | { isVerification: true; code: string | null };

/**
 * Moyasar's webhook verification event, sent when a webhook is added in the
 * dashboard: { type: 'webhook_verification', data: { verification_code } }.
 * It is handled before the secret_token check: the code is only logged so it
 * can be typed back into the dashboard, and no booking or payment data is
 * touched. The code is returned only if it looks like a short code, so a
 * crafted body cannot push arbitrary text into the logs.
 */
export function webhookVerification(body: unknown): WebhookVerification {
  if (!body || typeof body !== 'object') return { isVerification: false };
  const b = body as Record<string, any>;
  if (b.type !== 'webhook_verification') return { isVerification: false };
  const raw = b.data && typeof b.data === 'object' ? b.data.verification_code : undefined;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  return { isVerification: true, code: /^[A-Za-z0-9]{1,32}$/.test(code) ? code : null };
}
