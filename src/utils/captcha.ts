/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cloudflare Turnstile for Supabase Auth CAPTCHA.
 *
 * OFF unless VITE_TURNSTILE_SITE_KEY is set. While off, no script is loaded,
 * no widget is rendered, and every auth call sends `captchaToken: undefined` —
 * which auth-js already sends today (it always includes gotrue_meta_security,
 * and JSON drops the undefined value), so requests are byte-for-byte the same.
 *
 * Once Supabase Auth CAPTCHA is switched on in the dashboard, signUp,
 * signInWithPassword, signInWithOtp and resetPasswordForEmail are refused
 * without a valid token. Each token is single-use, so every auth call asks for
 * a fresh one (see TokenSlot).
 *
 * DOM-free on purpose so the token handling can be tested with plain tsx; the
 * widget itself is components/Turnstile.tsx.
 */

export const TURNSTILE_SITE_KEY: string = (import.meta.env?.VITE_TURNSTILE_SITE_KEY ?? '').trim();

export const CAPTCHA_ENABLED: boolean = TURNSTILE_SITE_KEY !== '';

/**
 * Returns a fresh, unused token for ONE auth call — or undefined when CAPTCHA
 * is off, or the check did not pass in time (the widget then says so itself,
 * and Supabase refuses the call with a captcha error).
 */
export type CaptchaProvider = () => Promise<string | undefined>;

/** How long an auth call waits for the widget to produce a token. */
export const CAPTCHA_WAIT_MS = 20_000;

/**
 * Holds at most one unused token. `take()` hands it out (or waits for the next
 * one) and fires `onTaken`, which the widget uses to reset itself so the next
 * call gets a new token — Cloudflare accepts each token exactly once.
 */
export class TokenSlot {
  private token: string | null = null;
  private waiters: Array<(token: string | undefined) => void> = [];
  /** The token was handed out: reset the widget for the next one. */
  onTaken: (() => void) | null = null;
  /** A call gave up waiting: tell the visitor to complete the check. */
  onTimeout: (() => void) | null = null;

  /** The widget produced a token. */
  put(token: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(token);
      this.onTaken?.();
    } else {
      this.token = token;
    }
  }

  /** The token expired or the widget was reset/removed. */
  clear(): void {
    this.token = null;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  take(timeoutMs: number = CAPTCHA_WAIT_MS): Promise<string | undefined> {
    if (this.token !== null) {
      const token = this.token;
      this.token = null;
      this.onTaken?.();
      return Promise.resolve(token);
    }
    return new Promise(resolve => {
      const waiter = (token: string | undefined) => {
        clearTimeout(timer);
        resolve(token);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        this.onTimeout?.();
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

/** Supabase Auth refused the call because the CAPTCHA token was missing or invalid. */
export function isCaptchaError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === 'captcha_failed' || /captcha/i.test(error.message || '');
}

/** Shown when Supabase refused an auth call for its CAPTCHA. */
export const CAPTCHA_FAILED_MESSAGE = 'Please complete the security check, then try again.';
