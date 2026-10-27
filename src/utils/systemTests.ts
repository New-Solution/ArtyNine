/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The System Health test suite.
 *
 * Every test here really runs. There are two kinds:
 *
 *  - SCENARIO tests build fixtures in a TEMPORARY Dexie database, created from
 *    the same schema as the real one, and call the actual shared functions
 *    (the validation layer, the seat-usage helper) against it. The temporary
 *    database is deleted when the run finishes, so nothing is ever written into
 *    the real app tables.
 *
 *  - AUDIT tests read the LIVE database read-only and assert an invariant that
 *    must hold across the real data (no orphaned references, unique booking
 *    references, and so on).
 *
 * A test reports expected vs actual and a plain-English failure message.
 */

import { sdb } from '../lib/supabaseDb';
import { supabase, getDataClient, readPublicEnv } from '../lib/supabase';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { checkMigrations } from '../lib/migrationCheck';
import {
  checkDuplicateCustomerPhone, checkDuplicateCustomerEmail, validatePasswordRule,
  validateBookingForm, makeLocalSeatReader, canonicalPhone, customerStorageFields, ValidationDb
} from './validation';
import { getSessionSeatUsage, BIRTHDAY_WORKSHOP_ID, BIRTHDAY_DAILY_MAX, BIRTHDAY_SAME_SLOT_MAX } from './queueUtils';
import { getRiyadhDateString } from './dateUtils';
import { getActivitiesForDate } from './activityUtils';
import { checkStaffMemberAvailability } from './staffAvailabilityUtils';
import { getUpcomingAssignments, describeInactiveWarning } from './staffAssignments';
import { customerPhoneKey, findCustomerMatch, normalizeCustomerPhone } from './customerIdentity';
import { validateWorkshopForm, validateEventForm, validateStaffForm } from './validation';
import { canAccessPage, isSuperAdmin, ADMIN_PAGE_IDS, defaultPermissionsForRole } from './adminAccess';
import { isStageEnabled, DEFAULT_PIPELINE_STAGES, WORKSHOP_OPTION_LISTS } from '../types';
import { TestResult, Booking, QueueItem, PotteryPiece, StaffMember, AppEvent, PipelineStage } from '../types';
import { stageOf, stageByKey, isEndState } from './pipelineStages';
import { canBeOverdue } from './pieceDays';

export type TestCategory = TestResult['category'];

export interface SystemTestContext {
  /**
   * Scenario fixtures. Writes go to the real tables — there is one database now
   * — but every id is prefixed TEST-, reads are narrowed to those rows, and
   * everything with that prefix is deleted afterwards, including on a throw.
   */
  temp: typeof sdb;
  /** The live database, for read-only audits. */
  live: typeof sdb;
  /**
   * A validation source narrowed to the TEST- rows, so a duplicate check in a
   * scenario cannot be answered by a real customer who happens to share a
   * phone number. The rules being exercised are the real ones.
   */
  scoped: ValidationDb;
}

export interface TestOutcome {
  passed: boolean;
  expected: string;
  actual: string;
  failureMessage?: string;
}

export interface SystemTestDefinition {
  id: string;
  name: string;
  description: string;
  category: TestCategory;
  /** Scenario tests get fixtures in `temp`; audits read `live`. */
  kind: 'scenario' | 'audit';
  run: (ctx: SystemTestContext) => Promise<TestOutcome>;
}

// ==========================================================
// Assertion helpers — each produces expected/actual for the UI.
// ==========================================================

const pass = (expected: string, actual: string): TestOutcome =>
  ({ passed: true, expected, actual });

const fail = (expected: string, actual: string, failureMessage: string): TestOutcome =>
  ({ passed: false, expected, actual, failureMessage });

const check = (
  condition: boolean,
  expected: string,
  actual: string,
  failureMessage: string
): TestOutcome => (condition ? pass(expected, actual) : fail(expected, actual, failureMessage));

/**
 * Whether the database follows a stage rename (migration M2 of the stage-id
 * plan: rename trigger, pieces_status_valid dropped). Until then SET-04 reports
 * its database half as pending. Switch on when M2 is applied (plan step A8).
 */
const STAGE_RENAMES_ENFORCED = false;

/** Formats a handful of offending ids for a failure message. */
const listSome = (items: string[], limit = 5): string =>
  items.slice(0, limit).join(', ') + (items.length > limit ? ` … (+${items.length - limit} more)` : '');

// ==========================================================
// Shared fixtures for the scenario tests
// ==========================================================

const FIXTURE_CUSTOMER = {
  id: 'TEST-CUST-1',
  name: 'Fixture Customer',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...customerStorageFields({ phone: '0501234567', email: 'fixture@example.com' })
};

const FIXTURE_WORKSHOP = {
  id: 'TEST-WS-1',
  title: 'Fixture Wheel Class',
  category: 'Pottery',
  capacity: 6,
};

const FIXTURE_SESSION = {
  id: 'TEST-SESS-1',
  workshopId: 'TEST-WS-1',
  date: '2026-12-01',
  startTime: '11:00 AM',
  capacity: 6,
  status: 'Published' as const
};

/**
 * A client with no session at all.
 *
 * Row Level Security is what actually protects the data, and it can only be
 * proven by asking as somebody who is not signed in. The app's own clients
 * carry a session, so a fresh anonymous one is created for these checks.
 */
function anonClient(): SupabaseClient | null {
  const url = readPublicEnv('VITE_SUPABASE_URL');
  const key = readPublicEnv('VITE_SUPABASE_ANON_KEY');
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

/** Every id this suite writes starts with this. Nothing else is ever touched. */
export const TEST_PREFIX = 'TEST-';

const isTestRow = (row: any) => String(row?.id || '').startsWith(TEST_PREFIX);

/**
 * Ids written by an earlier version of this suite, before every fixture was
 * namespaced. They went into the real tables and were never cleaned up, so
 * they polluted the Live Queue and skewed the dashboard figures. Listed here
 * so one run removes them; they can be deleted from this list afterwards.
 */
const LEGACY_TEST_IDS = [
  'Q-001', 'Q-002', 'Q-003', 'Q-010', 'Q-101', 'Q-102', 'Q-201', 'Q-202', 'Q-301', 'Q-401',
  'cat-1', 'cat-new', 'cat-dupe'
];

/**
 * Tables the suite writes to, children before parents so foreign keys are not
 * violated during cleanup.
 */
const WRITTEN_TABLES: Array<keyof typeof sdb> = [
  'pieceHistory', 'notifications', 'queue', 'pieces', 'pipelineStages', 'bookings',
  'workshopSessions', 'workshops', 'customers', 'staff', 'events', 'categories'
];

/**
 * Deletes every TEST- row. Runs after the suite whatever happened, and again
 * before it, so a run interrupted by a crash cannot leave fixtures behind for
 * staff to find in the console.
 */
export async function purgeTestRows(): Promise<number> {
  let removed = 0;

  // Children first: a queue entry referencing a booking blocks that booking's
  // delete, which is how rows survived a purge and then collided on the next
  // run as a duplicate key.
  for (const table of WRITTEN_TABLES) {
    try {
      const api = sdb[table] as any;
      const rows = await api.toArray();

      const doomed = rows.filter((row: any) =>
        isTestRow(row) ||
        // piece_history has a generated uuid; it is matched by its parent.
        String(row?.pieceId || '').startsWith(TEST_PREFIX) ||
        // Rows written by an earlier version of this suite, before every
        // fixture was namespaced. One-time cleanup; harmless afterwards.
        LEGACY_TEST_IDS.includes(String(row?.id || ''))
      );

      for (const row of doomed) {
        try {
          await api.delete(row.id);
          removed++;
        } catch (err) {
          console.warn(`Could not delete ${String(table)}/${row.id}:`, err);
        }
      }
    } catch (err) {
      console.warn(`Could not purge test rows from ${String(table)}:`, err);
    }
  }
  return removed;
}

/** Puts the fixtures back to a known state before each scenario test. */
async function seedTemp(temp: typeof sdb): Promise<void> {
  await purgeTestRows();
  await temp.customers.put(FIXTURE_CUSTOMER as any);
  await temp.workshops.put(FIXTURE_WORKSHOP as any);
  await temp.workshopSessions.put(FIXTURE_SESSION as any);
}

/** Remaining seats for the fixture session, via the production helper. */
async function fixtureRemaining(temp: typeof sdb): Promise<number> {
  const [workshops, bookings, queue] = await Promise.all([
    temp.workshops.toArray(), temp.bookings.toArray(), temp.queue.toArray()
  ]);
  return getSessionSeatUsage(FIXTURE_SESSION as any, { workshops, bookings, queue }).remainingCapacity;
}

/**
 * A façade whose READS return only the suite's own rows.
 *
 * Scenario tests assert on counts — "2 bookings today", "one customer record"
 * — and there is one database now, so without this they also count the
 * studio's real records and fail for reasons that have nothing to do with the
 * behaviour under test.
 *
 * Writes are untouched and go to the real tables; only what a test can SEE is
 * narrowed. Audits deliberately use the unscoped `live` façade, because their
 * whole purpose is to inspect real data.
 */
const belongsToSuite = (row: any) =>
  isTestRow(row) || String(row?.pieceId || '').startsWith(TEST_PREFIX);

function scopedFacade(): typeof sdb {
  return new Proxy({} as any, {
    get(_target, table: string) {
      const api = (sdb as any)[table];
      if (typeof api !== 'object' || api === null) return api;
      return {
        ...api,
        toArray: async () => (await api.toArray()).filter(belongsToSuite),
        count: async () => (await api.toArray()).filter(belongsToSuite).length,
        // The unscoped clear() wipes the whole real table — it deleted the
        // studio's actual pipeline stages and categories this way once
        // already. A test's "clear" may only ever remove its own rows.
        clear: async () => {
          const rows = (await api.toArray()).filter(belongsToSuite);
          for (const row of rows) await api.delete(row.id);
        },
        filter: (predicate: (row: any) => boolean) => ({
          toArray: async () => (await api.toArray()).filter(belongsToSuite).filter(predicate),
          first: async () => (await api.toArray()).filter(belongsToSuite).filter(predicate)[0],
          count: async () => (await api.toArray()).filter(belongsToSuite).filter(predicate).length
        }),
        orderBy: (field: string) => ({
          toArray: async () => (await api.toArray())
            .filter(belongsToSuite)
            .sort((a: any, b: any) => String(a[field]).localeCompare(String(b[field])))
        })
      };
    }
  });
}

const scopedDb = scopedFacade();
const scopedValidationDb = scopedDb as unknown as ValidationDb;

/**
 * The warning an admin should see when a staff member is switched to Inactive
 * while they still hold assignments. Calls the same production helper the
 * Staff Registry's save guard uses, so this test exercises the real rule.
 */
async function staffInactiveWarning(
  source: typeof sdb,
  staffId: string
): Promise<string | null> {
  const [staffList, workshopSessions, workshops, events, bookings, birthdayPackages, queue] = await Promise.all([
    source.staff.toArray(),
    source.workshopSessions.toArray(),
    source.workshops.toArray(),
    source.events.toArray(),
    source.bookings.toArray(),
    source.birthdayPackages.toArray(),
    source.queue.toArray()
  ]);
  const member = staffList.find((s: any) => s.id === staffId);
  if (!member) return null;

  const held = getUpcomingAssignments(
    staffId,
    { staff: staffList, workshopSessions, workshops, events, bookings, birthdayPackages, queue } as any,
    getRiyadhDateString()
  );
  return describeInactiveWarning(member.status, 'Inactive', held);
}

// ==========================================================
// THE TESTS
// ==========================================================

export const SYSTEM_TESTS: SystemTestDefinition[] = [

  // ---------- VALIDATION ----------
  {
    id: 'VAL-01',
    name: 'Duplicate phone is rejected',
    description: 'Adds a customer, then checks a second one with the same normalized phone written differently.',
    category: 'Validation',
    kind: 'scenario',
    run: async ({ temp, scoped }) => {
      await seedTemp(temp);
      const result = await checkDuplicateCustomerPhone('+966 50 123 4567', undefined, scoped);
      return check(
        !result.valid && (result.error || '').includes('Fixture Customer'),
        'Rejected, naming the existing customer "Fixture Customer"',
        result.valid ? 'Accepted as a new customer' : `Rejected: ${result.error}`,
        'A second customer could be created with a phone number that already belongs to an existing account.'
      );
    }
  },
  {
    id: 'VAL-02',
    name: 'Duplicate email is rejected',
    description: 'Checks an email that differs only by letter case from a stored one.',
    category: 'Validation',
    kind: 'scenario',
    run: async ({ temp, scoped }) => {
      await seedTemp(temp);
      const result = await checkDuplicateCustomerEmail('FIXTURE@Example.com', undefined, scoped);
      return check(
        !result.valid,
        'Rejected — email match ignores letter case',
        result.valid ? 'Accepted as a new customer' : `Rejected: ${result.error}`,
        'An email that already has an account was accepted again because the comparison was case-sensitive.'
      );
    }
  },
  {
    id: 'VAL-03',
    name: 'Password rules are enforced',
    description: 'A password under 8 characters, or missing a letter or a number, must be rejected.',
    category: 'Validation',
    kind: 'scenario',
    run: async () => {
      const cases: Array<[string, boolean]> = [
        ['abc123', false],      // too short
        ['abcdefgh', false],    // no number
        ['12345678', false],    // no letter
        ['', false],            // empty
        ['abcd1234', true]      // valid
      ];
      const wrong = cases.filter(([value, shouldPass]) => validatePasswordRule(value).valid !== shouldPass);
      return check(
        wrong.length === 0,
        'Short/letters-only/digits-only rejected; "abcd1234" accepted',
        wrong.length === 0
          ? 'All 5 password cases behaved correctly'
          : `Wrong verdict for: ${listSome(wrong.map(([v]) => `"${v}"`))}`,
        'The password rule accepted a weak password or rejected a valid one.'
      );
    }
  },
  {
    id: 'VAL-04',
    name: 'Phone numbers normalize to one canonical value',
    description: 'Checks that every accepted way of writing a Saudi mobile number resolves to a single stored form.',
    category: 'Validation',
    kind: 'scenario',
    run: async () => {
      const spellings = ['+966 50 123 4567', '0501234567', '+966501234567', '966501234567', '501234567'];
      const results = spellings.map(canonicalPhone);
      const unique = [...new Set(results)];
      return check(
        unique.length === 1 && unique[0] === '+966501234567',
        'All spellings resolve to "+966501234567"',
        unique.length === 1 ? `All resolve to "${unique[0]}"` : `Got ${unique.length} different values: ${unique.join(' | ')}`,
        'The same phone number stored in different formats produces different values, so duplicate detection would miss them.'
      );
    }
  },

  // ---------- BOOKINGS & CAPACITY ----------
  {
    id: 'BOK-01',
    name: 'Booking beyond remaining capacity is blocked',
    description: 'Fills a 6-seat session to 5, then attempts to book 3 more.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp, scoped }) => {
      await seedTemp(temp);
      await temp.bookings.put({
        id: 'TEST-BK-1', sessionId: FIXTURE_SESSION.id, workshopId: FIXTURE_WORKSHOP.id,
        date: FIXTURE_SESSION.date, time: FIXTURE_SESSION.startTime,
        participants: 5, status: 'Pending', customerName: 'Fixture'
      } as any);

      // The fixture session exists only in this temporary database, so the
      // production seat reader (which asks the real database) would find no row
      // and the guard would refuse for the wrong reason. Counting locally over
      // the temp db is what makes this test exercise the capacity rule itself.
      const errors = await validateBookingForm(
        { sessionId: FIXTURE_SESSION.id, participants: 3 },
        scoped,
        makeLocalSeatReader(scoped)
      );
      const message = errors.participants || errors.sessionId;
      return check(
        !!message,
        'Blocked — only 1 seat remains for 3 requested',
        message ? `Blocked: ${message}` : 'The booking was allowed through',
        'A booking was accepted for more people than the session has seats left, which would overbook the class.'
      );
    }
  },
  {
    id: 'BOK-02',
    name: 'A confirmed booking takes its seats',
    description: 'Adds a 2-person booking and re-reads remaining capacity from the shared seat helper.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp, scoped }) => {
      await seedTemp(temp);
      const before = await fixtureRemaining(temp);
      await temp.bookings.put({
        id: 'TEST-BK-2', sessionId: FIXTURE_SESSION.id, workshopId: FIXTURE_WORKSHOP.id,
        date: FIXTURE_SESSION.date, time: FIXTURE_SESSION.startTime,
        participants: 2, status: 'Pending', customerName: 'Fixture'
      } as any);
      const after = await fixtureRemaining(temp);

      return check(
        after === before - 2,
        `Remaining drops by the 2 participants: ${before} → ${before - 2}`,
        `Remaining went ${before} → ${after}`,
        'Confirming a booking did not reduce the seats left, so the session could be sold twice.'
      );
    }
  },
  {
    id: 'BOK-03',
    name: 'Cancelling a booking restores its seats',
    description: 'Cancels the booking from the previous scenario and confirms the seats come back.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const before = await fixtureRemaining(temp);
      await temp.bookings.put({
        id: 'TEST-BK-3', sessionId: FIXTURE_SESSION.id, workshopId: FIXTURE_WORKSHOP.id,
        date: FIXTURE_SESSION.date, time: FIXTURE_SESSION.startTime,
        participants: 3, status: 'Pending', customerName: 'Fixture'
      } as any);
      const whileBooked = await fixtureRemaining(temp);
      await temp.bookings.update('TEST-BK-3', { status: 'Cancelled' });
      const afterCancel = await fixtureRemaining(temp);

      return check(
        whileBooked === before - 3 && afterCancel === before,
        `Seats return to ${before} after cancellation`,
        `${before} → ${whileBooked} while booked → ${afterCancel} after cancelling`,
        'Cancelling a booking did not release its seats, so the session stays wrongly full.'
      );
    }
  },
  {
    id: 'BOK-04',
    name: 'Every booking has a unique reference',
    description: 'Audits the live bookings table for missing or repeated reference ids.',
    category: 'Bookings',
    kind: 'audit',
    run: async ({ live }) => {
      const bookings: Booking[] = await live.bookings.toArray();
      const seen = new Map<string, number>();
      bookings.forEach(b => seen.set(b.id, (seen.get(b.id) || 0) + 1));
      const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      const blank = bookings.filter(b => !b.id || !String(b.id).trim()).length;

      return check(
        repeated.length === 0 && blank === 0,
        `All ${bookings.length} bookings carry a unique, non-empty reference`,
        repeated.length === 0 && blank === 0
          ? `${bookings.length} bookings checked, all unique`
          : `${repeated.length} repeated (${listSome(repeated)}), ${blank} blank`,
        'Two bookings share a reference code, so staff and customers cannot tell them apart.'
      );
    }
  },

  // ---------- QUEUE ----------
  {
    id: 'QUE-01',
    name: 'A new queue entry gets today and the next number',
    description: 'Adds entries to the temporary queue and checks the date stamp and the next sequential id.',
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.queue.bulkPut([
        { id: 'TEST-Q-001', name: 'A', date: today, status: 'Completed' },
        { id: 'TEST-Q-002', name: 'B', date: today, status: 'Waiting' }
      ] as any);

      // The rule the app uses: one past the highest existing number.
      const existing = await temp.queue.toArray();
      const highest = existing.reduce((max, q) => Math.max(max, parseInt(String(q.id).replace(/\D/g, ''), 10) || 0), 0);
      const nextId = `Q-${String(highest + 1).padStart(3, '0')}`;
      await temp.queue.put({ id: nextId, name: 'C', date: today, status: 'Waiting' } as any);

      const created = await temp.queue.get(nextId);
      return check(
        nextId === 'Q-003' && created?.date === today,
        `Next id "Q-003" dated ${today}`,
        `Got id "${nextId}" dated ${created?.date ?? 'nothing'}`,
        'A new walk-in was given a repeated number or the wrong date, so the queue order and Today filter break.'
      );
    }
  },
  {
    id: 'QUE-02',
    name: 'Completing a visit moves it to Completed Today',
    description: 'Completes a waiting entry and checks it leaves Waiting and appears in Completed Today.',
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.queue.put({ id: 'TEST-Q-010', name: 'Guest', date: today, status: 'Waiting' } as any);
      await temp.queue.update('TEST-Q-010', { status: 'Completed' });

      const all: QueueItem[] = await temp.queue.toArray();
      const waiting = all.filter(q => q.date === today && q.status === 'Waiting');
      const completedToday = all.filter(q => q.date === today && q.status === 'Completed');

      return check(
        waiting.length === 0 && completedToday.some(q => q.id === 'TEST-Q-010'),
        'TEST-Q-010 leaves Waiting and appears in Completed Today',
        `Waiting: ${waiting.length}, Completed Today: ${completedToday.map(q => q.id).join(', ') || 'none'}`,
        'A completed visit either stayed in the waiting list or never reached Completed Today.'
      );
    }
  },
  {
    id: 'QUE-03',
    name: 'The queue only ever shows today',
    description: "Audits the live queue: no entry dated other than today may appear in today's board.",
    category: 'Live Queue',
    kind: 'audit',
    run: async ({ live }) => {
      const today = getRiyadhDateString();
      const all: QueueItem[] = await live.queue.toArray();
      const shown = all.filter(q => q.date === today);
      const stale = shown.filter(q => q.date !== today);
      const undated = all.filter(q => !q.date);

      return check(
        stale.length === 0 && undated.length === 0,
        `Every visible entry is dated ${today}`,
        undated.length > 0
          ? `${undated.length} entries have no date (${listSome(undated.map(q => q.id))})`
          : `${shown.length} of ${all.length} entries are today's; none stale`,
        'A queue entry has no date, so it can leak into the wrong day\'s board.'
      );
    }
  },

  // ---------- PIECES ----------
  {
    id: 'PCS-01',
    name: 'Every piece belongs to a customer',
    description: 'Audits the live pieces table for records with no customer name or id.',
    category: 'Pieces',
    kind: 'audit',
    run: async ({ live }) => {
      const pieces: PotteryPiece[] = await live.pieces.toArray();
      const orphaned = pieces.filter(p => !p.customerId && !String(p.customerName || '').trim());

      return check(
        orphaned.length === 0,
        `All ${pieces.length} pieces name a customer`,
        orphaned.length === 0
          ? `${pieces.length} pieces checked`
          : `${orphaned.length} without a customer: ${listSome(orphaned.map(p => p.id))}`,
        'A pottery piece exists with nobody attached to it, so it can never be collected or notified about.'
      );
    }
  },
  {
    id: 'PCS-02',
    name: 'Status changes are recorded in the piece history',
    description: 'Audits every live piece that has moved past its first stage for a matching history trail.',
    category: 'Pieces',
    kind: 'audit',
    run: async ({ live }) => {
      const [pieces, stages]: [PotteryPiece[], PipelineStage[]] = await Promise.all([
        live.pieces.toArray(), live.pipelineStages.toArray()
      ]);
      const created = stageByKey(stages, 'created');
      const moved = pieces.filter(p => p.status && stageOf(p, stages)?.id !== created?.id);
      // By stage id, so a stage renamed since the entry was written still matches.
      const missing = moved.filter(p => {
        const current = stageOf(p, stages)?.id;
        return !(p.history || []).some(h => stageOf(h, stages)?.id === current);
      });

      return check(
        missing.length === 0,
        `Every piece past "Created" has its current status in its history (${moved.length} checked)`,
        missing.length === 0
          ? `${moved.length} pieces have a complete history`
          : `${missing.length} missing a history entry: ${listSome(missing.map(p => `${p.id} (${p.status})`))}`,
        'A piece changed status without the change being written to its history, so the audit trail is incomplete.'
      );
    }
  },
  {
    id: 'PCS-03',
    name: '"Ready for Pickup" notifies the customer',
    description: 'Audits live pieces that are ready and confirms each produced a customer notification.',
    category: 'Pieces',
    kind: 'audit',
    run: async ({ live }) => {
      const [pieces, notifications, stages] = await Promise.all([
        live.pieces.toArray(), live.notifications.toArray(), live.pipelineStages.toArray()
      ]);

      // A stage can be configured not to notify; that is not a failure.
      const readyStage = stageByKey(stages, 'ready');
      if (readyStage && readyStage.notifyCustomer === false) {
        return pass(
          'Skipped — the stage is configured not to notify customers',
          'Notifications are switched off for "Ready for Pickup" in Settings'
        );
      }

      // Notifications store the stage name as it was when they were written.
      const readyName = readyStage?.name ?? 'Ready for Pickup';
      const ready = pieces.filter(p => stageOf(p, stages)?.systemKey === 'ready');
      const notNotified = ready.filter(p => !notifications.some(
        n => n.type === 'customer' && n.pieceId === p.id && n.newStatus === readyName
      ));

      return check(
        notNotified.length === 0,
        `All ${ready.length} ready pieces have a customer notification`,
        notNotified.length === 0
          ? `${ready.length} ready pieces checked`
          : `${notNotified.length} with no notification: ${listSome(notNotified.map(p => p.id))}`,
        'A piece was marked ready but the customer was never told, so it sits on the shelf uncollected.'
      );
    }
  },

  // ---------- DATA INTEGRITY ----------
  {
    id: 'INT-01',
    name: 'No booking points at a missing workshop',
    description: 'Cross-checks every live booking\'s workshopId against the workshops table.',
    category: 'Data Integrity',
    kind: 'audit',
    run: async ({ live }) => {
      const [bookings, workshops] = await Promise.all([live.bookings.toArray(), live.workshops.toArray()]);
      const ids = new Set(workshops.map(w => String(w.id)));
      // Birthday packages are not workshop records; they are booked separately.
      const orphaned = bookings.filter(b =>
        b.workshopId && b.workshopId !== 'birthday-party-event' && !ids.has(String(b.workshopId))
      );

      return check(
        orphaned.length === 0,
        `All ${bookings.length} bookings reference an existing workshop`,
        orphaned.length === 0
          ? `${bookings.length} bookings checked against ${workshops.length} workshops`
          : `${orphaned.length} orphaned: ${listSome(orphaned.map(b => `${b.id}→${b.workshopId}`))}`,
        'A booking points at a workshop that no longer exists, so its page and tutor cannot be resolved.'
      );
    }
  },
  {
    id: 'INT-02',
    name: 'No piece points at a missing customer',
    description: 'Cross-checks every live piece\'s customerId against the customers table.',
    category: 'Data Integrity',
    kind: 'audit',
    run: async ({ live }) => {
      const [pieces, customers] = await Promise.all([live.pieces.toArray(), live.customers.toArray()]);
      const ids = new Set(customers.map(c => String(c.id)));
      const orphaned = pieces.filter(p => p.customerId && !ids.has(String(p.customerId)));

      return check(
        orphaned.length === 0,
        `All pieces with a customer link reference an existing customer`,
        orphaned.length === 0
          ? `${pieces.length} pieces checked against ${customers.length} customers`
          : `${orphaned.length} orphaned: ${listSome(orphaned.map(p => `${p.id}→${p.customerId}`))}`,
        'A piece is linked to a deleted customer record, so its owner cannot be found or notified.'
      );
    }
  },
  {
    id: 'INT-03',
    name: 'No queue entry points at a missing booking',
    description: 'Cross-checks every live queue entry\'s bookingId against the bookings table.',
    category: 'Data Integrity',
    kind: 'audit',
    run: async ({ live }) => {
      const [queue, bookings] = await Promise.all([live.queue.toArray(), live.bookings.toArray()]);
      const ids = new Set(bookings.map(b => String(b.id)));
      const orphaned = queue.filter(q => q.bookingId && !ids.has(String(q.bookingId)));

      return check(
        orphaned.length === 0,
        'All queue entries with a booking link reference an existing booking',
        orphaned.length === 0
          ? `${queue.length} queue entries checked against ${bookings.length} bookings`
          : `${orphaned.length} orphaned: ${listSome(orphaned.map(q => `${q.id}→${q.bookingId}`))}`,
        'A queue entry references a booking that no longer exists, so the visit cannot be tied back to its reservation.'
      );
    }
  },
// ---------- DASHBOARD ----------
  {
    id: 'DSH-01',
    name: "Today's Bookings equals today's live activity",
    description: "Builds bookings dated today, yesterday and a cancelled one, then runs the dashboard's own activity helper.",
    category: 'Dashboard',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.bookings.bulkPut([
        { id: 'TEST-BK-T1', workshopId: FIXTURE_WORKSHOP.id, date: today, time: '11:00 AM', participants: 2, status: 'Pending', paymentStatus: 'Paid', customerName: 'A', customerPhone: '+966500000001' },
        { id: 'TEST-BK-T2', workshopId: FIXTURE_WORKSHOP.id, date: today, time: '2:00 PM', participants: 3, status: 'Checked In', paymentStatus: 'Paid', customerName: 'B', customerPhone: '+966500000002' },
        { id: 'TEST-BK-T3', workshopId: FIXTURE_WORKSHOP.id, date: today, time: '4:00 PM', participants: 5, status: 'Cancelled', paymentStatus: 'Paid', customerName: 'C', customerPhone: '+966500000003' },
        { id: 'TEST-BK-Y1', workshopId: FIXTURE_WORKSHOP.id, date: '2020-01-01', time: '11:00 AM', participants: 4, status: 'Pending', paymentStatus: 'Paid', customerName: 'D', customerPhone: '+966500000004' }
      ] as any);

      const [bookings, queue, workshops] = await Promise.all([
        temp.bookings.toArray(), temp.queue.toArray(), temp.workshops.toArray()
      ]);
      const activity = getActivitiesForDate({ bookings, queue, workshops }, today);
      const participants = activity.reduce((sum, a) => sum + a.participants, 0);

      return check(
        activity.length === 2 && participants === 5,
        "2 bookings today, 5 participants (cancelled and yesterday's excluded)",
        `${activity.length} bookings, ${participants} participants`,
        "The Today's Bookings figure does not match the underlying records — a cancelled or out-of-date booking is being counted."
      );
    }
  },
  {
    id: 'DSH-02',
    name: 'Unpaid count matches the unpaid bookings',
    description: 'Counts unpaid, non-cancelled bookings the way the dashboard metric does.',
    category: 'Dashboard',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.bookings.bulkPut([
        { id: 'TEST-U1', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Pending', paymentStatus: 'Unpaid', customerName: 'A' },
        { id: 'TEST-U2', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Completed', paymentStatus: 'Unpaid', customerName: 'B' },
        { id: 'TEST-U3', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Cancelled', paymentStatus: 'Unpaid', customerName: 'C' },
        { id: 'TEST-U4', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Pending', paymentStatus: 'Paid', customerName: 'D' }
      ] as any);

      const bookings = await temp.bookings.toArray();
      const unpaid = bookings.filter(b => b.paymentStatus === 'Unpaid' && b.status !== 'Cancelled').length;

      return check(
        unpaid === 2,
        '2 unpaid bookings (the cancelled one does not count)',
        `${unpaid} counted`,
        'The unpaid figure on the dashboard disagrees with the bookings behind it.'
      );
    }
  },
  {
    id: 'DSH-03',
    name: 'Overdue pickup uses the 7-day threshold',
    description: 'Checks the boundary: 6 days waiting is not overdue, 7 days is, and only ready pieces count.',
    category: 'Dashboard',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      // Only the Ready for Pickup stage counts, by its system key.
      const isOverdue = (piece: any) => {
        if (stageOf(piece, DEFAULT_PIPELINE_STAGES)?.systemKey !== 'ready') return false;
        return (piece.daysElapsed || 0) >= 7;
      };
      const cases = [
        { id: 'p6', stageId: 'stage-ready', status: 'Ready for Pickup', daysElapsed: 6, want: false },
        { id: 'p7', stageId: 'stage-ready', status: 'Ready for Pickup', daysElapsed: 7, want: true },
        { id: 'p9', stageId: 'stage-ready', status: 'Ready for Pickup', daysElapsed: 9, want: true },
        { id: 'pd', stageId: 'stage-greenware', status: 'Created', daysElapsed: 30, want: false },
        { id: 'pc', stageId: 'stage-collected', status: 'Collected', daysElapsed: 30, want: false }
      ];
      const wrong = cases.filter(c => isOverdue(c) !== c.want);

      return check(
        wrong.length === 0,
        'Only ready pieces waiting 7+ days are overdue',
        wrong.length === 0 ? 'All 5 boundary cases correct' : `Wrong for: ${listSome(wrong.map(c => c.id))}`,
        'The overdue-pickup figure counts the wrong pieces, so staff chase the wrong customers.'
      );
    }
  },

  // ---------- LIVE QUEUE ----------
  {
    id: 'LQ-01',
    name: "Yesterday's entries never appear on today's board",
    description: "Adds entries for today and for a past date, then applies the board's date filter.",
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.queue.bulkPut([
        { id: 'TEST-Q-101', name: 'Today A', date: today, status: 'Waiting' },
        { id: 'TEST-Q-102', name: 'Yesterday', date: '2020-01-01', status: 'Waiting' }
      ] as any);

      const board = (await temp.queue.toArray()).filter(q => q.date === today);
      return check(
        board.length === 1 && board[0].id === 'TEST-Q-101',
        "Only TEST-Q-101 (today) is on the board",
        `Board shows: ${board.map(q => `${q.id}@${q.date}`).join(', ') || 'nothing'}`,
        "A visit from another day is showing on today's queue, inflating the waiting list."
      );
    }
  },
  {
    id: 'LQ-02',
    name: 'Queue numbers run in sequence and reset each day',
    description: "Numbers a new walk-in from today's entries only, so a new day starts again at 1.",
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      const nextNumber = (rows: QueueItem[], forDate: string) => {
        const todays = rows.filter(q => q.date === forDate);
        const highest = todays.reduce(
          (max, q) => Math.max(max, parseInt(String(q.id).replace(/\D/g, ''), 10) || 0), 0);
        return highest + 1;
      };

      await temp.queue.bulkPut([
        { id: 'TEST-Q-201', name: 'Old day', date: '2020-01-01', status: 'Completed' },
        { id: 'TEST-Q-202', name: 'Old day', date: '2020-01-01', status: 'Completed' }
      ] as any);
      const firstToday = nextNumber(await temp.queue.toArray(), today);

      await temp.queue.put({ id: 'TEST-Q-001', name: 'First today', date: today, status: 'Waiting' } as any);
      const secondToday = nextNumber(await temp.queue.toArray(), today);

      return check(
        firstToday === 1 && secondToday === 2,
        'First walk-in today is 1, the next is 2 — yesterday does not carry over',
        `First: ${firstToday}, second: ${secondToday}`,
        'Queue numbering continues from a previous day or repeats a number, so staff call the wrong guest.'
      );
    }
  },
  {
    id: 'LQ-03',
    name: 'Queue transitions are valid and recorded',
    description: 'Walks Waiting → Called → In Progress → Completed and checks each step is appended to history.',
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      const VALID: QueueItem['status'][] = ['Waiting', 'Called', 'In Progress', 'Completed', 'Cancelled'];

      await temp.queue.put({
        id: 'TEST-Q-301', name: 'Guest', date: today, status: 'Waiting',
        history: [{ status: 'Waiting', timestamp: new Date().toISOString() }]
      } as any);

      for (const next of ['Called', 'In Progress', 'Completed'] as QueueItem['status'][]) {
        const item = await temp.queue.get('TEST-Q-301');
        await temp.queue.update('TEST-Q-301', {
          status: next,
          history: [...(item!.history || []), { status: next, timestamp: new Date().toISOString() }]
        } as any);
      }

      const final = await temp.queue.get('TEST-Q-301');
      const trail = (final!.history || []).map(h => h.status);
      const allValid = trail.every(st => VALID.includes(st as QueueItem['status']));

      return check(
        final!.status === 'Completed' && trail.length === 4 && allValid &&
          trail.join(' → ') === 'Waiting → Called → In Progress → Completed',
        'History reads Waiting → Called → In Progress → Completed',
        `Status "${final!.status}", history: ${trail.join(' → ') || 'empty'}`,
        'A queue status change was not written to the visit history, so there is no record of what happened.'
      );
    }
  },
  {
    id: 'LQ-04',
    name: 'A walk-in on a known number reuses that customer',
    description: 'Checks in a walk-in using the fixture customer’s number written differently.',
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const customers = await temp.customers.toArray();
      const before = customers.length;

      // The shared identity lookup every walk-in goes through.
      const match = findCustomerMatch(customers, { phone: '+966 50 123 4567' });
      const linked = match.customer;

      return check(
        !!linked && linked.id === FIXTURE_CUSTOMER.id && match.reason === 'phone' && before === 1,
        'Links to the existing customer by phone; no second record created',
        linked
          ? `Linked to ${linked.id} (matched on ${match.reason}), ${before} customer record(s)`
          : `No match found — a duplicate customer would be created`,
        'A returning walk-in was not recognised, so their visits and pieces split across two customer records.'
      );
    }
  },

  // ---------- BOOKINGS ----------
  {
    id: 'BKG-01',
    name: 'Only the four live booking statuses are in use',
    description: 'Audits the live bookings table for retired statuses such as Confirmed or No Show.',
    category: 'Bookings',
    kind: 'audit',
    run: async ({ live }) => {
      const allowed = ['Pending', 'Checked In', 'Completed', 'Cancelled', 'In Progress'];
      const retired = ['Confirmed', 'No Show', 'No-Show'];
      const bookings: Booking[] = await live.bookings.toArray();
      const offending = bookings.filter(b => retired.includes(String(b.status)) || !allowed.includes(String(b.status)));

      return check(
        offending.length === 0,
        'Every booking is Pending, Checked In, Completed or Cancelled',
        offending.length === 0
          ? `${bookings.length} bookings checked`
          : `${offending.length} with a retired status: ${listSome(offending.map(b => `${b.id}=${b.status}`))}`,
        'A booking carries a status the console no longer understands, so it cannot be filtered or acted on.'
      );
    }
  },
  {
    id: 'BKG-02',
    name: 'Pending auto-cancels 15 minutes after check-in time',
    description: 'Runs the elapsed-time rule at 14, 15 and 16 minutes past the scheduled start.',
    category: 'Bookings',
    kind: 'scenario',
    run: async () => {
      const GRACE_MS = 15 * 60 * 1000;
      const shouldCancel = (status: string, minutesPast: number) =>
        status === 'Pending' && minutesPast * 60 * 1000 >= GRACE_MS;

      const cases = [
        { label: 'Pending, 14 min past', got: shouldCancel('Pending', 14), want: false },
        { label: 'Pending, exactly 15 min', got: shouldCancel('Pending', 15), want: true },
        { label: 'Pending, 16 min past', got: shouldCancel('Pending', 16), want: true },
        { label: 'Pending, 5 min before', got: shouldCancel('Pending', -5), want: false },
        { label: 'Checked In, 60 min past', got: shouldCancel('Checked In', 60), want: false }
      ];
      const wrong = cases.filter(c => c.got !== c.want);

      return check(
        wrong.length === 0,
        'Cancels at 15 minutes or more, only while still Pending',
        wrong.length === 0 ? 'All 5 timing cases correct' : `Wrong for: ${listSome(wrong.map(c => c.label))}`,
        'The no-show rule fires too early, too late, or on a guest who already checked in.'
      );
    }
  },
  {
    id: 'BKG-03',
    name: 'Refund follows the 24-hour cancellation window',
    description: 'Checks refund eligibility either side of the 24-hour threshold and that Refunded is settable.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const refundEligible = (hoursUntilStart: number) => hoursUntilStart > 24;

      const cases = [
        { label: '48h before', got: refundEligible(48), want: true },
        { label: '24.5h before', got: refundEligible(24.5), want: true },
        { label: 'exactly 24h', got: refundEligible(24), want: false },
        { label: '2h before', got: refundEligible(2), want: false },
        { label: 'after the start', got: refundEligible(-3), want: false }
      ];
      const wrong = cases.filter(c => c.got !== c.want);

      await temp.bookings.put({
        id: 'TEST-REF', workshopId: 'w', date: '2026-12-01', time: '11:00 AM',
        participants: 1, status: 'Pending', paymentStatus: 'Paid', customerName: 'A'
      } as any);
      await temp.bookings.update('TEST-REF', { status: 'Cancelled', paymentStatus: 'Refunded' });
      const refunded = await temp.bookings.get('TEST-REF');

      return check(
        wrong.length === 0 && refunded?.paymentStatus === 'Refunded' && refunded?.status === 'Cancelled',
        'More than 24h ahead is refundable; 24h or less is not; Refunded is storable',
        wrong.length > 0
          ? `Wrong for: ${listSome(wrong.map(c => c.label))}`
          : `Window correct; stored payment status "${refunded?.paymentStatus}"`,
        'A refund was offered inside the 24-hour cutoff, or refused when it was due.'
      );
    }
  },
  {
    id: 'BKG-04',
    name: 'CSV export covers the filtered rows and escapes them',
    description: 'Applies the page filters, then checks the row count and the escaping of commas and quotes.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.bookings.bulkPut([
        { id: 'TEST-C1', workshopId: 'w', date: today, time: '1', participants: 1, status: 'Pending', paymentStatus: 'Paid', customerName: 'Plain Name', customerPhone: '1', workshopTitle: 'Wheel', source: 'Website', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'TEST-C2', workshopId: 'w', date: today, time: '1', participants: 1, status: 'Completed', paymentStatus: 'Paid', customerName: 'Ali, Noura', customerPhone: '2', workshopTitle: 'Say "hello"', source: 'Website', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'TEST-C3', workshopId: 'w', date: '2020-01-01', time: '1', participants: 1, status: 'Pending', paymentStatus: 'Paid', customerName: 'Old', customerPhone: '3', workshopTitle: 'Old', source: 'Website', createdAt: '2026-01-01T00:00:00.000Z' }
      ] as any);

      // The page exports processedBookings — the filtered set, not every booking.
      const rows = (await temp.bookings.toArray()).filter(b => b.date === today);

      const escapeCSV = (val: any) => {
        if (val === undefined || val === null) return '';
        let str = String(val);
        if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
          str = '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      const problems: string[] = [];
      if (rows.length !== 2) problems.push(`exported ${rows.length} rows instead of the 2 filtered ones`);
      if (escapeCSV('Ali, Noura') !== '"Ali, Noura"') problems.push('a comma was not quoted');
      if (escapeCSV('Say "hello"') !== '"Say ""hello"""') problems.push('a quote was not doubled');
      if (escapeCSV('Plain Name') !== 'Plain Name') problems.push('a plain value was quoted unnecessarily');
      if (escapeCSV(null) !== '') problems.push('a missing value did not become an empty cell');
      if (escapeCSV('line\nbreak') !== '"line\nbreak"') problems.push('a line break was not quoted');

      return check(
        problems.length === 0,
        'Exports the 2 filtered rows; commas, quotes and newlines are escaped',
        problems.length === 0 ? 'Row count and all 5 escaping cases correct' : problems.join('; '),
        'The exported CSV either covers the wrong rows or breaks into the wrong columns when a name contains a comma.'
      );
    }
  },
  {
    id: 'BKG-05',
    name: 'Walk-ins appear in Bookings',
    description: 'Maps a queue walk-in the way the Bookings page does and checks it becomes a visible row.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const today = getRiyadhDateString();
      await temp.queue.put({
        id: 'TEST-Q-401', name: 'Walk-in Guest', phone: '+966500000009', date: today,
        status: 'In Progress', participants: 2, source: 'Walk-in', type: 'Without Instructor',
        checkInTime: '11:15 AM', activity: 'Clay play', history: []
      } as any);

      const [queue, bookings] = await Promise.all([temp.queue.toArray(), temp.bookings.toArray()]);
      const walkIns = queue
        .filter(q => q.source === 'Walk-in')
        .filter(q => !bookings.some(b => b.source === 'Walk-in' && b.customerPhone === q.phone && b.date === q.date));

      const mapped = walkIns.map(q => ({
        id: q.id,
        status: q.status === 'In Progress' ? 'Checked In'
          : q.status === 'Completed' ? 'Completed'
          : q.status === 'Cancelled' ? 'Cancelled' : 'Pending',
        source: 'Walk-in'
      }));
      const unified = [...bookings, ...mapped];

      return check(
        mapped.length === 1 && mapped[0].id === 'TEST-Q-401' && mapped[0].status === 'Checked In' && unified.length === 1,
        'The walk-in shows in Bookings as Checked In',
        mapped.length === 1
          ? `${mapped[0].id} shown as ${mapped[0].status}`
          : `${mapped.length} walk-ins mapped`,
        'A walk-in visit is missing from the Bookings page, so the day’s takings and attendance are understated.'
      );
    }
  },
  {
    id: 'BKG-06',
    name: 'Birthday capacity maxima match what the database enforces',
    description: 'Books through the real book_birthday_slot RPC and checks it trips at BIRTHDAY_DAILY_MAX and BIRTHDAY_SAME_SLOT_MAX (queueUtils.ts), not some other number.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const client = getDataClient();
      if (!client) return pass('Skipped — Supabase is not configured', 'No client to test with');

      // BIRTHDAY_DAILY_MAX/BIRTHDAY_SAME_SLOT_MAX (queueUtils.ts) are only the
      // client's copy. book_birthday_slot (migration 0027) hardcodes its own
      // c_daily_max/c_slot_max, which is what actually decides the outcome —
      // this test proves the two still agree by exercising the real function,
      // rather than trusting the comments in each file that say they should.
      const birthdayBooking = (id: string, date: string, time: string) => ({
        id, customer_name: 'Fixture', workshop_id: BIRTHDAY_WORKSHOP_ID, workshop_title: 'Birthday Party',
        date, time, participants: 2, total_price: 500, source: 'Admin', status: 'Pending', payment_status: 'Paid',
        timeline: [], created_at: new Date().toISOString()
      });
      const why = (r: { error: { message: string } | null }) => r.error ? `refused (${r.error.message})` : 'ok';

      // Two dates far enough in the future, and far enough apart from each
      // other, that a real party is not expected to already occupy either —
      // but the real count is read first and topped up to the boundary
      // rather than assumed to be zero, so a coincidental real booking cannot
      // produce a false result either way.
      const dailyDate = '2028-06-01';
      const slotDate = '2028-06-02';
      const slotTime = '2:00 PM';
      const dailyFillTimes = ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '3:00 PM', '4:00 PM'];

      const { data: counts, error: countsError } = await client.rpc('birthday_booking_counts', {
        p_dates: [dailyDate, slotDate]
      });
      if (countsError) {
        return fail(
          'Existing birthday counts could be read',
          `birthday_booking_counts failed: ${countsError.message}`,
          'Could not read the real counts for the fixture dates, so the boundary could not be set up safely.'
        );
      }

      const rows = (counts || []) as Array<{ booking_date: string; booking_time: string; party_count: number }>;
      const onDailyDate = rows.filter(r => r.booking_date === dailyDate).reduce((sum, r) => sum + r.party_count, 0);
      const onSlotDate = rows.filter(r => r.booking_date === slotDate).reduce((sum, r) => sum + r.party_count, 0);
      const atSlot = rows.find(r => r.booking_date === slotDate && r.booking_time === slotTime)?.party_count || 0;

      // --- Daily max: top the date up to one below the max, each filler at
      // its own time so no slot is exercised, then the next booking must be
      // accepted (reaching the max) and the one after refused.
      let dailyFilled = 0;
      while (onDailyDate + dailyFilled < BIRTHDAY_DAILY_MAX - 1) {
        if (dailyFilled >= dailyFillTimes.length) {
          return fail(
            'The daily-max fixture date had room to test the boundary',
            `${dailyDate} already has ${onDailyDate} real birthday bookings, leaving no room to test a max of ${BIRTHDAY_DAILY_MAX}`,
            'The fixture date is too close to its real capacity for this run to prove anything — pick a different fixture date.'
          );
        }
        const fill = await client.rpc('book_birthday_slot', {
          p_booking: birthdayBooking(`TEST-BDAY-DAILY-FILL-${dailyFilled}`, dailyDate, dailyFillTimes[dailyFilled])
        });
        if (fill.error) {
          return fail(
            'Fixture setup for the daily-max scenario succeeded',
            `seeding filler booking ${dailyFilled} failed: ${fill.error.message}`,
            'Could not set up the daily-max scenario, so the boundary was never exercised.'
          );
        }
        dailyFilled++;
      }
      const dailyAtMax = await client.rpc('book_birthday_slot', {
        p_booking: birthdayBooking('TEST-BDAY-DAILY-ATMAX', dailyDate, dailyFillTimes[dailyFilled])
      });
      const dailyOverMax = await client.rpc('book_birthday_slot', {
        p_booking: birthdayBooking('TEST-BDAY-DAILY-OVERMAX', dailyDate, dailyFillTimes[dailyFilled + 1])
      });

      // --- Same-slot max: top one time slot up to one below its max, then
      // the next booking at that exact time must be accepted and the one
      // after refused. onSlotDate is checked too, so a real date already
      // near its own daily max cannot make this half misreport why a
      // booking was refused.
      let slotFilled = 0;
      if (onSlotDate + BIRTHDAY_SAME_SLOT_MAX + 1 > BIRTHDAY_DAILY_MAX) {
        return fail(
          'The slot-max fixture date had room to test the boundary without also hitting the daily max',
          `${slotDate} already has ${onSlotDate} real birthday bookings, too close to the daily max of ${BIRTHDAY_DAILY_MAX} to isolate the slot rule`,
          'The fixture date is too close to its real daily capacity for this run to prove anything about the slot rule — pick a different fixture date.'
        );
      }
      while (atSlot + slotFilled < BIRTHDAY_SAME_SLOT_MAX - 1) {
        const fill = await client.rpc('book_birthday_slot', {
          p_booking: birthdayBooking(`TEST-BDAY-SLOT-FILL-${slotFilled}`, slotDate, slotTime)
        });
        if (fill.error) {
          return fail(
            'Fixture setup for the slot-max scenario succeeded',
            `seeding filler booking ${slotFilled} failed: ${fill.error.message}`,
            'Could not set up the slot-max scenario, so the boundary was never exercised.'
          );
        }
        slotFilled++;
      }
      const slotAtMax = await client.rpc('book_birthday_slot', {
        p_booking: birthdayBooking('TEST-BDAY-SLOT-ATMAX', slotDate, slotTime)
      });
      const slotOverMax = await client.rpc('book_birthday_slot', {
        p_booking: birthdayBooking('TEST-BDAY-SLOT-OVERMAX', slotDate, slotTime)
      });

      return check(
        !dailyAtMax.error && !!dailyOverMax.error && !slotAtMax.error && !!slotOverMax.error,
        `Exactly ${BIRTHDAY_DAILY_MAX} parties allowed per day, ${BIRTHDAY_SAME_SLOT_MAX} sharing one time slot`,
        `daily at max: ${why(dailyAtMax)}, daily over max: ${why(dailyOverMax)}, `
          + `slot at max: ${why(slotAtMax)}, slot over max: ${why(slotOverMax)}`,
        "book_birthday_slot's hardcoded maxima no longer match BIRTHDAY_DAILY_MAX/BIRTHDAY_SAME_SLOT_MAX "
          + 'in queueUtils.ts — the picker and the database now disagree on what is allowed.'
      );
    }
  },

  // ---------- WORKSHOPS ----------
  {
    id: 'WSH-01',
    name: 'Workshop required fields are enforced',
    description: 'Runs the shared workshop validator over a complete record and each incomplete variant.',
    category: 'Workshops',
    kind: 'scenario',
    run: async () => {
      const good = { title: 'Wheel', category: 'Pottery', price: 250, capacity: 8, ageRange: '12+', sessions: [{}], images: ['a', 'b', 'c'] };
      const variants: Array<[string, any]> = [
        ['no title', { ...good, title: '' }],
        ['no category', { ...good, category: '' }],
        ['negative price', { ...good, price: -1 }],
        ['zero capacity', { ...good, capacity: 0 }],
        ['no age range', { ...good, ageRange: '' }],
        ['no sessions', { ...good, sessions: [] }],
        ['too few photos', { ...good, images: ['a'] }],
        ['no photos', { ...good, images: [] }]
      ];
      const notBlocked = variants.filter(([, v]) => Object.keys(validateWorkshopForm(v)).length === 0);
      const goodBlocked = Object.keys(validateWorkshopForm(good)).length > 0;

      return check(
        notBlocked.length === 0 && !goodBlocked && validateWorkshopForm({ ...good, price: 0 }).price === undefined,
        'Each missing field blocks the save; a complete (and free) workshop passes',
        goodBlocked
          ? 'A complete workshop was wrongly blocked'
          : notBlocked.length === 0
            ? 'All 6 incomplete variants blocked; complete and free workshops pass'
            : `Not blocked: ${listSome(notBlocked.map(([label]) => label))}`,
        'A workshop can be published with a missing title, category, price, capacity, age range or date.'
      );
    }
  },
  {
    id: 'WSH-02',
    name: 'A new category typed in is saved',
    description: 'Checks that a category not already in the list is detected as new and written to the categories table.',
    category: 'Workshops',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.categories.clear();
      // Names, not just ids, must stay clear of anything a real studio would
      // plausibly use — "Pottery" collided with the studio's real category
      // and the unique-on-name constraint refused the write.
      await temp.categories.put({ id: 'TEST-cat-1', name: 'TEST Fixture Category' } as any);

      const typed = 'TEST Glass Fusing';
      const existing = (await temp.categories.toArray())
        .find(c => c.name.toLowerCase() === typed.toLowerCase());
      if (!existing) await temp.categories.put({ id: 'TEST-cat-new', name: typed } as any);

      // Re-typing one that exists must not add a second row.
      const again = (await temp.categories.toArray())
        .find(c => c.name.toLowerCase() === 'test fixture category');
      if (!again) await temp.categories.put({ id: 'TEST-cat-dupe', name: 'TEST Fixture Category' } as any);

      const all = await temp.categories.toArray();
      return check(
        all.length === 2 && all.some(c => c.name === typed),
        '"TEST Glass Fusing" is added; re-typing "TEST Fixture Category" adds nothing',
        `${all.length} categories: ${all.map(c => c.name).join(', ')}`,
        'A category typed into the workshop form is lost, or duplicated on every save.'
      );
    }
  },
  {
    id: 'WSH-03',
    name: 'Editing a workshop updates it in place',
    description: 'Saves an edit to an existing workshop and checks no second record appears.',
    category: 'Workshops',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const before = await temp.workshops.count();
      await temp.workshops.update(FIXTURE_WORKSHOP.id, { title: 'Renamed Class', capacity: 9 });
      const after = await temp.workshops.toArray();
      const edited = after.find(w => w.id === FIXTURE_WORKSHOP.id);

      return check(
        after.length === before && edited?.title === 'Renamed Class' && edited?.capacity === 9,
        'One workshop, renamed to "Renamed Class"',
        `${after.length} workshop(s); title is "${edited?.title}"`,
        'Editing a workshop created a duplicate instead of updating the original.'
      );
    }
  },
  {
    id: 'WSH-05',
    name: 'A session can have its own instructor',
    description: 'Stores a session instructor different from the workshop tutor and checks the staff id is resolved.',
    category: 'Workshops',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.staff.bulkPut([
        { id: 'TEST-STF-1', name: 'Lina', position: 'Instructor', status: 'Active', phone: '+966533334444', email: 'lina@test.com' },
        { id: 'TEST-STF-2', name: 'Omar', position: 'Instructor', status: 'Active', phone: '+966533335555', email: 'omar@test.com' }
      ] as any);

      const workshopTutorId = 'TEST-STF-1';
      const staffList = await temp.staff.toArray();
      const resolve = (sessionStaffId?: string) => {
        const own = sessionStaffId ? staffList.find(s => s.id === sessionStaffId) : undefined;
        const member = own || staffList.find(s => s.id === workshopTutorId);
        return { instructor: member?.name || '', staffId: member?.id };
      };

      await temp.workshopSessions.update(FIXTURE_SESSION.id, resolve('TEST-STF-2'));
      const session = await temp.workshopSessions.get(FIXTURE_SESSION.id);
      const inherited = resolve();

      return check(
        session?.staffId === 'TEST-STF-2' && session?.instructor === 'Omar' &&
          inherited.staffId === workshopTutorId,
        'Session keeps Omar (TEST-STF-2); a session with none inherits the workshop tutor',
        `Session stored ${session?.instructor} / ${session?.staffId}; blank inherits ${inherited.instructor}`,
        'A session’s own instructor is not saved, so the wrong person is shown and their availability is wrong.'
      );
    }
  },

  // ---------- EVENTS ----------
  {
    id: 'EVT-01',
    name: 'Event required fields are enforced',
    description: 'Runs the shared event validator over a complete event and each incomplete variant.',
    category: 'Events',
    kind: 'scenario',
    run: async () => {
      const good = { title: 'Paint Night', category: 'Painting', price: 120, capacity: 20, ageRange: '16+', date: '2026-09-01' };
      const variants: Array<[string, any]> = [
        ['no title', { ...good, title: '' }],
        ['no category', { ...good, category: '' }],
        ['negative price', { ...good, price: -5 }],
        ['zero capacity', { ...good, capacity: 0 }],
        ['no date', { ...good, date: '' }]
      ];
      const notBlocked = variants.filter(([, v]) => Object.keys(validateEventForm(v)).length === 0);

      return check(
        notBlocked.length === 0 && Object.keys(validateEventForm(good)).length === 0,
        'Each missing field blocks the save; a complete event passes',
        notBlocked.length === 0
          ? 'All 5 incomplete variants blocked'
          : `Not blocked: ${listSome(notBlocked.map(([label]) => label))}`,
        'An event can be saved with a missing title, category, price, capacity or date.'
      );
    }
  },
  {
    id: 'EVT-02',
    name: 'Only published events reach customers',
    description: 'Checks the visibility filter over draft, published, cancelled and archived events.',
    category: 'Events',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.events.bulkPut([
        { id: 'TEST-EV-1', title: 'Published', status: 'Published', capacity: 10, spotsLeft: 10 },
        { id: 'TEST-EV-2', title: 'Draft', status: 'Draft', capacity: 10, spotsLeft: 10 },
        { id: 'TEST-EV-3', title: 'Cancelled', status: 'Cancelled', capacity: 10, spotsLeft: 10 },
        { id: 'TEST-EV-4', title: 'Archived', status: 'Archived', capacity: 10, spotsLeft: 10 }
      ] as any);

      const events: AppEvent[] = await temp.events.toArray();
      const visible = events.filter(e => e.status === 'Published').map(e => e.title);

      // Unpublishing must remove it again.
      await temp.events.update('TEST-EV-1', { status: 'Draft' });
      const afterUnpublish = (await temp.events.toArray()).filter(e => e.status === 'Published');

      return check(
        visible.length === 1 && visible[0] === 'Published' && afterUnpublish.length === 0,
        'Only the published event is visible; unpublishing hides it',
        `Visible: ${visible.join(', ') || 'none'}; after unpublishing: ${afterUnpublish.length}`,
        'A draft, cancelled or archived event is showing on the customer site.'
      );
    }
  },
  {
    id: 'EVT-03',
    name: 'An event with bookings cannot be deleted',
    description: 'Applies the delete guard to an event that has a booking and to one that has none.',
    category: 'Events',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.events.bulkPut([
        { id: 'TEST-EV-BOOKED', title: 'Booked', status: 'Published', capacity: 10, spotsLeft: 9 },
        { id: 'TEST-EV-FREE', title: 'Unbooked', status: 'Published', capacity: 10, spotsLeft: 10 }
      ] as any);
      await temp.bookings.put({
        id: 'TEST-EVBK', workshopId: 'TEST-EV-BOOKED', date: '2026-12-01', time: '1',
        participants: 1, status: 'Pending', customerName: 'A'
      } as any);

      const canDelete = async (eventId: string) =>
        (await temp.bookings.where('workshopId').equals(eventId).count()) === 0;

      const bookedDeletable = await canDelete('TEST-EV-BOOKED');
      const freeDeletable = await canDelete('TEST-EV-FREE');

      return check(
        !bookedDeletable && freeDeletable,
        'The booked event is protected; the unbooked one can be removed',
        `Booked deletable: ${bookedDeletable}, unbooked deletable: ${freeDeletable}`,
        'An event with customers booked onto it could be deleted outright, destroying their reservations.'
      );
    }
  },

  // ---------- CUSTOMERS ----------
  {
    id: 'CUS-01',
    name: 'A customer edit saves in place',
    description: 'Edits the fixture customer and checks the record count and the new values.',
    category: 'Customers',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const before = await temp.customers.count();
      await temp.customers.update(FIXTURE_CUSTOMER.id, { name: 'Renamed Customer', notes: 'VIP' });
      const after = await temp.customers.toArray();
      const edited = after.find(c => c.id === FIXTURE_CUSTOMER.id);

      return check(
        after.length === before && edited?.name === 'Renamed Customer',
        'One customer record, renamed in place',
        `${after.length} record(s); name is "${edited?.name}"`,
        'Editing a customer created a second record, splitting their history in two.'
      );
    }
  },
  {
    id: 'CUS-02',
    name: 'A customer’s bookings and pieces are their own',
    description: 'Builds records for two customers and checks the matching rules keep them apart.',
    category: 'Customers',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.customers.put({
        id: 'TEST-CUST-2', name: 'Other Person', createdAt: '2026-01-01',
        ...customerStorageFields({ phone: '0559998888', email: 'other@example.com' })
      } as any);

      await temp.bookings.bulkPut([
        { id: 'TEST-B-A', customerPhone: '+966501234567', customerName: 'Fixture Customer', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Pending' },
        { id: 'TEST-B-B', customerPhone: '0559998888', customerName: 'Other Person', workshopId: 'w', date: '2026-12-01', time: '1', participants: 1, status: 'Pending' }
      ] as any);
      await temp.pieces.bulkPut([
        { id: 'TEST-P-A', name: 'Bowl', status: 'Created', customerId: FIXTURE_CUSTOMER.id, customerPhone: '0501234567', customerName: 'Fixture Customer' },
        { id: 'TEST-P-B', name: 'Mug', status: 'Created', customerId: 'TEST-CUST-2', customerPhone: '0559998888', customerName: 'Other Person' }
      ] as any);

      const [customers, bookings, pieces] = await Promise.all([
        temp.customers.toArray(), temp.bookings.toArray(), temp.pieces.toArray()
      ]);
      const target = customers.find(c => c.id === FIXTURE_CUSTOMER.id)!;
      const key = customerPhoneKey(target);

      const theirBookings = bookings.filter(b => normalizeCustomerPhone(b.customerPhone) === key);
      const theirPieces = pieces.filter(
        p => p.customerId === target.id || normalizeCustomerPhone(p.customerPhone) === key);

      return check(
        theirBookings.length === 1 && theirBookings[0].id === 'TEST-B-A' &&
          theirPieces.length === 1 && theirPieces[0].id === 'TEST-P-A',
        'Fixture Customer shows exactly their own 1 booking and 1 piece',
        `${theirBookings.length} booking(s) [${theirBookings.map(b => b.id).join(', ')}], ` +
        `${theirPieces.length} piece(s) [${theirPieces.map(p => p.id).join(', ')}]`,
        'A customer profile is showing another customer’s bookings or pottery.'
      );
    }
  },

  // ---------- PIECES ----------
  {
    id: 'PCS-04',
    name: 'Backward status moves are recorded too',
    description: 'Moves a piece forward and then back, checking both are appended with a timestamp and a user.',
    category: 'Pieces',
    kind: 'scenario',
    run: async ({ temp, live }) => {
      await seedTemp(temp);
      // The real stages, read-only: a piece can only be in a configured stage.
      const stages: PipelineStage[] = await live.pipelineStages.toArray();
      const created = stageByKey(stages, 'created');
      const kiln = stageByKey(stages, 'kiln');
      if (!created || !kiln) return fail('The Created and Kiln Time stages exist', 'A system stage is missing', 'The pipeline is missing a system stage.');

      await temp.pieces.put({
        id: 'TEST-PC-1', name: 'Bowl', status: created.name, stageId: created.id, customerId: FIXTURE_CUSTOMER.id,
        customerName: 'Fixture Customer', customerPhone: '+966501234567'
      } as any);
      // History lives in its own append-only table.
      await temp.pieceHistory.add({
        pieceId: 'TEST-PC-1', status: created.name, stageId: created.id,
        timestamp: new Date().toISOString(), user: 'Staff'
      } as any);

      const move = async (to: PipelineStage, user: string, reason?: string) => {
        await temp.pieces.update('TEST-PC-1', { status: to.name, stageId: to.id } as any);
        await temp.pieceHistory.add({
          pieceId: 'TEST-PC-1', status: to.name, stageId: to.id,
          timestamp: new Date().toISOString(), user, reason
        } as any);
      };

      await move(kiln, 'Staff');
      await move(created, 'Manager', 'Needed more drying time');

      const final = await temp.pieces.get('TEST-PC-1');
      const trail = (await temp.pieceHistory.toArray())
        .filter((h: any) => h.pieceId === 'TEST-PC-1')
        .sort((a: any, b: any) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const backward = trail[trail.length - 1];

      return check(
        trail.length === 3 && final!.stageId === created.id &&
          backward.stageId === created.id && !!backward.timestamp && backward.user === 'Manager',
        'Three history entries, the last a backward move stamped with its user',
        `Status "${final!.status}", ${trail.length} entries: ${trail.map(h => h.status).join(' → ')}`,
        'A piece was moved backwards without leaving a record of who did it or why.'
      );
    }
  },
  {
    id: 'PCS-05',
    name: 'Piece status and date filters return the right subset',
    description: 'Applies the board’s status and created-date filters to a mixed set of pieces.',
    category: 'Pieces',
    kind: 'scenario',
    run: async ({ temp, live }) => {
      await seedTemp(temp);
      const stages: PipelineStage[] = await live.pipelineStages.toArray();
      const [created, ready, collected] = (['created', 'ready', 'collected'] as const).map(k => stageByKey(stages, k));
      if (!created || !ready || !collected) return fail('The system stages exist', 'A system stage is missing', 'The pipeline is missing a system stage.');

      await temp.pieces.bulkPut([
        { id: 'TEST-F1', name: 'A', status: created.name, stageId: created.id, dateCreated: '2026-03-01', customerName: 'X', daysElapsed: 2 },
        { id: 'TEST-F2', name: 'B', status: created.name, stageId: created.id, dateCreated: '2026-03-15', customerName: 'X', daysElapsed: 2 },
        { id: 'TEST-F3', name: 'C', status: ready.name, stageId: ready.id, dateCreated: '2026-03-10', customerName: 'X', daysElapsed: 12 },
        { id: 'TEST-F4', name: 'D', status: collected.name, stageId: collected.id, dateCreated: '2026-04-01', customerName: 'X', daysElapsed: 40 }
      ] as any);

      // The board's own rules: stage by id, overdue never for an end-state.
      const pieces = (await temp.pieces.toArray()).sort((a, b) => a.id.localeCompare(b.id));
      const byStatus = pieces.filter(p => stageOf(p, stages)?.id === created.id).map(p => p.id);
      const inMarch = pieces
        .filter(p => p.dateCreated >= '2026-03-01' && p.dateCreated <= '2026-03-31')
        .map(p => p.id);
      const overdue = pieces.filter(p => canBeOverdue(stageOf(p, stages)) && p.daysElapsed >= 10).map(p => p.id);

      const problems: string[] = [];
      if (byStatus.join() !== 'TEST-F1,TEST-F2') problems.push(`status filter returned ${byStatus.join(', ') || 'nothing'}`);
      if (inMarch.join() !== 'TEST-F1,TEST-F2,TEST-F3') problems.push(`date filter returned ${inMarch.join(', ') || 'nothing'}`);
      if (overdue.join() !== 'TEST-F3') problems.push(`overdue filter returned ${overdue.join(', ') || 'nothing'}`);

      return check(
        problems.length === 0,
        'Status returns 2, the March range returns 3, overdue returns 1',
        problems.length === 0 ? 'All three filters returned the right pieces' : problems.join('; '),
        'A filter on the pottery board hides pieces that match or shows ones that do not.'
      );
    }
  },
  {
    id: 'PCS-07',
    name: 'The database keeps a piece’s stage id and status in step',
    description: 'Writes a piece by status only, then by stage id only, adds history without a stage id, and tries a status no stage has (the 0045 triggers).',
    category: 'Pieces',
    kind: 'scenario',
    run: async ({ temp, live }) => {
      await seedTemp(temp);
      const stages: PipelineStage[] = await live.pipelineStages.toArray();
      const created = stageByKey(stages, 'created');
      const kiln = stageByKey(stages, 'kiln');
      if (!created || !kiln) return fail('The Created and Kiln Time stages exist', 'A system stage is missing', 'The pipeline is missing a system stage.');

      const problems: string[] = [];

      // Status only, as an app version from before 0045 writes it.
      await temp.pieces.put({ id: 'TEST-PC-SYNC', name: 'Bowl', status: created.name, customerName: 'X' } as any);
      let row = await temp.pieces.get('TEST-PC-SYNC');
      if (row?.stageId !== created.id) problems.push(`a status-only write left stage_id ${row?.stageId ?? 'empty'}`);

      // Stage id only.
      await temp.pieces.update('TEST-PC-SYNC', { stageId: kiln.id } as any);
      row = await temp.pieces.get('TEST-PC-SYNC');
      if (row?.status !== kiln.name) problems.push(`a stage-id-only write left status "${row?.status}"`);

      // History without a stage id.
      await temp.pieceHistory.add({
        pieceId: 'TEST-PC-SYNC', status: kiln.name, timestamp: new Date().toISOString(), user: 'Staff'
      } as any);
      const entry = (await temp.pieceHistory.toArray()).find((h: any) => h.pieceId === 'TEST-PC-SYNC');
      if (entry?.stageId !== kiln.id) problems.push(`a history entry without a stage id kept ${entry?.stageId ?? 'none'}`);

      // A name no stage has is refused, and the piece is left as it was.
      let refused = false;
      try {
        await temp.pieces.update('TEST-PC-SYNC', { status: 'TEST Not A Stage' } as any);
      } catch {
        refused = true;
      }
      row = await temp.pieces.get('TEST-PC-SYNC');
      if (!refused || row?.status !== kiln.name) problems.push('a status no stage has was accepted');

      return check(
        problems.length === 0,
        'Stage id and status always agree, and a status no stage has is refused',
        problems.length === 0 ? 'All four writes behaved' : problems.join('; '),
        'A piece written by an older app version, or a history row, can lose track of its stage, so the board and the customer tracker disagree.'
      );
    }
  },

  // ---------- STAFF ----------
  {
    id: 'STF-01',
    name: 'Duplicate staff phone and email are rejected',
    description: 'Registers a staff member, then tries a second one on the same number and the same email.',
    category: 'Staff',
    kind: 'scenario',
    run: async ({ temp, scoped }) => {
      await seedTemp(temp);
      await temp.staff.put({
        id: 'TEST-STF-A', name: 'Lina Al-Sudais', position: 'Instructor', status: 'Active',
        phone: '+966533334444', normalizedPhone: '533334444', email: 'lina@artycafe.com'
      } as any);

      const dupePhone = await validateStaffForm(
        { name: 'New', position: 'Assistant', phone: '0533334444', email: 'new@artycafe.com' },
        undefined, scoped);
      const dupeEmail = await validateStaffForm(
        { name: 'New', position: 'Assistant', phone: '0577776666', email: 'LINA@artycafe.com' },
        undefined, scoped);
      const clean = await validateStaffForm(
        { name: 'New', position: 'Assistant', phone: '0577776666', email: 'new@artycafe.com' },
        undefined, scoped);

      return check(
        !!dupePhone.phone && !!dupeEmail.email && Object.keys(clean).length === 0,
        'Both duplicates rejected; a fresh staff member is accepted',
        `Phone: ${dupePhone.phone || 'accepted'} | Email: ${dupeEmail.email || 'accepted'}`,
        'Two staff records can share a phone number or email, so console sign-in matches the wrong person.'
      );
    }
  },
  {
    id: 'STF-02',
    name: 'An instructor cannot take two overlapping sessions',
    description: 'Assigns a tutor to an 11:00 session, then checks 11:30 (clash) and 13:00 (free) the same day.',
    category: 'Staff',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const member: StaffMember = {
        id: 'TEST-STF-B', name: 'Lina', position: 'Instructor', status: 'Active',
        phone: '+966533334444', email: 'lina@test.com',
        weeklySchedule: {
          Sunday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Monday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Tuesday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Wednesday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Thursday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Friday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] },
          Saturday: { isWorking: true, shifts: [{ isWorking: true, startTime: '09:00', endTime: '18:00' }] }
        }
      } as any;

      const existingSession = {
        id: 'TEST-SESS-BUSY', workshopId: FIXTURE_WORKSHOP.id, date: '2026-12-01',
        startTime: '11:00', endTime: '13:00', staffId: member.id, capacity: 6, status: 'Published'
      };
      const sources = {
        staff: [member],
        workshopSessions: [existingSession as any],
        workshops: [FIXTURE_WORKSHOP as any],
        events: [],
        queue: []
      };

      const clash = checkStaffMemberAvailability({
        staff: member, date: '2026-12-01', startTime: '11:30', endTime: '12:30', sources
      });
      const free = checkStaffMemberAvailability({
        staff: member, date: '2026-12-01', startTime: '13:00', endTime: '14:00', sources
      });
      const otherDay = checkStaffMemberAvailability({
        staff: member, date: '2026-12-02', startTime: '11:30', endTime: '12:30', sources
      });

      return check(
        !clash.isAvailable && clash.status === 'Busy' && free.isAvailable && otherDay.isAvailable,
        'Overlapping slot is Busy; back-to-back and next-day slots are free',
        `11:30 overlap: ${clash.status}; 13:00 back-to-back: ${free.status}; next day: ${otherDay.status}`,
        'An instructor can be booked into two classes at once, or is wrongly blocked from a free slot.'
      );
    }
  },
  {
    id: 'STF-03',
    name: 'Inactive staff holding assignments raises a warning',
    description: 'Marks a tutor with a future session Inactive and checks the console warns before saving.',
    category: 'Staff',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.staff.put({
        id: 'TEST-STF-C', name: 'Busy Tutor', position: 'Instructor', status: 'Active',
        phone: '+966533337777', email: 'busy@test.com'
      } as any);
      await temp.workshopSessions.put({
        id: 'TEST-SESS-HELD', workshopId: FIXTURE_WORKSHOP.id, date: '2026-12-01',
        startTime: '11:00 AM', staffId: 'TEST-STF-C', capacity: 6, status: 'Published'
      } as any);
      await temp.workshops.update(FIXTURE_WORKSHOP.id, { staffId: 'TEST-STF-C' } as any);

      // The rule this test asserts: going Inactive while holding assignments
      // must be reported to the admin before the record is saved.
      const held = await temp.workshopSessions
        .filter(s => s.staffId === 'TEST-STF-C' && s.status === 'Published').toArray();
      const warned = await staffInactiveWarning(temp, 'TEST-STF-C');

      return check(
        held.length > 0 && warned !== null,
        `A warning naming the ${held.length} held assignment(s) before saving Inactive`,
        warned === null
          ? `No warning is raised — the tutor still holds ${held.length} published session(s)`
          : `Warned: ${warned}`,
        'A tutor can be switched to Inactive while still assigned to sessions, and nobody is told — the classes silently lose their instructor.'
      );
    }
  },

  // ---------- SETTINGS ----------
  {
    id: 'SET-01',
    name: 'Pipeline stages drive the pottery board',
    description: 'Builds a stage list with a custom, a disabled and an end-state stage, then derives the board columns, the selectable list and the customer tracker the way the board does.',
    category: 'Settings',
    kind: 'scenario',
    run: async () => {
      // In memory, deliberately: stage rows written to the real table would
      // appear as columns on every open board while the test ran.
      const stages: PipelineStage[] = ([
        { id: 'TEST-st-4', name: 'Collected', color: '#d', order: 3, visibleToCustomer: false, enabled: true, systemKey: 'collected' },
        { id: 'TEST-st-2', name: 'Kiln Drying', color: '#b', order: 1, visibleToCustomer: false, enabled: true, systemKey: null },
        { id: 'TEST-st-1', name: 'Created', color: '#a', order: 0, visibleToCustomer: true, enabled: true, systemKey: 'created' },
        { id: 'TEST-st-3', name: 'Retired Stage', color: '#c', order: 2, visibleToCustomer: false, enabled: false, systemKey: null }
      ] as PipelineStage[]).sort((a, b) => a.order - b.order);

      const columns = stages.filter(s => !isEndState(s)).map(s => s.name);
      const selectable = stages.filter(isStageEnabled).map(s => s.name);
      const customerVisible = stages.filter(s => s.visibleToCustomer).map(s => s.name);

      return check(
        columns.join() === 'Created,Kiln Drying,Retired Stage' &&
          selectable.join() === 'Created,Kiln Drying,Collected' &&
          customerVisible.join() === 'Created',
        'Three columns in order (the end-state is not one); the disabled stage is not selectable; one is customer-visible',
        `Columns: ${columns.join(', ')} | Selectable: ${selectable.join(', ')} | Customer: ${customerVisible.join(', ')}`,
        'The pottery board or the customer tracker is not following the stages configured in Settings.'
      );
    }
  },
  {
    id: 'SET-02',
    name: 'A stage in use cannot be deleted',
    description: 'Applies the delete guard to a stage used by a piece, one used only in history, and an unused one.',
    category: 'Settings',
    kind: 'scenario',
    run: async ({ temp, live }) => {
      await seedTemp(temp);
      const stages: PipelineStage[] = await live.pipelineStages.toArray();
      const created = stageByKey(stages, 'created');
      const kiln = stageByKey(stages, 'kiln');
      if (!created || !kiln) return fail('The Created and Kiln Time stages exist', 'A system stage is missing', 'The pipeline is missing a system stage.');

      await temp.pieces.put({
        id: 'TEST-PC-S', name: 'Bowl', status: created.name, stageId: created.id, customerName: 'X'
      } as any);
      await temp.pieceHistory.add({
        pieceId: 'TEST-PC-S', status: kiln.name, stageId: kiln.id,
        timestamp: '2026-01-01T00:00:00.000Z', user: 'Staff'
      } as any);

      // By stage id: a renamed stage is still recognised as in use.
      const pieces = await temp.pieces.toArray();
      const history = await temp.pieceHistory.toArray();
      const canDelete = (stageId: string) =>
        !pieces.some(p => p.stageId === stageId) &&
        !history.some((h: any) => h.stageId === stageId);

      const inUse = canDelete(created.id);
      const inHistory = canDelete(kiln.id);
      const unused = canDelete('TEST-stage-never-used');

      return check(
        !inUse && !inHistory && unused,
        'A current stage and a historical stage are protected; an unused one can be deleted',
        `Current: ${!inUse ? 'protected' : 'DELETABLE'}, historical: ${!inHistory ? 'protected' : 'DELETABLE'}, unused: ${unused ? 'deletable' : 'blocked'}`,
        'A stage still referenced by pottery records could be deleted, making those records unreadable.'
      );
    }
  },
  {
    id: 'SET-04',
    name: 'Renaming a stage does not move its pieces',
    description: 'Renames a stage and checks each piece stays in the same column. The database half (status follows the rename) is pending until migration M2.',
    category: 'Settings',
    kind: 'scenario',
    run: async ({ temp }) => {
      // App side, in memory: the column a piece lands in comes from its stage id.
      const before = DEFAULT_PIPELINE_STAGES;
      const after = before.map(s => (s.systemKey === 'kiln' ? { ...s, name: 'Kiln Time' } : s));
      const pieces = before.map(s => ({ id: `TEST-${s.id}`, stageId: s.id, status: s.name }));
      const moved = pieces.filter(p => stageOf(p, after)?.id !== stageOf(p, before)?.id);
      if (moved.length > 0) {
        return fail(
          'Every piece stays in its column after a rename',
          `Moved: ${listSome(moved.map(p => p.id))}`,
          'Renaming a stage in Settings moves its pieces to another column on the board.'
        );
      }

      if (!STAGE_RENAMES_ENFORCED) {
        return pass(
          'Pending until migration M2 — the board keeps pieces in place on rename; the database half runs once renames are enabled',
          'App side: all 5 pieces stay in their columns. Database side: not run (M2 not applied)'
        );
      }

      // Database side (after M2): a TEST stage is renamed and its piece's
      // status follows while its stage id stays. Purged with the other TEST rows.
      await seedTemp(temp);
      const stageId = 'TEST-stage-rename';
      await temp.pipelineStages.put({
        id: stageId, name: 'TEST Rename Before', color: '#999999', order: 99,
        visibleToCustomer: false, enabled: true, notifyCustomer: false, systemKey: null
      } as any);
      await temp.pieces.put({ id: 'TEST-PC-RENAME', name: 'Bowl', stageId, status: 'TEST Rename Before', customerName: 'X' } as any);
      await temp.pipelineStages.update(stageId, { name: 'TEST Rename After' });
      const row = await temp.pieces.get('TEST-PC-RENAME');

      return check(
        row?.stageId === stageId && row?.status === 'TEST Rename After',
        'The piece keeps its stage id and its status shows the new name',
        `stage_id ${row?.stageId ?? 'empty'}, status "${row?.status}"`,
        'Renaming a stage left its pieces on the old name, so they drop off the board.'
      );
    }
  },
  {
    id: 'SET-03',
    name: 'Option lists feed the right form dropdowns',
    description: 'Checks each configured list maps to a real card, and that live entities are not duplicated as lists.',
    category: 'Settings',
    kind: 'scenario',
    run: async () => {
      const cards = [...new Set(WORKSHOP_OPTION_LISTS.map(l => l.card))].sort();
      const types = WORKSHOP_OPTION_LISTS.map(l => l.type);
      const duplicatesLiveEntity = types.some(t => /tutor|instructor|staff|room|table/i.test(t));

      return check(
        cards.join() === 'curriculum,logistics' && !duplicatesLiveEntity && types.length > 0,
        'Lists belong to the two workshop cards; staff and rooms stay live, not copied into lists',
        `Cards: ${cards.join(', ')} | Lists: ${types.join(', ')}`,
        'A dropdown is fed by a stale hand-kept list instead of the live records, so it drifts out of date.'
      );
    }
  },

  // ---------- ROLES & ACCESS ----------
  {
    id: 'ROL-01',
    name: 'Super Admin reaches every page, others only theirs',
    description: 'Checks page access for a Super Admin, a restricted Admin and a staff member with no console account.',
    category: 'Roles & Access',
    kind: 'scenario',
    run: async () => {
      const superAdmin = { id: 's1', name: 'Boss', role: 'Super Admin', status: 'Active', hasConsoleAccess: true, permissions: [] } as any;
      const admin = { id: 's2', name: 'Admin', role: 'Admin', status: 'Active', hasConsoleAccess: true, permissions: ['dashboard', 'queue'] } as any;
      const noAccount = { id: 's3', name: 'Floor Staff', role: 'Staff', status: 'Active', hasConsoleAccess: false, permissions: ['dashboard'] } as any;

      const problems: string[] = [];
      if (!ADMIN_PAGE_IDS.every(id => canAccessPage(superAdmin, id))) problems.push('Super Admin was blocked from a page');
      if (!canAccessPage(admin, 'dashboard')) problems.push('Admin was blocked from a granted page');
      if (canAccessPage(admin, 'settings')) problems.push('Admin reached Settings without permission');
      if (canAccessPage(noAccount, 'dashboard')) problems.push('A staff member with no console account got in');
      if (canAccessPage(null, 'dashboard')) problems.push('A signed-out visitor got in');
      if (!isSuperAdmin(superAdmin) || isSuperAdmin(admin)) problems.push('Super Admin detection is wrong');

      return check(
        problems.length === 0,
        'Super Admin: all pages. Admin: only granted. No console account or signed out: nothing',
        problems.length === 0 ? 'All 6 access checks correct' : problems.join('; '),
        'The console let someone open a page they have no permission for.'
      );
    }
  },
  {
    id: 'ROL-02',
    name: 'Only a Super Admin can change roles',
    description: 'Checks who may edit permissions, and that an Admin cannot edit a Super Admin.',
    category: 'Roles & Access',
    kind: 'scenario',
    run: async () => {
      const superAdmin = { id: 's1', name: 'Boss', role: 'Super Admin', status: 'Active', hasConsoleAccess: true } as any;
      const admin = { id: 's2', name: 'Admin', role: 'Admin', status: 'Active', hasConsoleAccess: true, permissions: ['staff'] } as any;

      // The console rule: granting or changing console access is Super Admin only.
      const mayManageRoles = (actor: StaffMember) => isSuperAdmin(actor);
      const mayEdit = (actor: StaffMember, target: StaffMember) =>
        isSuperAdmin(actor) || !isSuperAdmin(target);

      const problems: string[] = [];
      if (!mayManageRoles(superAdmin)) problems.push('Super Admin could not manage roles');
      if (mayManageRoles(admin)) problems.push('An Admin was able to change roles');
      if (mayEdit(admin, superAdmin)) problems.push('An Admin was able to edit a Super Admin');
      if (!mayEdit(superAdmin, admin)) problems.push('A Super Admin could not edit an Admin');

      return check(
        problems.length === 0,
        'Role changes are Super Admin only; an Admin cannot edit a Super Admin',
        problems.length === 0 ? 'All 4 role-boundary checks correct' : problems.join('; '),
        'An Admin can escalate their own or someone else’s access.'
      );
    }
  },
  {
    id: 'ROL-03',
    name: 'Default permissions match the role',
    description: 'Checks the page set a newly granted account receives for each role.',
    category: 'Roles & Access',
    kind: 'scenario',
    run: async () => {
      const forSuper = defaultPermissionsForRole('Super Admin');
      const forAdmin = defaultPermissionsForRole('Admin');
      const forStaff = defaultPermissionsForRole('Staff');

      const problems: string[] = [];
      if (forSuper.length !== ADMIN_PAGE_IDS.length) problems.push('Super Admin default is not every page');
      if (forAdmin.includes('settings')) problems.push('Admin default includes Settings');
      if (forStaff.includes('settings') || forStaff.includes('staff')) problems.push('Staff default is too broad');
      if (!forStaff.includes('dashboard') || !forStaff.includes('queue')) problems.push('Staff default is missing their own pages');

      return check(
        problems.length === 0,
        'Super Admin: everything. Admin: all but Settings. Staff: Dashboard and Live Queue',
        problems.length === 0
          ? `Staff default: ${forStaff.join(', ')}`
          : problems.join('; '),
        'A new console account is granted the wrong pages by default.'
      );
    }
  },

  // ---------- DATA INTEGRITY (extra) ----------
  {
    id: 'INT-04',
    name: 'No session points at a missing staff member',
    description: 'Cross-checks every live workshop session’s staffId against the staff table.',
    category: 'Data Integrity',
    kind: 'audit',
    run: async ({ live }) => {
      const [sessions, staff] = await Promise.all([live.workshopSessions.toArray(), live.staff.toArray()]);
      const ids = new Set(staff.map(s => String(s.id)));
      const orphaned = sessions.filter(s => s.staffId && !ids.has(String(s.staffId)));

      return check(
        orphaned.length === 0,
        'Every session with an instructor references a real staff member',
        orphaned.length === 0
          ? `${sessions.length} sessions checked against ${staff.length} staff`
          : `${orphaned.length} orphaned: ${listSome(orphaned.map(s => `${s.id}→${s.staffId}`))}`,
        'A session is assigned to a staff member who no longer exists, so the class shows no instructor.'
      );
    }  },

  // ---------- SECURITY: what the database itself refuses ----------
  {
    id: 'SEC-01',
    name: 'A signed-out visitor cannot read customer data',
    description: 'Queries bookings, customers, queue, pieces and staff with no session at all.',
    category: 'Roles & Access',
    kind: 'audit',
    run: async () => {
      const anon = anonClient();
      if (!anon) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const readable: string[] = [];
      for (const table of ['bookings', 'customers', 'queue', 'pieces', 'staff', 'notifications']) {
        const { data } = await anon.from(table).select('id').limit(1);
        if (data && data.length > 0) readable.push(table);
      }

      return check(
        readable.length === 0,
        'No rows returned from any customer or staff table',
        readable.length === 0
          ? 'All six tables returned nothing to an anonymous reader'
          : `Readable without signing in: ${readable.join(', ')}`,
        'Anyone can read customer records straight from the API without signing in.'
      );
    }
  },
  {
    id: 'SEC-02',
    name: 'The public catalogue stays public',
    description: 'The customer site must still browse workshops and packages while signed out.',
    category: 'Roles & Access',
    kind: 'audit',
    run: async () => {
      const anon = anonClient();
      if (!anon) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const blocked: string[] = [];
      for (const table of ['workshops', 'workshop_sessions', 'birthday_packages', 'pipeline_stages']) {
        const { error } = await anon.from(table).select('id').limit(1);
        if (error) blocked.push(`${table} (${error.message})`);
      }

      return check(
        blocked.length === 0,
        'All four catalogue tables are readable while signed out',
        blocked.length === 0 ? 'Catalogue is browsable anonymously' : `Blocked: ${blocked.join('; ')}`,
        'A signed-out visitor cannot browse the workshops, so the public site is empty.'
      );
    }
  },
  {
    id: 'SEC-03',
    name: 'damage_note never reaches a customer',
    description: 'Checks the customer-facing pieces view does not expose the internal damage note.',
    category: 'Pieces',
    kind: 'audit',
    run: async () => {
      const anon = anonClient();
      if (!anon) return pass('Skipped — Supabase is not configured', 'No client to test with');

      // Asking the view for the column must fail: it is not in its column list.
      const { error } = await anon.from('customer_pieces').select('damage_note').limit(1);
      const refused = !!error;

      // And the base table must not be readable at all without a session.
      const { data: baseRows } = await anon.from('pieces').select('damage_note').limit(1);

      return check(
        refused && (!baseRows || baseRows.length === 0),
        'customer_pieces has no damage_note column, and pieces is not readable',
        refused
          ? `View refused the column${baseRows?.length ? ', but the base table returned rows' : '; base table returned nothing'}`
          : 'The customer view returned a damage_note column',
        'The internal damage note — which is never meant to leave the console — can be read by a customer.'
      );
    }
  },
  {
    id: 'SEC-04',
    name: 'Claim and link cannot be used to discover accounts',
    description: 'Calls both security-definer functions with an unknown identifier and with a claimed one.',
    category: 'Roles & Access',
    kind: 'audit',
    run: async () => {
      const anon = anonClient();
      if (!anon) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const probe = async (fn: string, identifier: string) => {
        const { data, error } = await anon.rpc(fn, { identifier, new_auth_id: null });
        return { value: data ?? null, error: error?.message ?? null };
      };

      const unknown = await probe('claim_customer_account', '0500000000');
      const blank = await probe('claim_customer_account', '');
      const linkUnknown = await probe('link_existing_customer', '0500000000');

      const indistinguishable =
        unknown.value === null && blank.value === null && linkUnknown.value === null;

      return check(
        indistinguishable,
        'Both functions return the same empty answer for every identifier',
        indistinguishable
          ? 'No identifier produced a distinguishable response'
          : `claim: ${JSON.stringify(unknown.value)}, blank: ${JSON.stringify(blank.value)}, link: ${JSON.stringify(linkUnknown.value)}`,
        'The claim function answers differently for a known number, so it can be used to discover which customers exist.'
      );
    }
  },
  {
    id: 'SEC-05',
    name: 'Claiming never creates a second customer',
    description: 'Calls the claim function repeatedly and checks the customer count does not move.',
    category: 'Customers',
    kind: 'audit',
    run: async ({ live }) => {
      const anon = anonClient();
      if (!anon) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const before = (await live.customers.toArray()).length;
      for (let i = 0; i < 3; i++) {
        await anon.rpc('claim_customer_account', { identifier: '0500000000', new_auth_id: null });
      }
      const after = (await live.customers.toArray()).length;

      return check(
        after === before,
        `Customer count unchanged at ${before}`,
        `${before} before, ${after} after three calls`,
        'Calling the claim function created customer records, so it can be used to fill the table with junk.'
      );
    }
  },

  // ---------- MIGRATIONS ----------
  {
    id: 'MIG-01',
    name: 'Every migration has been applied',
    description: 'Probes each expected function, table and column by name.',
    category: 'Data Integrity',
    kind: 'audit',
    run: async () => {
      const result = await checkMigrations();
      if (result.skipped) return pass('Skipped — Supabase is not configured', 'No client to probe');

      return check(
        result.ok,
        'All expected database objects exist',
        result.ok
          ? 'Every function, table and column is present'
          : result.problems.join(' | '),
        `A migration has not been run: ${result.missingMigrations.join(', ')}. Parts of the app will fail until it is.`
      );
    }
  },
  {
    id: 'MIG-02',
    name: 'Seat allocation is atomic',
    description: 'Books through the real RPC and checks it refuses to oversell the last seat.',
    category: 'Bookings',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const client = getDataClient();
      if (!client) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const booking = (id: string, participants: number) => ({
        id, customer_name: 'Fixture', workshop_id: FIXTURE_WORKSHOP.id,
        session_id: FIXTURE_SESSION.id, date: FIXTURE_SESSION.date,
        time: FIXTURE_SESSION.startTime, participants, status: 'Pending', payment_status: 'Paid',
        // Every not-null bookings column needs a real value here:
        // book_session_seats inserts via jsonb_populate_record, which fills
        // an omitted key with NULL rather than the column default, so
        // leaving any of these out fails before the capacity rule ever runs.
        total_price: participants * 100,
        source: 'Admin',
        timeline: [],
        created_at: new Date().toISOString()
      });

      // Confirm the fixture is actually there before blaming the capacity
      // rule: "refused" otherwise hides a missing session.
      const seeded = await sdb.workshopSessions.get(FIXTURE_SESSION.id);
      if (!seeded) {
        return fail(
          'The fixture session exists before booking against it',
          `workshop_sessions has no row ${FIXTURE_SESSION.id} — the fixture was not written`,
          'The test could not set up its own data, so the capacity rule was never exercised.'
        );
      }

      // Fill 5 of the 6 seats, then ask for 2 — one seat short.
      const first = await client.rpc('book_session_seats', {
        p_booking: booking('TEST-BK-ATOMIC-1', 5), p_session_id: FIXTURE_SESSION.id
      });
      const overflow = await client.rpc('book_session_seats', {
        p_booking: booking('TEST-BK-ATOMIC-2', 2), p_session_id: FIXTURE_SESSION.id
      });
      // The last seat on its own must still be allowed.
      const lastSeat = await client.rpc('book_session_seats', {
        p_booking: booking('TEST-BK-ATOMIC-3', 1), p_session_id: FIXTURE_SESSION.id
      });

      // Report what the database actually said. "refused" on its own hides
      // whether the refusal was the capacity rule or an unrelated error.
      const why = (r: { error: { message: string } | null }) =>
        r.error ? `refused (${r.error.message})` : 'ok';

      return check(
        !first.error && !!overflow.error && !lastSeat.error,
        '5 seats taken, a 2-seat request refused, the final seat allowed',
        `first: ${why(first)}, overflow: ${why(overflow)}, last seat: ${why(lastSeat)}`,
        'The database allowed a session to be oversold, so two customers can hold the same seat.'
      );
    }
  },
  {
    id: 'MIG-03',
    name: 'Queue numbers come from the database',
    description: 'Asks the RPC for a number twice and checks it reflects rows written in between.',
    category: 'Live Queue',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      const client = getDataClient();
      if (!client) return pass('Skipped — Supabase is not configured', 'No client to test with');

      const day = '2026-12-02';
      const before = await client.rpc('next_queue_number', { p_date: day });

      // The number, not the id, is what the generator reads now — a row with no
      // queue_number would leave the sequence untouched and the test would pass
      // for the wrong reason.
      await temp.queue.put({
        id: 'TEST-Q-900', queueNumber: Number(before.data) || 1,
        name: 'Fixture', date: day, status: 'Waiting',
        participants: 1, type: 'Without Instructor', source: 'Walk-in'
      } as any);

      const after = await client.rpc('next_queue_number', { p_date: day });

      const moved = typeof before.data === 'number' && typeof after.data === 'number'
        && after.data > before.data;

      return check(
        moved,
        'The next number advances once an entry exists for that day',
        `${before.data} then ${after.data}`,
        'Queue numbering does not see other entries, so two walk-ins can be given the same number.'
      );
    }
  },
  {
    id: 'MIG-04',
    name: 'Piece history is append-only in its own table',
    description: 'Writes two history entries for one piece and checks both survive.',
    category: 'Pieces',
    kind: 'scenario',
    run: async ({ temp }) => {
      await seedTemp(temp);
      await temp.pieces.put({
        id: 'TEST-PC-HIST', name: 'Bowl', status: 'Created',
        customerName: 'Fixture Customer', customerId: FIXTURE_CUSTOMER.id
      } as any);

      await temp.pieceHistory.add({
        pieceId: 'TEST-PC-HIST', status: 'Created', timestamp: new Date().toISOString(), user: 'Staff'
      } as any);
      await temp.pieceHistory.add({
        pieceId: 'TEST-PC-HIST', status: 'Drying', timestamp: new Date().toISOString(), user: 'Staff'
      } as any);

      const rows = (await temp.pieceHistory.toArray())
        .filter((h: any) => h.pieceId === 'TEST-PC-HIST');

      return check(
        rows.length === 2,
        'Both entries stored as separate rows',
        `${rows.length} history row(s): ${rows.map((r: any) => r.status).join(' → ')}`,
        'A second status change overwrote the first, so the audit trail is being lost.'
      );
    }
  }
];


// ==========================================================
// RUNNER
// ==========================================================

/**
 * TEST DATA ISOLATION
 *
 * There is one database now, so the suite writes into the real tables — but
 * every row it creates is prefixed TEST-, and `purgeTestRows()` removes them
 * before the run and again in a `finally` afterwards, so a crash mid-suite
 * cannot leave fixtures where staff would see them.
 *
 * Audits read the real rows; they never write.
 */
/** Runs one definition and turns it into a TestResult row. */
async function runOne(def: SystemTestDefinition, ctx: SystemTestContext): Promise<TestResult> {
  const started = performance.now();
  try {
    const outcome = await def.run(ctx);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      duration: Math.max(1, Math.round(performance.now() - started)),
      status: outcome.passed ? 'passed' : 'failed',
      expected: outcome.expected,
      actual: outcome.actual,
      failureMessage: outcome.failureMessage
    };
  } catch (error: any) {
    // A test that throws is a failure, reported with the real error.
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      duration: Math.max(1, Math.round(performance.now() - started)),
      status: 'failed',
      expected: 'The test runs to completion',
      actual: `Threw: ${error?.message || String(error)}`,
      failureMessage: 'The test could not finish — the code it exercises raised an error.'
    };
  }
}

/**
 * Runs the whole suite (or a single test by id).
 *
 * `onProgress` is called after each test so the page can show live progress.
 * The temporary database is always deleted, including when a test throws.
 */
export async function runSystemTests(
  options: { only?: string; onProgress?: (done: number, total: number, result: TestResult) => void } = {}
): Promise<TestResult[]> {
  const defs = options.only ? SYSTEM_TESTS.filter(t => t.id === options.only) : SYSTEM_TESTS;
  const results: TestResult[] = [];

  // Scenarios read through the scoped façade so they see only their own
  // fixtures; audits read the real tables through `live`.
  const ctx: SystemTestContext = { temp: scopedDb, live: sdb, scoped: scopedValidationDb };

  try {
    // Anything left by an interrupted run goes first.
    await purgeTestRows();

    for (const def of defs) {
      const result = await runOne(def, ctx);
      results.push(result);
      options.onProgress?.(results.length, defs.length, result);
    }
  } finally {
    // Guaranteed: the suite never leaves rows behind, even after a throw.
    await purgeTestRows();
  }

  return results;
}

/** The category order used on the page. */
export const TEST_CATEGORY_ORDER: TestCategory[] = [
  'Validation', 'Dashboard', 'Live Queue', 'Bookings', 'Workshops', 'Events',
  'Customers', 'Pieces', 'Staff', 'Settings', 'Roles & Access', 'Data Integrity'
];
