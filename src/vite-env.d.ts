/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Where "View Customer Site" goes from a dedicated staff hostname (staff.*). Ignored on any other host. */
  readonly VITE_CUSTOMER_SITE_URL?: string;
  /** "true" turns on phone sign-in by SMS code (src/utils/featureFlags.ts). Unset = off. */
  readonly VITE_PHONE_AUTH?: string;
  /** Cloudflare Turnstile site key for Supabase Auth CAPTCHA (src/utils/captcha.ts). Unset = no CAPTCHA. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** Moyasar publishable key (pk_test_… / pk_live_…). Unset = online payments cannot be switched on. */
  readonly VITE_MOYASAR_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
