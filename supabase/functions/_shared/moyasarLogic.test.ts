/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for moyasarLogic.ts and confirmPayment.ts. No test
 * framework — both files have zero Deno dependencies so this runs under tsx:
 *
 *   npx tsx supabase/functions/_shared/moyasarLogic.test.ts
 *
 * confirmPayment is driven with a fake Supabase client and a fake Moyasar, so
 * what is tested is the decision flow: what is fetched, recorded, confirmed,
 * alerted and answered. confirm_booking_payment() itself is tested in SQL
 * (migration 0046, manual tests).
 */

import {
  isMoyasarPaymentId,
  keyMode,
  secretKeyProblem,
  readPayment,
  auditCopy,
  stateForUnpaidStatus,
  stateForOutcome,
  staffAlertFor
} from './moyasarLogic.ts';
import { verifyAndConfirmPayment, type AdminClient } from './confirmPayment.ts';
import { fetchMoyasarPayment } from './moyasar.ts';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: expected ${e}, got ${a}`);
  }
}

const PID = '79cced57-9deb-4c4b-8f48-59c124f79688';
const PID2 = '11111111-2222-4333-8444-555555555555';

function payment(over: Record<string, unknown> = {}) {
  return {
    id: PID,
    status: 'paid',
    amount: 10000,
    currency: 'SAR',
    metadata: { booking_id: 'ART-1234567' },
    source: { type: 'creditcard', company: 'visa', name: 'Test User', number: '4111-11XX-XXXX-1111', message: 'APPROVED', transaction_url: 'https://secret.example', token: 'tok_x' },
    ip: '1.2.3.4',
    ...over
  };
}

// -----------------------------------------------------------------------------
console.log('ids and keys');
assertEqual(isMoyasarPaymentId(PID), true, 'uuid accepted');
assertEqual(isMoyasarPaymentId('../payments'), false, 'path traversal refused');
assertEqual(isMoyasarPaymentId(`${PID}?x=1`), false, 'query string refused');
assertEqual(isMoyasarPaymentId(42), false, 'number refused');
assertEqual(keyMode('sk_test_abc'), 'test', 'sk_test -> test');
assertEqual(keyMode('pk_live_abc'), 'live', 'pk_live -> live');
assertEqual(keyMode('abc'), null, 'no prefix -> null');
assertEqual(secretKeyProblem('sk_test_abc', ''), null, 'test key, no mode set: fine');
assertEqual(secretKeyProblem('sk_live_abc', 'live'), null, 'live key, live mode: fine');
assertEqual(secretKeyProblem('sk_test_abc', 'LIVE') !== null, true, 'test key in live mode: refused');
assertEqual(secretKeyProblem('pk_test_abc', '') !== null, true, 'publishable key as secret: refused');
assertEqual(secretKeyProblem('', '') !== null, true, 'missing key: refused');

console.log('readPayment / auditCopy');
assertEqual(readPayment(payment()), {
  id: PID, status: 'paid', amountHalalas: 10000, currency: 'SAR',
  bookingId: 'ART-1234567', sourceType: 'creditcard', message: 'APPROVED'
}, 'fields read');
assertEqual(readPayment(payment({ currency: 'sar' }))?.currency, 'SAR', 'currency upper-cased');
assertEqual(readPayment(payment({ amount: 100.5 }))?.amountHalalas, null, 'non-integer amount is not trusted');
assertEqual(readPayment(payment({ metadata: {} }))?.bookingId, null, 'no booking id in metadata');
assertEqual(readPayment(payment({ metadata: { booking_id: '  ' } }))?.bookingId, null, 'blank booking id');
assertEqual(readPayment({ id: 'nope', status: 'paid' }), null, 'bad id -> unreadable');
assertEqual(readPayment(null), null, 'null -> unreadable');
const audit = auditCopy(payment()) as any;
assertEqual(audit.source.transaction_url, undefined, 'audit copy drops transaction_url');
assertEqual(audit.source.token, undefined, 'audit copy drops token');
assertEqual(audit.ip, undefined, 'audit copy drops ip');
assertEqual(audit.source.number, '4111-11XX-XXXX-1111', 'audit copy keeps the masked number');

console.log('states');
assertEqual(stateForUnpaidStatus('initiated'), 'pending', 'initiated -> pending');
assertEqual(stateForUnpaidStatus('failed'), 'failed', 'failed -> failed');
assertEqual(stateForUnpaidStatus('voided'), 'failed', 'voided -> failed');
assertEqual(stateForOutcome('confirmed'), 'confirmed', 'confirmed');
assertEqual(stateForOutcome('confirmed_late'), 'confirmed', 'confirmed_late -> confirmed');
assertEqual(stateForOutcome('already_confirmed', 'Deposit Paid'), 'confirmed', 'retry of a confirmed payment');
assertEqual(stateForOutcome('already_confirmed', 'Needs Refund'), 'needs_refund', 'retry of a refund case stays a refund case');
assertEqual(stateForOutcome('already_paid_other'), 'duplicate', 'second payment -> duplicate');
assertEqual(stateForOutcome('payment_used_elsewhere'), 'duplicate', 'reused payment -> duplicate');
assertEqual(stateForOutcome('amount_mismatch'), 'mismatch', 'mismatch');
assertEqual(stateForOutcome('not_awaiting'), 'not_awaiting', 'not_awaiting');
assertEqual(stateForOutcome('anything else'), 'not_found', 'unknown -> not_found');
const facts = { id: PID, amountHalalas: 10000, currency: 'SAR', bookingId: 'ART-1' };
assertEqual(staffAlertFor('confirmed', facts), null, 'no alert when confirmed');
assertEqual(staffAlertFor('needs_refund', facts), null, 'no alert here for needs_refund (the SQL alerts)');
assertEqual(staffAlertFor('already_paid_other', facts), null, 'no alert here for already_paid_other (the SQL alerts)');
assertEqual(staffAlertFor('amount_mismatch', facts)?.message.includes('100.00 SAR'), true, 'mismatch alert names the amount');
assertEqual(staffAlertFor('not_found', { ...facts, bookingId: null })?.message.includes('(none)'), true, 'unknown booking alert');

// -----------------------------------------------------------------------------
// Fakes for the confirm flow.

interface FakeState {
  bookings: Record<string, Record<string, any>>;
  bookingPayments: Record<string, Record<string, any>>;
  notifications: Record<string, any>[];
  rpcCalls: Record<string, unknown>[];
  rpcResult: { outcome: string; booking_payment_status: string | null } | null;
  rpcError?: string;
  failSelectOn?: string;
}

function fakeAdmin(state: FakeState): AdminClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let pendingUpdate: Record<string, unknown> | null = null;
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: unknown) {
          filters[col] = val;
          if (pendingUpdate) {
            const rows = table === 'booking_payments' ? state.bookingPayments : state.bookings;
            const row = rows[String(val)];
            if (row) Object.assign(row, pendingUpdate);
            return Promise.resolve({ data: null, error: null });
          }
          return builder;
        },
        maybeSingle() {
          if (state.failSelectOn === table) return Promise.resolve({ data: null, error: { message: 'db down' } });
          const rows = table === 'booking_payments' ? state.bookingPayments : state.bookings;
          return Promise.resolve({ data: rows[String(filters.id)] ?? null, error: null });
        },
        upsert(row: Record<string, any>) {
          state.bookingPayments[row.id] = { ...(state.bookingPayments[row.id] ?? {}), ...row };
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) { pendingUpdate = patch; return builder; },
        insert(row: Record<string, any>) {
          if (table === 'notifications') state.notifications.push(row);
          return Promise.resolve({ error: null });
        }
      };
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, ...args });
      if (state.rpcError) return Promise.resolve({ data: null, error: { message: state.rpcError } });
      return Promise.resolve({ data: state.rpcResult ? [state.rpcResult] : [], error: null });
    }
  };
}

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    bookings: {
      'ART-1234567': {
        id: 'ART-1234567', workshop_title: 'Wheel Basics', date: '2099-02-01', time: '10:00',
        participants: 2, payment_status: 'Deposit Paid', payment_mode: 'deposit', online_amount: '100.00',
        total_price: '300.00', customer_phone: '+966500000000'
      }
    },
    bookingPayments: {},
    notifications: [],
    rpcCalls: [],
    rpcResult: { outcome: 'confirmed', booking_payment_status: 'Deposit Paid' },
    ...over
  };
}

function fakeMoyasar(body: unknown, status = 200, seen?: { url?: string; auth?: string }) {
  return async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.auth = (init?.headers as Record<string, string>)?.Authorization;
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

const quiet = () => {};

async function run() {
  console.log('fetchMoyasarPayment');
  {
    const seen: { url?: string; auth?: string } = {};
    const r = await fetchMoyasarPayment(PID, 'sk_test_abc', fakeMoyasar(payment(), 200, seen));
    assertEqual(r.ok, true, 'fetched');
    assertEqual(seen.url, `https://api.moyasar.com/v1/payments/${PID}`, 'GET /v1/payments/{id}');
    assertEqual(seen.auth, `Basic ${btoa('sk_test_abc:')}`, 'Basic auth: secret key, empty password');
    assertEqual((await fetchMoyasarPayment('x', 'k', fakeMoyasar({}))), { ok: false, reason: 'invalid_id' }, 'invalid id: no request made');
    assertEqual((await fetchMoyasarPayment(PID, 'k', fakeMoyasar({}, 404))).ok === false, true, '404 -> not ok');
    const r401 = await fetchMoyasarPayment(PID, 'k', fakeMoyasar({}, 401));
    assertEqual(!r401.ok && r401.reason, 'unauthorized', '401 -> unauthorized');
    const thrown = await fetchMoyasarPayment(PID, 'k', async () => { throw new Error('offline'); });
    assertEqual(!thrown.ok && thrown.reason, 'unavailable', 'network error -> unavailable');
  }

  console.log('verifyAndConfirmPayment');
  {
    // Paid, confirmed.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment()), quiet);
    assertEqual(r.ok && r.state, 'confirmed', 'paid -> confirmed');
    assertEqual(s.rpcCalls, [{ fn: 'confirm_booking_payment', p_booking_id: 'ART-1234567', p_payment_id: PID, p_amount_halalas: 10000, p_currency: 'SAR' }],
      'confirm called with Moyasar\'s amount and currency, not the caller\'s');
    assertEqual(s.bookingPayments[PID]?.outcome, 'confirmed', 'outcome recorded');
    assertEqual(s.bookingPayments[PID]?.booking_id, 'ART-1234567', 'payment linked to booking');
    assertEqual(r.ok && r.booking?.onlineAmount, 100, 'summary returned');
    assertEqual(r.ok && (r.booking as any)?.customerPhone, undefined, 'summary carries no phone');
    assertEqual(s.notifications.length, 0, 'no staff alert');
  }
  {
    // Declined: recorded, nothing confirmed.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID,
      fakeMoyasar(payment({ status: 'failed', source: { type: 'creditcard', message: 'INSUFFICIENT FUNDS' } })), quiet);
    assertEqual(r.ok && r.state, 'failed', 'failed -> failed');
    assertEqual(r.ok && r.message, 'INSUFFICIENT FUNDS', 'decline message passed through');
    assertEqual(s.rpcCalls.length, 0, 'confirm not called for a failed payment');
    assertEqual(s.bookingPayments[PID]?.status, 'failed', 'failed attempt still recorded');
  }
  {
    // 3-D Secure under way.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment({ status: 'initiated' })), quiet);
    assertEqual(r.ok && r.state, 'pending', 'initiated -> pending');
    assertEqual(s.rpcCalls.length, 0, 'confirm not called while initiated');
    assertEqual(s.bookingPayments[PID]?.status, 'initiated', 'initiated payment on record before 3-D Secure');
  }
  {
    // Amount mismatch: alert once, then answered from the record.
    const s = freshState({ rpcResult: { outcome: 'amount_mismatch', booking_payment_status: 'Awaiting Payment' } });
    const admin = fakeAdmin(s);
    const r1 = await verifyAndConfirmPayment(admin, 'sk_test_abc', PID, fakeMoyasar(payment({ amount: 100 })), quiet);
    const r2 = await verifyAndConfirmPayment(admin, 'sk_test_abc', PID, fakeMoyasar(payment({ amount: 100 })), quiet);
    assertEqual(r1.ok && r1.state, 'mismatch', 'mismatch');
    assertEqual(r2.ok && r2.state, 'mismatch', 'retry: still mismatch');
    assertEqual(s.rpcCalls.length, 1, 'retry does not call confirm again');
    assertEqual(s.notifications.length, 1, 'staff alerted once, not per retry');
    assertEqual(r1.ok && r1.booking, undefined, 'no booking summary for a mismatch');
  }
  {
    // Payment names a booking that does not exist.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID,
      fakeMoyasar(payment({ metadata: { booking_id: 'ART-0000000' } })), quiet);
    assertEqual(r.ok && r.state, 'not_found', 'unknown booking -> not_found');
    assertEqual(s.rpcCalls.length, 0, 'confirm not called');
    assertEqual(s.bookingPayments[PID]?.booking_id, null, 'stored without a dangling booking id');
    assertEqual(s.notifications.length, 1, 'staff alerted: money with no booking');
  }
  {
    // Late payment, place gone (SQL alerts; we do not alert twice).
    const s = freshState({ rpcResult: { outcome: 'needs_refund', booking_payment_status: 'Needs Refund' } });
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment()), quiet);
    assertEqual(r.ok && r.state, 'needs_refund', 'needs_refund');
    assertEqual(s.notifications.length, 0, 'no second alert (confirm_booking_payment alerts)');
    // A retry: the SQL answers already_confirmed with status Needs Refund.
    s.rpcResult = { outcome: 'already_confirmed', booking_payment_status: 'Needs Refund' };
    const r2 = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment()), quiet);
    assertEqual(r2.ok && r2.state, 'needs_refund', 'retry stays needs_refund, not confirmed');
  }
  {
    // Moyasar returns a different payment than asked for.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment({ id: PID2 })), quiet);
    assertEqual(!r.ok && r.reason, 'unavailable', 'mismatched id refused');
    assertEqual(s.rpcCalls.length, 0, 'nothing confirmed');
  }
  {
    // Database errors are reported, not swallowed into a success.
    const s = freshState({ rpcError: 'deadlock detected' });
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar(payment()), quiet);
    assertEqual(!r.ok && r.reason, 'database', 'confirm error -> database (retry is safe)');
    const s2 = freshState({ failSelectOn: 'bookings' });
    const r2 = await verifyAndConfirmPayment(fakeAdmin(s2), 'sk_test_abc', PID, fakeMoyasar(payment()), quiet);
    assertEqual(!r2.ok && r2.reason, 'database', 'booking read error -> database');
  }
  {
    // Moyasar says not found / unauthorized.
    const s = freshState();
    const r = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar({}, 404), quiet);
    assertEqual(!r.ok && r.reason, 'not_found', '404 -> not_found');
    const r2 = await verifyAndConfirmPayment(fakeAdmin(s), 'sk_test_abc', PID, fakeMoyasar({}, 401), quiet);
    assertEqual(!r2.ok && r2.reason, 'unauthorized', '401 -> unauthorized');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
