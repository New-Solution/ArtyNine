/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plain-assertion tests for refund-payment (logic.ts) and the shared refund
 * completion used by moyasar-webhook (_shared/refundCompletion.ts). No test
 * framework — same style as the other logic tests:
 *
 *   npx tsx supabase/functions/refund-payment/logic.test.ts
 *
 * The database is an in-memory fake whose claim / release / complete RPCs
 * follow migration 0054's conditional UPDATEs (tests_0054.sql checks the real
 * SQL). Moyasar is a fake fetch that counts every request.
 */

import { authorizeRefundCaller, planRefund, refundBooking, refundIdFrom, VOID_WINDOW_MS } from './logic.ts';
import { applyMoyasarRefundEvent } from '../_shared/refundCompletion.ts';
import { moyasarErrorMessage } from '../_shared/moyasar.ts';
import { refundEvidence } from '../_shared/paymentEvidence.ts';
import { bookingCancellationSms } from '../_shared/bookingSmsTemplates.ts';

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok — ${label}`);
  } else {
    failed++;
    console.error(`  FAIL — ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

const quiet = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));

const NOW = new Date('2026-11-09T12:00:00Z');
const PAY = '11111111-2222-4333-8444-555555555555';
const PAY2 = '66666666-2222-4333-8444-555555555555';
const DAY_AGO = '2026-11-08T12:00:00Z';
const TEN_MIN_AGO = '2026-11-09T11:50:00Z';

// -----------------------------------------------------------------------------
// Fake database (0054 semantics)
// -----------------------------------------------------------------------------
function makeDb(rows: Record<string, any>[]) {
  const bookings = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
  const events: any[] = [];
  const bells: any[] = [];
  const staffAlerts: any[] = [];
  const rpcLog: string[] = [];

  const admin = {
    from(table: string) {
      if (table === 'bookings') {
        return {
          select() {
            return {
              eq(col: string, val: unknown) {
                return {
                  async maybeSingle() {
                    await tick();
                    const b = [...bookings.values()].find((x) => x[col] === val);
                    return { data: b ? { ...b } : null, error: null };
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'moyasar_payment_events') {
        return { insert: async (row: any) => { events.push(row); return { error: null }; } };
      }
      if (table === 'notifications') {
        return { insert: async (row: any) => { staffAlerts.push(row); return { error: null }; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(fn: string, args: Record<string, any>) {
      rpcLog.push(fn);
      await tick();
      const b = bookings.get(args.p_booking_id);
      if (fn === 'claim_booking_refund') {
        const stale = b?.payment_status === 'Refund Processing'
          && (!b.refund_started_at || Date.parse(b.refund_started_at) < NOW.getTime() - 5 * 60_000);
        if (b && b.moyasar_payment_id && (b.payment_status === 'Needs Refund' || stale)) {
          b.payment_status = 'Refund Processing';
          b.refund_started_at = NOW.toISOString();
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (fn === 'release_booking_refund') {
        if (b && b.payment_status === 'Refund Processing') {
          b.payment_status = 'Needs Refund';
          b.refund_started_at = null;
          b.timeline = [...(b.timeline ?? []), `failed: ${args.p_reason}`];
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (fn === 'complete_booking_refund') {
        if (b && b.moyasar_payment_id && b.payment_status === args.p_expected_status) {
          b.payment_status = 'Refunded';
          b.refund_method = args.p_method;
          b.moyasar_refund_id = args.p_refund_id;
          bells.push({ booking: b.id, actor: args.p_actor });
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    }
  };
  return { admin, bookings, events, bells, staffAlerts, rpcLog };
}

// -----------------------------------------------------------------------------
// Fake Moyasar
// -----------------------------------------------------------------------------
interface Reply { status: number; body: any }
function makeMoyasar(payment: Record<string, any>, replies: { void?: Reply; refund?: Reply; get?: Reply } = {}) {
  const calls = { get: 0, void: 0, refund: 0, refundBodies: [] as any[], auth: [] as string[] };
  const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    await tick();
    calls.auth.push(String((init?.headers as any)?.Authorization ?? ''));
    if (init?.method === 'GET') {
      calls.get++;
      return json(replies.get ?? { status: 200, body: { ...payment } });
    }
    if (url.endsWith('/void')) {
      calls.void++;
      const r = replies.void ?? { status: 200, body: { ...payment, status: 'voided' } };
      if (r.status < 300) payment.status = 'voided';
      return json(r);
    }
    if (url.endsWith('/refund')) {
      calls.refund++;
      calls.refundBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      const r = replies.refund ?? { status: 200, body: { ...payment, status: 'refunded', refunded: payment.amount } };
      if (r.status < 300) payment.status = 'refunded';
      return json(r);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls, payment };
}

function makeSms() {
  const sent: { phone: string; message: string }[] = [];
  return { sent, sendSms: async (phone: string, message: string) => { sent.push({ phone, message }); return { success: true }; } };
}

const booking = (over: Record<string, any> = {}) => ({
  id: 'B1',
  payment_status: 'Needs Refund',
  moyasar_payment_id: PAY,
  online_amount_halalas: 15050,
  customer_phone: '+966500000001',
  workshop_title: 'Wheel Throwing',
  date: '2026-12-01',
  ...over
});
const payment = (over: Record<string, any> = {}) => ({
  id: PAY, status: 'paid', amount: 15050, currency: 'SAR', created_at: DAY_AGO,
  metadata: { booking_id: 'B1' }, source: { type: 'creditcard', number: '4111-11XX-XXXX-1111', token: 'tok_secret' },
  ...over
});

function setup(bookingOver: Record<string, any> = {}, paymentOver: Record<string, any> = {}, replies = {}) {
  const db = makeDb([booking(bookingOver)]);
  const moyasar = makeMoyasar(payment(paymentOver), replies);
  const sms = makeSms();
  const deps = { admin: db.admin, secretKey: 'sk_test_abc', sendSms: sms.sendSms, fetchImpl: moyasar.fetchImpl, now: () => NOW, log: quiet };
  return { db, moyasar, sms, deps };
}

async function run() {
  // ---------------------------------------------------------------------------
  console.log('authorizeRefundCaller() — non-staff refused');
  {
    const caller = (answers: Record<string, any>) => ({
      rpc: async (fn: string, args: Record<string, any>) => {
        if (fn !== 'staff_can') throw new Error('only staff_can');
        const a = answers[args.page];
        return a instanceof Error ? { data: null, error: { message: a.message } } : { data: a ?? false, error: null };
      }
    });
    const none = await authorizeRefundCaller(caller({}));
    assertEqual(none, { ok: false, httpStatus: 403, code: 'forbidden', error: 'Only staff with access to Bookings or Events can refund.' }, 'customer / staff without either page -> 403');
    assertEqual((await authorizeRefundCaller(caller({ bookings: true }))).ok, true, 'Bookings access -> allowed');
    assertEqual((await authorizeRefundCaller(caller({ 'events-admin': true }))).ok, true, 'Events access only -> allowed');
    const broken = await authorizeRefundCaller(caller({ bookings: new Error('db down') }));
    assertEqual([broken.ok, (broken as any).httpStatus], [false, 500], 'check failing -> 500, never allowed');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — wrong status / not refundable here');
  for (const [label, over, code, http] of [
    ['Paid booking', { payment_status: 'Paid' }, 'wrong_status', 409],
    ['already Refunded', { payment_status: 'Refunded' }, 'wrong_status', 409],
    ['Deposit Paid', { payment_status: 'Deposit Paid' }, 'wrong_status', 409],
    ['paid at the studio (no Moyasar payment)', { moyasar_payment_id: null }, 'not_online', 409],
    ['no online amount on record', { online_amount_halalas: null }, 'amount_mismatch', 409]
  ] as const) {
    const { db, moyasar, sms, deps } = setup(over);
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([out.httpStatus, (out.body as any).code], [http, code], `${label} -> ${code}`);
    assertEqual([moyasar.calls.get, moyasar.calls.void, moyasar.calls.refund, sms.sent.length], [0, 0, 0, 0], `${label}: Moyasar never called, no SMS`);
    assertEqual(db.rpcLog.includes('claim_booking_refund'), false, `${label}: never claimed`);
    assertEqual(db.bookings.get('B1').payment_status, booking(over).payment_status, `${label}: status unchanged`);
  }
  {
    const { deps } = setup();
    assertEqual((await refundBooking(deps, 'NOPE', 'Staff')).httpStatus, 404, 'unknown booking -> 404');
    assertEqual((await refundBooking(deps, '', 'Staff')).httpStatus, 400, 'missing booking id -> 400');
    assertEqual((await refundBooking(deps, { id: 'B1' }, 'Staff')).httpStatus, 400, 'non-string booking id -> 400');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — amount comes from the database');
  {
    const { db, moyasar, sms, deps } = setup();
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual(out.httpStatus, 200, 'refund of a day-old payment succeeds');
    assertEqual(out.body, { success: true, method: 'refund', amountHalalas: 15050, recorded: true, smsSent: true }, 'response');
    assertEqual(moyasar.calls.refundBodies, [{ amount: 15050 }], 'Moyasar is sent online_amount_halalas from the booking row');
    assertEqual(moyasar.calls.void, 0, 'past the void window: no void attempted');
    assertEqual(moyasar.calls.auth.every((a) => a === `Basic ${Buffer.from('sk_test_abc:').toString('base64')}`), true, 'every request uses the secret key');
    assertEqual(db.bookings.get('B1').payment_status, 'Refunded', 'booking Refunded');
    assertEqual(db.bookings.get('B1').refund_method, 'refund', 'refund_method recorded');
    assertEqual(db.bells.length, 1, 'one bell notification (written by complete_booking_refund)');
    assertEqual(sms.sent, [{
      phone: '+966500000001',
      message: bookingCancellationSms('refunded', { workshopTitle: 'Wheel Throwing', date: '2026-12-01', amount: 150.5 })
    }], 'one SMS, the registered refunded template with 150.5 SAR');
    assertEqual(sms.sent[0]?.message.startsWith('Your booking "Wheel Throwing" on 01/12/2026 was cancelled and 150.5 SAR refunded.'), true, 'SMS wording');
    assertEqual(db.events.map((e) => e.event_type), ['refund-check', 'refund'], 'fetch and refund response both recorded as evidence');
    assertEqual(db.events.every((e) => e.source === 'refund-payment' && e.booking_id === 'B1' && e.moyasar_payment_id === PAY), true, 'evidence rows linked to booking and payment');
    assertEqual(JSON.stringify(db.events).includes('tok_secret'), false, 'card token stripped from evidence');
  }
  {
    // The request is a booking id only; a browser-supplied amount has no path in.
    const { moyasar, deps } = setup();
    await refundBooking(deps, 'B1', 'Staff A');
    assertEqual(moyasar.calls.refundBodies[0], { amount: 15050 }, 'amount is never taken from the request');
  }
  {
    const { db, moyasar, sms, deps } = setup({}, { amount: 20000 });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([out.httpStatus, (out.body as any).code], [409, 'amount_mismatch'], 'Moyasar amount differs from the booking -> refused');
    assertEqual([moyasar.calls.void, moyasar.calls.refund, sms.sent.length], [0, 0, 0], 'nothing sent to Moyasar, no SMS');
    assertEqual(db.bookings.get('B1').payment_status, 'Needs Refund', 'released back to Needs Refund');
  }
  {
    const { db, moyasar, deps } = setup({}, { currency: 'USD' });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, moyasar.calls.refund, db.bookings.get('B1').payment_status], ['amount_mismatch', 0, 'Needs Refund'], 'non-SAR payment -> refused and released');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — double call only refunds once');
  {
    const { db, moyasar, sms, deps } = setup();
    const [a, b] = await Promise.all([refundBooking(deps, 'B1', 'Staff A'), refundBooking(deps, 'B1', 'Staff B')]);
    const codes = [a, b].map((o) => (o.body.success ? 'ok' : (o.body as any).code)).sort();
    assertEqual(codes, ['in_progress', 'ok'], 'two simultaneous calls: one refunds, the other is told it is in progress');
    assertEqual([moyasar.calls.get, moyasar.calls.refund, moyasar.calls.void], [1, 1, 0], 'Moyasar fetched once and refunded once');
    assertEqual([sms.sent.length, db.bells.length], [1, 1], 'one SMS, one bell');
    const third = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([third.httpStatus, (third.body as any).code], [409, 'wrong_status'], 'a later click on the Refunded booking -> wrong_status');
    assertEqual([moyasar.calls.refund, sms.sent.length], [1, 1], 'still one refund, one SMS');
  }
  {
    // Five at once.
    const { moyasar, sms, deps } = setup({}, { created_at: TEN_MIN_AGO });
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => refundBooking(deps, 'B1', `Staff ${i}`)));
    assertEqual(outs.filter((o) => o.body.success).length, 1, 'five simultaneous calls: exactly one succeeds');
    assertEqual([moyasar.calls.void + moyasar.calls.refund, sms.sent.length], [1, 1], 'one Moyasar operation, one SMS');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — Moyasar failure rolls back');
  {
    const { db, moyasar, sms, deps } = setup({}, {}, {
      refund: { status: 400, body: { type: 'invalid_request_error', message: 'Validation Failed', errors: { amount: ['exceeds the refundable amount'] } } }
    });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([out.httpStatus, (out.body as any).code], [502, 'moyasar_error'], 'refused refund -> moyasar_error');
    assertEqual((out.body as any).error.startsWith('Validation Failed: amount exceeds the refundable amount'), true, "Moyasar's own message is returned");
    assertEqual(db.bookings.get('B1').payment_status, 'Needs Refund', 'booking back to Needs Refund');
    assertEqual(db.bookings.get('B1').refund_started_at, null, 'claim cleared');
    assertEqual(String(db.bookings.get('B1').timeline?.[0]).includes('Validation Failed'), true, 'failure noted on the timeline');
    assertEqual([sms.sent.length, db.bells.length], [0, 0], 'no SMS, no bell');
    assertEqual(db.events.map((e) => e.event_type), ['refund-check', 'refund'], 'the error response is recorded as evidence');
    assertEqual(moyasar.calls.refund, 1, 'one attempt');
  }
  {
    const { db, sms, deps } = setup({}, {}, { refund: { status: 503, body: { type: 'api_error', message: 'Service Unavailable' } } });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, db.bookings.get('B1').payment_status, sms.sent.length], ['moyasar_error', 'Needs Refund', 0], 'Moyasar 5xx -> rolled back');
  }
  {
    const { db, moyasar, deps } = setup({}, {}, { get: { status: 500, body: {} } });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, moyasar.calls.refund, moyasar.calls.void, db.bookings.get('B1').payment_status],
      ['moyasar_error', 0, 0, 'Needs Refund'], 'payment fetch fails -> nothing sent, rolled back');
  }
  {
    const { db, moyasar, deps } = setup({}, { status: 'failed' });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, moyasar.calls.refund, db.bookings.get('B1').payment_status], ['not_refundable', 0, 'Needs Refund'], 'failed payment -> nothing to refund, rolled back');
  }
  {
    // Retry after a lost answer: Moyasar already refunded it; we must not refund again.
    const { db, moyasar, sms, deps } = setup({}, {}, { refund: { status: 504, body: null } });
    await refundBooking(deps, 'B1', 'Staff A');
    moyasar.payment.status = 'refunded';     // it actually went through
    const retry = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual(retry.body, { success: true, method: 'moyasar_refunded', amountHalalas: 15050, recorded: true, smsSent: true }, 'retry finds it refunded and records it');
    assertEqual(moyasar.calls.refund, 1, 'no second refund request');
    assertEqual([sms.sent.length, db.bells.length], [1, 1], 'one SMS, one bell');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — void vs refund');
  {
    const { db, moyasar, deps } = setup({}, { created_at: TEN_MIN_AGO });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([out.body.success && (out.body as any).method, moyasar.calls.void, moyasar.calls.refund], ['void', 1, 0], 'paid 10 minutes ago -> voided, not refunded');
    assertEqual(db.bookings.get('B1').refund_method, 'void', 'refund_method void');
  }
  {
    const { moyasar, deps } = setup({}, { status: 'authorized' });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).method, moyasar.calls.void, moyasar.calls.refund], ['void', 1, 0], 'authorized -> voided');
  }
  {
    const { moyasar, deps } = setup({}, { created_at: TEN_MIN_AGO }, { void: { status: 400, body: { type: 'invalid_request_error', message: 'Payment can not be voided' } } });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).method, moyasar.calls.void, moyasar.calls.refund, moyasar.calls.refundBodies[0]],
      ['refund', 1, 1, { amount: 15050 }], 'void refused on a paid payment -> refunds the full amount instead');
  }
  {
    const { db, moyasar, deps } = setup({}, { status: 'authorized' }, { void: { status: 400, body: { message: 'Payment can not be voided' } } });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, moyasar.calls.refund, db.bookings.get('B1').payment_status], ['moyasar_error', 0, 'Needs Refund'], 'void refused on an authorized payment -> no refund (not allowed), rolled back');
  }
  {
    const { db, moyasar, sms, deps } = setup({}, { status: 'voided' });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).method, moyasar.calls.void, moyasar.calls.refund, sms.sent.length], ['moyasar_voided', 0, 0, 1], 'already voided in Moyasar -> just recorded, SMS once');
    assertEqual(db.bookings.get('B1').payment_status, 'Refunded', 'booking Refunded');
  }

  // ---------------------------------------------------------------------------
  console.log('refundBooking() — a stuck Refund Processing');
  {
    const { moyasar, deps } = setup({ payment_status: 'Refund Processing', refund_started_at: TEN_MIN_AGO }, { status: 'refunded' });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).method, moyasar.calls.refund], ['moyasar_refunded', 0], 'claim older than 5 min is taken over; Moyasar already refunded -> recorded without a second refund');
  }
  {
    const { moyasar, deps } = setup({ payment_status: 'Refund Processing', refund_started_at: new Date(NOW.getTime() - 60_000).toISOString() });
    const out = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(out.body as any).code, moyasar.calls.get], ['in_progress', 0], 'a fresh claim is not taken over');
  }

  // ---------------------------------------------------------------------------
  console.log('applyMoyasarRefundEvent() — webhook');
  {
    const db = makeDb([
      booking(),
      booking({ id: 'B2', moyasar_payment_id: PAY2, payment_status: 'Paid', status: 'Pending', customer_name: 'Sara' })
    ]);
    const sms = makeSms();
    const first = await applyMoyasarRefundEvent(db.admin, sms.sendSms, PAY, 'refunded', quiet);
    assertEqual(first, { ok: true, action: 'completed', bookingId: 'B1' }, 'Needs Refund -> Refunded');
    assertEqual([db.bookings.get('B1').payment_status, db.bookings.get('B1').refund_method], ['Refunded', 'moyasar_refunded'], 'booking updated');
    assertEqual([sms.sent.length, db.bells.length], [1, 1], 'SMS and bell once');
    const again = await applyMoyasarRefundEvent(db.admin, sms.sendSms, PAY, 'refunded', quiet);
    assertEqual(again.ok && again.action, 'already_refunded', 'retried webhook -> nothing');
    assertEqual([sms.sent.length, db.bells.length], [1, 1], 'no duplicate SMS or bell');

    const active = await applyMoyasarRefundEvent(db.admin, sms.sendSms, PAY2, 'voided', quiet);
    assertEqual(active.ok && active.action, 'alerted', 'refunded payment of an active Paid booking -> staff alerted');
    assertEqual(db.bookings.get('B2').payment_status, 'Paid', 'active booking left as it is');
    assertEqual([db.staffAlerts.length, db.staffAlerts[0]?.type, sms.sent.length], [1, 'staff', 1], 'one staff alert, no customer SMS');

    const none = await applyMoyasarRefundEvent(db.admin, sms.sendSms, '99999999-2222-4333-8444-555555555555', 'refunded', quiet);
    assertEqual(none.ok && none.action, 'no_booking', 'unknown payment -> nothing');
  }
  {
    const db = makeDb([booking({ payment_status: 'Refund Processing', refund_started_at: NOW.toISOString() })]);
    const sms = makeSms();
    const out = await applyMoyasarRefundEvent(db.admin, sms.sendSms, PAY, 'voided', quiet);
    assertEqual([out.ok && out.action, db.bookings.get('B1').payment_status, sms.sent.length], ['in_progress', 'Refund Processing', 0], 'webhook during a staff refund -> left for refund-payment (no double SMS)');
  }
  {
    // Webhook first, then staff click: the click finds it Refunded.
    const { db, moyasar, sms, deps } = setup({}, { status: 'refunded' });
    await applyMoyasarRefundEvent(db.admin, sms.sendSms, PAY, 'refunded', quiet);
    const click = await refundBooking(deps, 'B1', 'Staff A');
    assertEqual([(click.body as any).code, moyasar.calls.refund, sms.sent.length], ['wrong_status', 0, 1], 'staff click after the webhook -> refused, one SMS total');
  }

  // ---------------------------------------------------------------------------
  console.log('helpers');
  assertEqual(planRefund('authorized', DAY_AGO, NOW), 'void', 'authorized -> void');
  assertEqual(planRefund('paid', TEN_MIN_AGO, NOW), 'void', 'paid 10 min ago -> void');
  assertEqual(planRefund('captured', TEN_MIN_AGO, NOW), 'void', 'captured 10 min ago -> void');
  assertEqual(planRefund('paid', new Date(NOW.getTime() - VOID_WINDOW_MS).toISOString(), NOW), 'refund', 'paid at the window edge -> refund');
  assertEqual(planRefund('paid', DAY_AGO, NOW), 'refund', 'paid a day ago -> refund');
  assertEqual(planRefund('paid', undefined, NOW), 'refund', 'paid, no created_at -> refund (never guess a void)');
  assertEqual(planRefund('paid', '2026-11-10T00:00:00Z', NOW), 'refund', 'created_at in the future -> refund');
  assertEqual(planRefund('refunded', DAY_AGO, NOW), 'already_refunded', 'refunded');
  assertEqual(planRefund('voided', DAY_AGO, NOW), 'already_voided', 'voided');
  for (const s of ['initiated', 'failed', 'expired', 'verified']) assertEqual(planRefund(s, DAY_AGO, NOW), 'not_refundable', `${s} -> not refundable`);
  assertEqual(refundIdFrom({ refund_id: 'rf_1' }), 'rf_1', 'refund_id read');
  assertEqual(refundIdFrom({ refunds: [{ id: 'a' }, { id: 'b' }] }), 'b', 'last refund in a list');
  assertEqual(refundIdFrom({ id: PAY, status: 'refunded' }), null, 'no refund id in a plain payment');
  assertEqual(moyasarErrorMessage({ message: 'Validation Failed', errors: { amount: ['must be an integer'] } }, 'x'), 'Validation Failed: amount must be an integer', 'error message with details');
  assertEqual(moyasarErrorMessage({ message: 'Invalid authorization credentials', errors: null }, 'x'), 'Invalid authorization credentials', 'error message without details');
  assertEqual(moyasarErrorMessage(null, 'fallback'), 'fallback', 'no body -> fallback');
  const ev = refundEvidence('refund', 'B1', PAY, { type: 'invalid_request_error', message: 'nope', source: { token: 't' } });
  assertEqual([ev.source, ev.event_type, ev.booking_id, ev.moyasar_payment_id, ev.status, JSON.stringify(ev.raw).includes('"token"')],
    ['refund-payment', 'refund', 'B1', PAY, null, false], 'evidence row for an error body: linked, token-free');
  assertEqual(refundEvidence('void', 'B1', PAY, null).raw, { unparsed: null }, 'empty body still recorded');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
