/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * notify-own-booking — sends a customer the outcome of cancelling their own
 * booking, closing the gap docs/parked-work.md records ("No SMS or in-app
 * notification on customer self-cancellation").
 *
 * WHY THIS EXISTS SEPARATELY FROM send-sms
 * send-sms accepts an arbitrary phone number and is deliberately gated to
 * is_staff() for exactly that reason — opening it to any authenticated
 * caller would make it an open SMS relay. A customer cancelling their own
 * booking is a genuinely different authorization question: not "is this
 * caller staff", but "does this caller own the specific booking they are
 * asking about". This function answers only that: it never accepts a phone
 * number or message from the caller, only a booking id, and reads who to
 * message and what happened from the booking row itself.
 *
 * AUTHORIZATION
 * The caller must be signed in, and public.current_customer_id() — called
 * through the caller's own JWT, exactly as send-sms calls is_staff() —
 * must match the booking's customer_id. "Not found" and "not yours" answer
 * identically, the same reasoning cancel_own_booking (migration 0017)
 * documents, so this cannot be used to probe which booking ids exist.
 *
 * WHY A SERVICE-ROLE READ AFTER THE OWNERSHIP CHECK
 * The ownership check itself runs on the caller's own session, so it can
 * never be tricked into approving someone else's booking. The booking is
 * then read again with the service-role key — the same pattern
 * auto-cancel-bookings uses — so the message is composed from a read that
 * cannot be blocked or altered by RLS on a path that has already proven
 * who is asking.
 *
 * WHAT IT REFUSES
 * - No session, or current_customer_id() is null (not a linked customer).
 * - The booking does not exist, or does not belong to this caller.
 * - The booking's status is not 'Cancelled' — this function announces a
 *   cancellation, not any other change.
 *
 * The in-app notification is not this function's job: it is written inside
 * cancel_own_booking itself (migration 0031), which already has the booking
 * row and the caller's identity in hand under SECURITY DEFINER.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { sendSms } from '../_shared/sms.ts';
import { bookingCancellationSms } from '../_shared/bookingSmsTemplates.ts';
import { ownsBooking, wasRefunded, type BookingRow } from './logic.ts';
import type { NotifyOwnBookingRequest, NotifyOwnBookingResponse } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: NotifyOwnBookingResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST only.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('notify-own-booking: missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.');
    return json({ success: false, error: 'Server is not configured.' }, 500);
  }

  let body: NotifyOwnBookingRequest;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400);
  }

  const bookingId = body?.bookingId;
  if (!bookingId || typeof bookingId !== 'string') {
    return json({ success: false, error: 'bookingId is required.' }, 400);
  }

  // 1. Who is calling? Verified against Supabase's own Auth server, never a
  // locally-decoded JWT — same pattern as send-sms.
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerAuth, error: callerAuthError } = await callerClient.auth.getUser();
  if (callerAuthError || !callerAuth?.user) {
    return json({ success: false, error: 'Sign in required.' }, 401);
  }

  // 2. Which customer is this caller, if any? SECURITY DEFINER, evaluated
  // strictly against auth.uid() — same reasoning send-sms applies to
  // is_staff(): calling it through the caller's own JWT answers "who is
  // *this* caller", not "who is anyone".
  const { data: callerCustomerId, error: customerIdError } = await callerClient.rpc('current_customer_id');
  if (customerIdError) {
    console.error('notify-own-booking: current_customer_id() check failed:', customerIdError.message);
    return json({ success: false, error: 'Could not verify the caller.' }, 500);
  }
  if (!callerCustomerId) {
    return json({ success: false, error: 'That booking could not be found on your account.' }, 403);
  }

  // 3. Read the booking with the service-role key: the ownership check above
  // already proved who is asking, so this read cannot be blocked or altered
  // by RLS on a path already trusted.
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: booking, error: bookingError } = await admin
    .from('bookings')
    .select('id, customer_id, customer_phone, workshop_title, date, total_price, payment_status, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingError) {
    console.error(`notify-own-booking: reading booking ${bookingId} failed:`, bookingError.message);
    return json({ success: false, error: 'Could not read that booking.' }, 500);
  }

  // "Not found" and "not yours" answer identically, as cancel_own_booking
  // does — this must never reveal which booking ids exist.
  if (!booking || !ownsBooking(booking as BookingRow, callerCustomerId as string)) {
    return json({ success: false, error: 'That booking could not be found on your account.' }, 403);
  }

  if (booking.status !== 'Cancelled') {
    return json({ success: false, error: 'That booking has not been cancelled.' }, 409);
  }

  if (!booking.customer_phone) {
    console.error(`notify-own-booking: SMS for booking ${bookingId} not sent — no phone number on file.`);
    return json({ success: true }, 200);
  }

  // Always English then Arabic, whatever the customer's language preference.
  const message = bookingCancellationSms(wasRefunded(booking as BookingRow) ? 'refunded' : 'notRefunded', {
    workshopTitle: booking.workshop_title,
    date: booking.date,
    amount: booking.total_price
  });
  const result = await sendSms(booking.customer_phone, message);

  return json(
    result.success ? { success: true } : { success: false, error: result.error },
    result.success ? 200 : 502
  );
});
