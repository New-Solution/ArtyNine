/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * auto-cancel-bookings — the scheduled replacement for the client-side
 * no-show timer that used to live in AppContext.tsx.
 *
 * An unpaid-payment rule was moved here alongside it and has since been
 * removed: every online booking in this system is paid at booking time, so it
 * could never match, and it would have cancelled a future pay-at-counter
 * booking fifteen minutes after it was taken.
 *
 * WHY AN EDGE FUNCTION AND NOT pg_cron
 * The job has to send an SMS, and the mShastra credentials live exclusively
 * in this Deno runtime's environment (see _shared/mshastra.ts, which states
 * it is "the only place MSHASTRA_USERNAME / MSHASTRA_PASSWORD are ever
 * read"). Driving this from Postgres would mean either copying those
 * secrets into the database — breaking that invariant and doubling the
 * places a credential can leak from — or having pg_cron call out over
 * pg_net to this function anyway. Neither pg_cron nor pg_net is enabled on
 * this project today (only pgcrypto is declared, in 0001_init), so the SQL
 * route also costs two extensions for no gain. The scheduler calls this
 * function directly instead.
 *
 * AUTHORIZATION
 * Unlike send-sms, this has no human caller to authorize: it runs on a
 * timer, on behalf of the studio. It uses the service-role key — the same
 * pattern as provision-staff — so it writes with its own authority and
 * cannot be defeated by RLS the way the client timers were when the only
 * open browser was a customer's. Because that key bypasses RLS, the
 * function accepts no booking id, no filter and no target from its caller:
 * it decides entirely from the database and the clock, so an unauthorized
 * invocation can at most make it do the work it was already going to do.
 *
 * IDEMPOTENCY
 * Every cancellation is a compare-and-swap: the UPDATE carries
 * `.eq('status', 'Pending')` and returns the affected row. If the booking
 * has already moved — a concurrent run, a staff cancel, a customer
 * self-cancel — zero rows come back and the notification is not sent. Two
 * overlapping runs therefore cannot double-cancel or double-SMS.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.2';
import { sendSms } from '../_shared/sms.ts';
import { bookingCancellationSms } from '../_shared/bookingSmsTemplates.ts';
import {
  isNoShow,
  NO_SHOW_TIMELINE_ACTION,
  NO_SHOW_NOTE,
  NO_SHOW_NOTIFICATION_TITLE,
  noShowMessage,
  type BookingRow,
  type QueueRow
} from './logic.ts';
import type { AutoCancelRequest, AutoCancelResponse, AutoCancelledBooking } from './contract.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: AutoCancelResponse, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });

/**
 * Only bookings that could plausibly qualify are read: Pending, and dated
 * within a few days either side of now. A no-show is judged against its
 * session time, so a narrow window around today covers every candidate
 * without scanning the whole table every minute.
 */
const WINDOW_DAYS = 3;

const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST only.' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('auto-cancel-bookings: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
    return json({ success: false, error: 'Server is not configured.' }, 500);
  }

  let body: AutoCancelRequest = {};
  try {
    body = (await req.json()) as AutoCancelRequest;
  } catch {
    // The scheduler sends no body; that is not an error.
  }
  const dryRun = body?.dryRun === true;

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const nowMs = Date.now();
  const cancelled: AutoCancelledBooking[] = [];

  try {
    const { data: bookings, error: bookingsError } = await admin
      .from('bookings')
      .select('id, status, date, time, customer_name, customer_phone, workshop_title')
      .eq('status', 'Pending')
      .gte('date', dayOffset(-WINDOW_DAYS))
      .lte('date', dayOffset(WINDOW_DAYS));

    if (bookingsError) {
      console.error('auto-cancel-bookings: reading bookings failed:', bookingsError.message);
      return json({ success: false, error: 'Could not read bookings.' }, 500);
    }

    const candidates = (bookings ?? []) as BookingRow[];
    if (candidates.length === 0) {
      return json({ success: true, scanned: 0, cancelled: [] }, 200);
    }

    // One queue read for the whole run rather than one per booking.
    const { data: queueRows, error: queueError } = await admin
      .from('queue')
      .select('id, booking_id, phone, date, status')
      .gte('date', dayOffset(-WINDOW_DAYS))
      .lte('date', dayOffset(WINDOW_DAYS));

    if (queueError) {
      console.error('auto-cancel-bookings: reading queue failed:', queueError.message);
      return json({ success: false, error: 'Could not read the queue.' }, 500);
    }

    const queue = (queueRows ?? []) as QueueRow[];

    for (const booking of candidates) {
      if (!isNoShow(booking, queue, nowMs)) continue;

      if (dryRun) {
        cancelled.push({ bookingId: booking.id, reason: 'no_show', smsSent: false, notificationWritten: false });
        continue;
      }

      // Read the row as it stands, so the timeline is appended to rather
      // than overwritten with a stale copy.
      const { data: fresh } = await admin
        .from('bookings')
        .select('timeline, notes, status')
        .eq('id', booking.id)
        .maybeSingle();

      if (!fresh || fresh.status !== 'Pending') continue;

      const timeline = Array.isArray(fresh.timeline) ? fresh.timeline : [];

      // Compare-and-swap: still Pending, or this run does nothing.
      const { data: updated, error: updateError } = await admin
        .from('bookings')
        .update({
          status: 'Cancelled',
          notes: fresh.notes ? `${fresh.notes}\n[${NO_SHOW_NOTE}]` : NO_SHOW_NOTE,
          timeline: [
            ...timeline,
            {
              time: new Date(nowMs).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'Asia/Riyadh'
              }),
              action: NO_SHOW_TIMELINE_ACTION
            }
          ],
          updated_at: new Date(nowMs).toISOString()
        })
        .eq('id', booking.id)
        .eq('status', 'Pending')
        .select('id');

      if (updateError) {
        console.error(`auto-cancel-bookings: cancelling ${booking.id} failed:`, updateError.message);
        continue;
      }

      // Someone else got there first — do not notify about their change.
      if (!updated || updated.length === 0) continue;

      // Seats go back through the same RPC every other cancellation uses.
      const { error: seatsError } = await admin.rpc('release_booking_seats', { p_booking_id: booking.id });
      if (seatsError) {
        console.error(`auto-cancel-bookings: releasing seats for ${booking.id} failed:`, seatsError.message);
      }

      // Cancel the linked queue row and free its tables. Completed and
      // In Progress are left alone: those describe a visit that happened.
      const linked = queue.find(
        q => q.booking_id && String(q.booking_id) === String(booking.id)
      );
      if (linked && linked.status !== 'Completed' && linked.status !== 'In Progress') {
        const { data: freshQueue } = await admin
          .from('queue')
          .select('history')
          .eq('id', linked.id)
          .maybeSingle();
        const history = Array.isArray(freshQueue?.history) ? freshQueue!.history : [];

        const { error: queueUpdateError } = await admin
          .from('queue')
          .update({
            status: 'Cancelled',
            table_ids: [],
            history: [...history, { status: 'Cancelled', timestamp: new Date(nowMs).toISOString() }],
            updated_at: new Date(nowMs).toISOString()
          })
          .eq('id', linked.id);

        if (queueUpdateError) {
          console.error(`auto-cancel-bookings: cancelling queue row ${linked.id} failed:`, queueUpdateError.message);
        }
      }

      const message = noShowMessage(booking);

      // In-app notification. Written with the service role, so unlike the
      // customer self-cancel path this is not refused by RLS.
      let notificationWritten = false;
      const { error: notifyError } = await admin.from('notifications').insert({
        id: `NOTIF-${nowMs}-${Math.floor(Math.random() * 1000)}`,
        type: 'customer',
        customer_phone: booking.customer_phone,
        title: NO_SHOW_NOTIFICATION_TITLE,
        message,
        timestamp: new Date(nowMs).toISOString(),
        is_read: false,
        highlighted: false
      });
      if (notifyError) {
        console.error(`auto-cancel-bookings: notification for ${booking.id} failed:`, notifyError.message);
      } else {
        notificationWritten = true;
      }

      // SMS. Sent from this runtime, which is where the credentials live —
      // no second hop through send-sms, whose is_staff() gate exists for
      // human callers and has no meaning for a scheduled job.
      let smsSent = false;
      if (!booking.customer_phone) {
        console.error(`auto-cancel-bookings: SMS for ${booking.id} not sent — no phone on file.`);
      } else {
        // The SMS has its own bilingual text (English, blank line, Arabic);
        // `message` above stays the in-app notification's wording.
        const smsText = bookingCancellationSms('noShow', {
          workshopTitle: booking.workshop_title,
          date: booking.date
        });
        const result = await sendSms(booking.customer_phone, smsText);
        smsSent = result.success;
        if (!result.success) {
          console.error(`auto-cancel-bookings: SMS for ${booking.id} failed:`, result.error);
        }
      }

      cancelled.push({ bookingId: booking.id, reason: 'no_show', smsSent, notificationWritten });
    }

    return json({ success: true, scanned: candidates.length, cancelled }, 200);
  } catch (err) {
    console.error('auto-cancel-bookings: run failed:', err instanceof Error ? err.message : err);
    return json({ success: false, error: 'Run failed.' }, 500);
  }
});
