/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Online payments (Moyasar): the setting, and how payment statuses are read.
 *
 * THE SETTING — app_settings id 'onlinePayments'
 * Read here for display and for the Settings card. The database reads the SAME
 * row through online_payments_config() (migration 0046) and that is what is
 * actually enforced: the amount charged is computed server-side, never from
 * what this file or the browser says. normalizeOnlinePayments() mirrors that
 * function's defaults and fallbacks exactly, so the two cannot show different
 * values for the same stored row. Change them together.
 */

/** How a booking type is paid online. */
export type OnlinePaymentMode = 'deposit' | 'full';

export interface OnlinePaymentKindConfig {
  /** 'deposit': charge min(depositAmount, price), never refunded on a customer
   *  cancellation. 'full': charge the full price; the >24h refund rule applies. */
  mode: OnlinePaymentMode;
  /** SAR. Used only when mode is 'deposit'. */
  depositAmount: number;
}

export interface OnlinePaymentsConfig {
  /** The single switch. Off: checkout behaves exactly as before 0046. */
  enabled: boolean;
  /** How long an unpaid booking holds its seat or slot. 5–120. */
  holdMinutes: number;
  workshop: OnlinePaymentKindConfig;
  birthday: OnlinePaymentKindConfig;
}

export const ONLINE_PAYMENTS_SETTING_ID = 'onlinePayments';

export const HOLD_MINUTES_MIN = 5;
export const HOLD_MINUTES_MAX = 120;
export const DEFAULT_HOLD_MINUTES = 15;
export const DEFAULT_DEPOSIT_SAR = 100;

/** Seeded by 0046. Workshop: 100 SAR non-refundable deposit. Birthday: full price. */
export const DEFAULT_ONLINE_PAYMENTS: OnlinePaymentsConfig = {
  enabled: false,
  holdMinutes: DEFAULT_HOLD_MINUTES,
  workshop: { mode: 'deposit', depositAmount: DEFAULT_DEPOSIT_SAR },
  birthday: { mode: 'full', depositAmount: DEFAULT_DEPOSIT_SAR }
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function normalizeKind(raw: unknown, fallbackMode: OnlinePaymentMode): OnlinePaymentKindConfig {
  const kind = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mode: OnlinePaymentMode = kind.mode === 'deposit' || kind.mode === 'full' ? kind.mode : fallbackMode;
  const depositAmount = isNumber(kind.depositAmount) && kind.depositAmount >= 1
    ? Math.round(kind.depositAmount * 100) / 100
    : DEFAULT_DEPOSIT_SAR;
  return { mode, depositAmount };
}

/**
 * The stored setting with every field type-checked, the way
 * online_payments_config() does it: a wrong type falls back to its default
 * rather than being coerced (the string "50" is not 50).
 */
export function normalizeOnlinePayments(raw: unknown): OnlinePaymentsConfig {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const holdMinutes = isNumber(v.holdMinutes)
    ? Math.min(Math.max(Math.floor(v.holdMinutes), HOLD_MINUTES_MIN), HOLD_MINUTES_MAX)
    : DEFAULT_HOLD_MINUTES;
  return {
    enabled: v.enabled === true,
    holdMinutes,
    workshop: normalizeKind(v.workshop, 'deposit'),
    birthday: normalizeKind(v.birthday, 'full')
  };
}

// -----------------------------------------------------------------------------
// Payment statuses
// -----------------------------------------------------------------------------

/**
 * Every payment_status the system writes. 'Awaiting Payment', 'Expired' and
 * 'Needs Refund' are written only by the database (0046) and the auto-cancel
 * job, never by the browser.
 */
export const PAYMENT_STATUSES = [
  'Paid',
  'Deposit Paid',
  'Unpaid',
  'Awaiting Payment',
  'Needs Refund',
  'Refunded',
  'Expired'
] as const;

export type PaymentStatus = typeof PAYMENT_STATUSES[number];

/**
 * How a payment status should look, independent of any one table's colours.
 *   paid       money received (in full, or the deposit)
 *   waiting    an online hold the customer is paying for right now
 *   attention  staff must act: money received that has to go back
 *   refunded   money returned
 *   closed     nothing owed, nothing held (an expired hold)
 *   unpaid     owed, not received
 */
export type PaymentTone = 'paid' | 'waiting' | 'attention' | 'refunded' | 'closed' | 'unpaid';

export function paymentTone(status?: string | null): PaymentTone {
  switch (status) {
    case 'Paid':
    case 'Deposit Paid':
      return 'paid';
    case 'Awaiting Payment':
      return 'waiting';
    case 'Needs Refund':
      return 'attention';
    case 'Refunded':
      return 'refunded';
    case 'Expired':
      return 'closed';
    default:
      return 'unpaid';
  }
}

/** Money has been received for this booking (deposit or full). */
export function isPaidStatus(status?: string | null): boolean {
  return status === 'Paid' || status === 'Deposit Paid';
}

/**
 * An online hold whose time has run out. It no longer holds a seat (the
 * database stops counting it at payment_expires_at), even before the
 * auto-cancel job has marked it Expired.
 */
export function isLapsedHold(
  booking: { paymentStatus?: string | null; paymentExpiresAt?: string | null },
  nowMs: number = Date.now()
): boolean {
  if (booking.paymentStatus !== 'Awaiting Payment' || !booking.paymentExpiresAt) return false;
  const expires = Date.parse(booking.paymentExpiresAt);
  return Number.isFinite(expires) && expires <= nowMs;
}

/** SAR -> halalas, as Moyasar and the database count it. Never via floats alone. */
export function toHalalas(sar: number): number {
  return Math.round(sar * 100);
}

// -----------------------------------------------------------------------------
// The amount shown BEFORE a booking is held
// -----------------------------------------------------------------------------

/**
 * A package's full price, the way online_payment_terms() (0046) computes it:
 * 'Fixed price' is the price, anything else is price x guests.
 */
export function birthdayFullPrice(pkg: { price?: number; pricingType?: string } | undefined, guests: number): number {
  if (!pkg) return 0;
  const price = Number(pkg.price) || 0;
  return pkg.pricingType === 'Fixed price' ? price : price * Math.max(1, Math.floor(guests) || 1);
}

/**
 * What the payment step expects to charge, for display before the hold
 * exists. Mirrors online_payment_terms(): deposit = min(deposit, full price).
 * The figure actually charged is the database's (booking_payment_quote), read
 * once the hold is created; this only has to agree with it, not decide it.
 */
export function estimateOnlineAmount(
  fullPrice: number,
  kind: OnlinePaymentKindConfig
): { mode: OnlinePaymentMode; dueNow: number; balance: number } {
  const total = Math.max(0, Math.round((Number(fullPrice) || 0) * 100) / 100);
  const dueNow = kind.mode === 'deposit' ? Math.min(kind.depositAmount, total) : total;
  return { mode: kind.mode, dueNow, balance: Math.round((total - dueNow) * 100) / 100 };
}
