/**
 * Build-time feature flags.
 *
 * Written as the literal `import.meta.env.VITE_...` so Vite substitutes the
 * value at build time (see lib/supabase.ts for the same reasoning).
 */

/**
 * Phone sign-in by SMS code (sign-up, walk-in claim, password reset).
 *
 * OFF unless VITE_PHONE_AUTH is exactly "true". While off, every phone-auth
 * path is skipped and the app behaves exactly as before it existed. Turn it
 * on only once migration 0041 is applied, the Phone provider and the Send SMS
 * hook are configured, and the OTP template is approved.
 */
export const PHONE_AUTH_ENABLED: boolean = import.meta.env.VITE_PHONE_AUTH === 'true';

/**
 * Whether this build contains the Moyasar payment step.
 *
 * TRUE since the Moyasar payment step and its return page shipped. Turning on
 * Settings -> Online Payments makes the database hold every customer booking
 * as 'Awaiting Payment' (migration 0046); with no payment step to complete it,
 * each one would expire unpaid. So the Settings switch refuses to turn on until
 * this is true AND a publishable key is configured. Turning it OFF is always
 * allowed.
 */
export const ONLINE_CHECKOUT_SHIPPED = true;

/** Moyasar publishable key (pk_test_… / pk_live_…). Public by design; the secret
 *  key lives only in the Edge Function environment as MOYASAR_SECRET_KEY. */
export const MOYASAR_PUBLISHABLE_KEY: string = import.meta.env.VITE_MOYASAR_PUBLISHABLE_KEY || '';

/** True when online payments can be switched on from Settings. */
export const ONLINE_PAYMENTS_AVAILABLE: boolean =
  ONLINE_CHECKOUT_SHIPPED && /^pk_(test|live)_/.test(MOYASAR_PUBLISHABLE_KEY);
