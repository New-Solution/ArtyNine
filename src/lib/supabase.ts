/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single Supabase client for the app.
 *
 * Supabase Auth owns credentials and, from Stage 2, Postgres owns the
 * application data as well.
 *
 * Only the anon key is ever used here. The service_role key must never appear
 * in frontend code — it bypasses Row Level Security.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Read from Vite's env when bundled, and from process.env when this module is
 * loaded outside Vite (Node scripts, the test runner). Reading `import.meta`
 * unguarded threw at import time there, taking down every module that imports
 * the client.
 */
// Written as the literal `import.meta.env.VITE_...` because that exact text is
// what Vite substitutes at build time. Any indirection — optional chaining, a
// dynamic key — defeats the replacement and leaves it undefined in the browser.
const viteEnv: Record<string, string | undefined> = (() => {
  try {
    return {
      VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY
    };
  } catch {
    return {};   // not running under Vite (Node scripts, the test runner)
  }
})();

function readEnv(name: string): string | undefined {
  if (viteEnv[name]) return viteEnv[name];
  if (typeof process !== 'undefined' && process.env && process.env[name]) {
    return process.env[name];
  }
  return undefined;
}

/** The public settings, for callers that need their own client (the test suite). */
export function readPublicEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string | undefined {
  return readEnv(name);
}

const url = readEnv('VITE_SUPABASE_URL');
const anonKey = readEnv('VITE_SUPABASE_ANON_KEY');

/**
 * True when the project has been configured. Until then reads return empty
 * lists and sign-in reports a clear configuration error, rather than throwing
 * at import time.
 */
export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * Two clients, two sessions.
 *
 * A browser holds one Supabase session per storage key. With a single client,
 * signing in on the customer site replaced the staff session — the console then
 * lost every staff-only read (staff list, bookings, queue) because RLS saw an
 * ordinary customer. Giving the staff console its own storage key keeps the
 * two apart.
 *
 * Since customers and staff share one domain, only ONE role is signed in per
 * browser at a time: signing in as a customer ends the staff session here and
 * vice versa (AppContext, "ONE ROLE AT A TIME"). Customer-site bookings also
 * never go through getDataClient(); they always use `supabase`, the customer's
 * own session, and are refused while a staff session is present.
 */
const makeClient = (storageKey?: string) =>
  createClient(url!, anonKey!, {
    auth: {
      // Supabase persists and refreshes the session itself; the app no
      // longer keeps its own copy of the login state.
      persistSession: true,
      autoRefreshToken: true,
      // Only ONE client may read the token out of the URL. A recovery or
      // confirmation token is single-use: with both clients detecting it they
      // race, one consumes it and the other reports the link as expired.
      detectSessionInUrl: !storageKey,
      ...(storageKey ? { storageKey } : {})
    }
  });

/** The customer site's client, and the default for public reads. */
export const supabase: SupabaseClient | null = isSupabaseConfigured ? makeClient() : null;

/** The staff console's client. Its session is stored separately. */
export const supabaseStaff: SupabaseClient | null =
  isSupabaseConfigured ? makeClient('arty-staff-auth') : null;

/**
 * Which client data reads and writes should use.
 *
 * While a staff member is signed in, everything goes through their session so
 * RLS grants the staff-only tables. Otherwise the customer/anon client is used.
 */
let staffSessionActive = false;
const clientListeners = new Set<() => void>();

/** Notified when the active session changes, so live reads can re-run. */
export function onDataClientChange(listener: () => void): () => void {
  clientListeners.add(listener);
  return () => clientListeners.delete(listener);
}

export function setStaffSessionActive(active: boolean) {
  if (staffSessionActive === active) return;
  staffSessionActive = active;
  // Re-read everything under the new session: the staff console sees rows that
  // an anonymous visitor cannot, and vice versa.
  clientListeners.forEach(listener => listener());
}

export function getDataClient(): SupabaseClient | null {
  return staffSessionActive ? supabaseStaff : supabase;
}

/**
 * Whether a staff member is signed in.
 *
 * The same flag getDataClient() switches on, exposed so callers can also choose
 * WHICH RELATION to read, not only which client to read it with. Some tables
 * are staff-only by policy and have a customer-facing view beside them; picking
 * between the two has to follow the session, exactly as the client does.
 *
 * Deliberately not derived from the current page: a customer must never reach a
 * staff-only relation because some other screen happened to set a tab.
 */
export function isStaffSessionActive(): boolean {
  return staffSessionActive;
}

export const SUPABASE_NOT_CONFIGURED =
  'Sign-in is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';

/** The signed-in auth user id, or null. */
export async function getAuthUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}
