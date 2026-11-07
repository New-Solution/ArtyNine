/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The fixed strings handed to Moyasar.init, and a check that they pass
 * Moyasar.js's own validation. Pure: no DOM, no Vite env, so it runs under tsx
 * (moyasarConfig.test.ts).
 *
 * Why: moyasar-payment-form 2.3.0 validates apple_pay.label against
 * /^[\x20-\x7E]+$/ (printable ASCII; "should be English characters only").
 * A label that fails, such as 'Arty Café', makes Moyasar.init draw its own
 * "Form configuration issue!" box in place of the WHOLE form, cards
 * included. Anything we pass that a customer could see or that Moyasar might
 * validate is kept to printable ASCII: never a workshop title or other text
 * that could be Arabic.
 */

/** Moyasar.js 2.3.0's test for apple_pay.label / payment_options.label. */
export const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export const isPrintableAscii = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && PRINTABLE_ASCII.test(value);

/** Shown on the Apple Pay sheet. Printable ASCII only (see above). */
export const MOYASAR_APPLE_PAY = {
  country: 'SA',
  label: 'Arty Cafe',
  validate_merchant_url: 'https://api.moyasar.com/v1/applepay/initiate'
} as const;

/**
 * The payment description in the studio's Moyasar dashboard. Built from the
 * booking id only (ART-1234567), never a workshop title, and anything outside
 * printable ASCII is dropped in case an id ever is not.
 */
export function moyasarDescription(bookingId: string): string {
  const safeId = String(bookingId ?? '').replace(/[^\x20-\x7E]/g, '').trim();
  return safeId ? `Arty booking ${safeId}` : 'Arty booking';
}

/**
 * The first string field of a Moyasar config that Moyasar.js would reject or
 * that is not printable ASCII, as a message for the console; null when all is
 * well. Checked before Moyasar.init so a bad value shows our own error.
 */
export function moyasarConfigProblem(config: {
  description?: unknown;
  apple_pay?: { label?: unknown; country?: unknown } | null;
}): string | null {
  if (!isPrintableAscii(config.description)) {
    return `Moyasar description must be non-empty printable ASCII, got ${JSON.stringify(config.description)}`;
  }
  if (config.apple_pay) {
    if (!isPrintableAscii(config.apple_pay.label)) {
      return `Moyasar apple_pay.label must be non-empty printable ASCII, got ${JSON.stringify(config.apple_pay.label)}`;
    }
    if (typeof config.apple_pay.country !== 'string' || !/^[A-Z]{2}$/.test(config.apple_pay.country)) {
      return `Moyasar apple_pay.country must be a two-letter code, got ${JSON.stringify(config.apple_pay.country)}`;
    }
  }
  return null;
}
