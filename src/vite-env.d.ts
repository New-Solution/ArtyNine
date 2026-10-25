/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Cross-domain link target for "Customer Site" / "Back to Customer Site". Unset in local dev. */
  readonly VITE_CUSTOMER_SITE_URL?: string;
  /** Cross-domain link target for "Staff Login". Unset in local dev. */
  readonly VITE_STAFF_SITE_URL?: string;
  /** "true" turns on phone sign-in by SMS code (src/utils/featureFlags.ts). Unset = off. */
  readonly VITE_PHONE_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
