/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Startup check that the database migrations have actually been applied.
 *
 * Without this, a missing migration shows up as an unrelated failure much
 * later — a booking that silently does not save, a queue number that collides.
 * Each expected object is probed by name so the message can say which file to
 * run.
 *
 * Read-only: every probe is a call that changes nothing. Never probe a
 * function that can insert or update — this runs on every page load.
 */

import { getDataClient } from './supabase';

export interface MigrationRequirement {
  /** The database object being probed. */
  name: string;
  /** The migration file that creates it. */
  migration: string;
  /** Runs the probe. Resolves true when the object exists. */
  probe: (client: NonNullable<ReturnType<typeof getDataClient>>) => Promise<boolean>;
}

/** PostgREST's code for "no such function". Anything else means it exists. */
const MISSING_FUNCTION = 'PGRST202';
/** ...and for "no such table/column". */
const MISSING_RELATION = 'PGRST205';

/** A function exists if calling it returns anything other than "not found". */
const rpcExists = (fn: string, args: Record<string, unknown>) =>
  async (client: NonNullable<ReturnType<typeof getDataClient>>) => {
    const { error } = await client.rpc(fn, args);
    if (!error) return true;
    return error.code !== MISSING_FUNCTION && !/could not find the function/i.test(error.message || '');
  };

/** A table exists if selecting from it returns anything other than "not found". */
const tableExists = (table: string, column = 'id') =>
  async (client: NonNullable<ReturnType<typeof getDataClient>>) => {
    const { error } = await client.from(table).select(column).limit(1);
    if (!error) return true;
    return error.code !== MISSING_RELATION && !/does not exist/i.test(error.message || '');
  };

/** A column exists if selecting it returns anything other than "not found". */
const columnExists = (table: string, column: string) =>
  async (client: NonNullable<ReturnType<typeof getDataClient>>) => {
    const { error } = await client.from(table).select(column).limit(1);
    if (!error) return true;
    return error.code !== MISSING_RELATION && !/does not exist/i.test(error.message || '');
  };

export const MIGRATION_REQUIREMENTS: MigrationRequirement[] = [
  // 0001 — schema.
  { name: 'workshop_sessions table', migration: '0001_init.sql', probe: tableExists('workshop_sessions') },
  { name: 'piece_history table', migration: '0001_init.sql', probe: tableExists('piece_history') },
  { name: 'pipeline_stages table', migration: '0001_init.sql', probe: tableExists('pipeline_stages') },
  {
    name: 'claim_customer_account()',
    migration: '0001_init.sql',
    probe: rpcExists('claim_customer_account', { identifier: '', new_auth_id: null })
  },
  {
    name: 'link_existing_customer()',
    migration: '0001_init.sql',
    probe: rpcExists('link_existing_customer', { identifier: '', new_auth_id: null })
  },

  // 0002 — atomic capacity and queue numbering.
  // book_session_seats() is intentionally not probed here: it is callable by
  // anon by design (real customers book before signing in), so proving it
  // exists without writing a booking means calling it with an invalid payload
  // and reading the resulting validation error. That error is a genuine HTTP
  // 400 the browser's own network panel logs regardless of how the app
  // handles it — noise on every page load for no benefit this file's other
  // three probes don't already give: one migration, one transaction, so any
  // of them existing proves book_session_seats() exists too.
  {
    name: 'release_booking_seats()',
    migration: '0002_capacity_rpc.sql',
    probe: rpcExists('release_booking_seats', { p_booking_id: '__probe__' })
  },
  {
    name: 'next_queue_number()',
    migration: '0002_capacity_rpc.sql',
    probe: rpcExists('next_queue_number', { p_date: '2026-01-01' })
  },
  {
    name: 'session_seats_remaining()',
    migration: '0002_capacity_rpc.sql',
    probe: rpcExists('session_seats_remaining', { p_session_id: '__probe__' })
  },

  // 0003 — the customer site's write path. Not probed: neither of its
  // functions can be called safely on every page load.
  // resolve_customer_record() is a find-or-create — the old empty-args probe
  // inserted a 'Guest' customer row on every visit (stopped server-side by
  // 0042). get_customer_summary() had EXECUTE revoked from anon by 0011, so an
  // anonymous probe is refused by design — a genuine HTTP 403 the browser's
  // network panel logs on every anonymous page load.

  // 0004 — staff assignment on a booking.
  {
    name: 'bookings.staff_id column',
    migration: '0004_booking_staff_assignment.sql',
    probe: tableExists('bookings', 'staff_id')
  },

  // 0005 — signing in with a phone number or an email address.
  {
    name: 'customer_signin_route()',
    migration: '0005_signin_by_phone_or_email.sql',
    probe: rpcExists('customer_signin_route', { identifier: '' })
  },
  {
    name: 'customer_signin_email()',
    migration: '0005_signin_by_phone_or_email.sql',
    probe: rpcExists('customer_signin_email', { p_identifier: '', p_password: '' })
  },
  {
    name: 'customer_claim_email_matches()',
    migration: '0005_signin_by_phone_or_email.sql',
    probe: rpcExists('customer_claim_email_matches', { p_identifier: '', p_email: '' })
  },

  // 0006 — the four-stage pottery pipeline. Without it the stage rows are still
  // duplicated and pieces.status still rejects the new stage names.
  {
    name: 'pieces.workshop_id column',
    migration: '0006_piece_pipeline_v2.sql',
    probe: columnExists('pieces', 'workshop_id')
  }
];

export interface MigrationCheckResult {
  ok: boolean;
  /** One line per missing object, naming the file that creates it. */
  problems: string[];
  /** The migration files that need running, in order. */
  missingMigrations: string[];
  /** True when the check could not run at all (no client configured). */
  skipped: boolean;
}

/**
 * Probes every expected object. Never throws: a failure here must not stop the
 * app from loading, only report itself.
 */
export async function checkMigrations(): Promise<MigrationCheckResult> {
  const client = getDataClient();
  if (!client) {
    return { ok: true, problems: [], missingMigrations: [], skipped: true };
  }

  const problems: string[] = [];
  const missing = new Set<string>();

  await Promise.all(MIGRATION_REQUIREMENTS.map(async requirement => {
    try {
      const exists = await requirement.probe(client);
      if (!exists) {
        problems.push(`Migration ${requirement.migration} not applied: ${requirement.name} missing`);
        missing.add(requirement.migration);
      }
    } catch (err: any) {
      // An unreachable database is not a missing migration; do not cry wolf.
      console.warn(`Could not probe ${requirement.name}:`, err?.message);
    }
  }));

  // Report in migration order so the fix is "run these, in this order".
  const missingMigrations = [...missing].sort();
  problems.sort();

  return { ok: problems.length === 0, problems, missingMigrations, skipped: false };
}
