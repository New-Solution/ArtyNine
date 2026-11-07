/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Moyasar evidence log (migration 0047, public.moyasar_payment_events):
 * every payment response and webhook body exactly as Moyasar sent it, kept
 * for disputes. Append-only; written by the service role only.
 *
 * WHAT GOES IN `raw`
 *   - verify-payment / return-page: the full JSON body of
 *     GET /v1/payments/{id}, unmodified.
 *   - webhook: the full webhook body with `secret_token` removed (at any
 *     depth). That is the only change.
 * Card data: Moyasar's API never returns a full card number or a CVC. A
 * payment's source.number is already masked by Moyasar (e.g.
 * "4111-11XX-XXXX-1111"), and that is all we store. Nothing is ever added
 * to raw, and neither MOYASAR_SECRET_KEY nor MOYASAR_WEBHOOK_SECRET is passed
 * to anything in this file. The table's CHECK constraint refuses a raw that
 * contains a secret_token key, as a second line of defence.
 *
 * NEVER CHANGES A PAYMENT RESULT. recordPaymentEvidence() never throws: any
 * failure (database error, thrown exception) is written to the function log
 * and ignored. Callers await it only so the Edge runtime does not cut the
 * insert short.
 *
 * No Deno/npm imports, so moyasarLogic.test.ts runs it under tsx.
 */

export type EvidenceSource = 'verify-payment' | 'webhook' | 'return-page';

export interface PaymentEvidenceRow {
  booking_id: string | null;
  moyasar_payment_id: string | null;
  source: EvidenceSource;
  event_type: string | null;
  status: string | null;
  amount_halalas: number | null;
  currency: string | null;
  raw: unknown;
}

/** The subset of a supabase-js client this uses. */
export interface EvidenceClient {
  from(table: string): any;
}

export const EVIDENCE_TABLE = 'moyasar_payment_events';

/** Postgres foreign_key_violation: booking_id names a booking we don't have. */
const FK_VIOLATION = '23503';

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A deep copy of `value` with every `secret_token` key removed. */
export function withoutSecretToken(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecretToken);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'secret_token') continue;
    out[k] = withoutSecretToken(v);
  }
  return out;
}

/** The indexed columns, read leniently from a Moyasar payment object. */
function paymentColumns(p: unknown) {
  const payment = isObject(p) ? p : {};
  const metadata = isObject(payment.metadata) ? payment.metadata : {};
  const bookingId = typeof metadata.booking_id === 'string' && metadata.booking_id.trim()
    ? metadata.booking_id.trim()
    : null;
  return {
    booking_id: bookingId,
    moyasar_payment_id: typeof payment.id === 'string' ? payment.id : null,
    status: typeof payment.status === 'string' ? payment.status : null,
    amount_halalas: Number.isInteger(payment.amount) ? payment.amount as number : null,
    currency: typeof payment.currency === 'string' ? payment.currency.toUpperCase() : null
  };
}

/** A row for a payment fetched from GET /v1/payments/{id}. `raw` is the body as returned. */
export function fetchedPaymentEvidence(source: 'verify-payment' | 'return-page', payment: unknown): PaymentEvidenceRow {
  return {
    ...paymentColumns(payment),
    source,
    event_type: null,
    // jsonb NOT NULL: a body that parsed to JSON null is still recorded.
    raw: payment === null || payment === undefined ? { unparsed: null } : payment
  };
}

/** A row for a webhook body that passed the secret_token check. secret_token is removed. */
export function webhookEvidence(body: unknown): PaymentEvidenceRow {
  const b = isObject(body) ? body : {};
  return {
    ...paymentColumns(b.data),
    source: 'webhook',
    event_type: typeof b.type === 'string' ? b.type : null,
    raw: withoutSecretToken(body ?? {})
  };
}

/**
 * Inserts one evidence row. Never throws and returns nothing a caller could
 * branch on. If booking_id names a booking that does not exist (the foreign
 * key refuses it), the row is stored again with booking_id null — the
 * evidence matters more than the link; the booking id is still in raw.
 */
export async function recordPaymentEvidence(
  admin: EvidenceClient,
  row: PaymentEvidenceRow,
  log: (msg: string) => void = (m) => console.error(m)
): Promise<void> {
  try {
    let { error } = await admin.from(EVIDENCE_TABLE).insert(row);
    if (error && error.code === FK_VIOLATION && row.booking_id) {
      ({ error } = await admin.from(EVIDENCE_TABLE).insert({ ...row, booking_id: null }));
    }
    if (error) {
      log(`recordPaymentEvidence: storing ${row.source} evidence for ${row.moyasar_payment_id ?? '(no payment id)'} failed: ${error.message}`);
    }
  } catch (err) {
    log(`recordPaymentEvidence: storing ${row.source} evidence for ${row.moyasar_payment_id ?? '(no payment id)'} threw: ${String((err as Error)?.message ?? err)}`);
  }
}
