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
