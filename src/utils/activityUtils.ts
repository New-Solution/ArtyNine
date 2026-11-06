/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One normalized activity model over the shared booking and queue records.
 *
 * A "visit" is either a booking row, a queue row, or both linked together. The
 * Dashboard and the Customer page both read through here so they cannot drift,
 * and neither keeps its own summary copy.
 */

import { Booking, QueueItem, Workshop } from '../types';
import { normalizeDateString, timeToMinutes } from './timeUtils';
import { isLapsedHold } from './onlinePayments';

export type ActivityCategory = 'Workshops' | 'Events/Birthdays' | 'Self-Guided';

export type ActivitySource = 'Website' | 'Admin' | 'Walk-in';

export interface TodayActivity {
  /** Stable id: the booking id when a booking exists, otherwise the queue id. */
  id: string;
  bookingId?: string;
  queueId?: string;
  customerName: string;
  customerPhone: string;
  title: string;
  category: ActivityCategory;
  source: ActivitySource;
  date: string;
  time: string;
  sortMinutes: number;
  participants: number;
  paymentStatus?: string;
  /** Live status, preferring the queue entry when the visit has one. */
  status: string;
  hasQueueEntry: boolean;
}

/** Statuses that mean a booking is no longer a valid visit for today. */
const DEAD_BOOKING_STATUSES = ['cancelled', 'auto-cancelled', 'autocancelled', 'draft', 'no show', 'no-show'];
/** Payment states that mean the booking never completed. */
const DEAD_PAYMENT_STATUSES = ['failed', 'payment failed', 'declined', 'draft', 'expired'];
const DEAD_QUEUE_STATUSES = ['cancelled'];

/**
 * How close a queue check-in time must be to a booking's scheduled time to be
 * treated as the same visit, when falling back to a phone-only match (see
 * getActivitiesForDate). Wide enough for an early or late check-in against a
 * booked slot; narrow enough that an unrelated same-day visit for the same
 * customer does not qualify.
 */
const QUEUE_LINK_WINDOW_MINUTES = 60;

export function isLiveBooking(booking: Booking): boolean {
  const status = String(booking.status || '').trim().toLowerCase();
  if (DEAD_BOOKING_STATUSES.includes(status)) return false;

  const payment = String(booking.paymentStatus || '').trim().toLowerCase();
  if (DEAD_PAYMENT_STATUSES.includes(payment)) return false;

  // An online hold past its expiry holds nothing, as session_seats_taken (0046)
  // already treats it, even before the auto-cancel job marks it Expired.
  if (isLapsedHold(booking)) return false;

  return true;
}

export function isLiveQueueItem(item: QueueItem): boolean {
  return !DEAD_QUEUE_STATUSES.includes(String(item.status || '').trim().toLowerCase());
}

/** Classifies a booking as a workshop, an event/birthday, or self-guided studio time. */
export function categorizeBooking(booking: Booking, workshops: Workshop[] = []): ActivityCategory {
  const title = String(booking.workshopTitle || '').toLowerCase();
  const workshopId = String(booking.workshopId || '').toLowerCase();

  if (
    workshopId === 'birthday-party-event' ||
    workshopId.startsWith('bpkg-') ||
    workshopId.startsWith('evt-') ||
    title.includes('birthday') ||
    title.includes('party') ||
    title.includes('event')
  ) {
    return 'Events/Birthdays';
  }

  if (title.includes('no instructor') || title.includes('self-guided') || title.includes('walk-in —')) {
    return 'Self-Guided';
  }

  // A booking that resolves to a real workshop record is a workshop.
  if (booking.workshopId && workshops.some(w => String(w.id) === String(booking.workshopId))) {
    return 'Workshops';
  }

  return 'Workshops';
}

/** Classifies a queue entry from its saved mode, not from a displayed name. */
export function categorizeQueueItem(item: QueueItem): ActivityCategory {
  if (item.type === 'Without Instructor') return 'Self-Guided';

  const activity = String(item.activity || '').toLowerCase();
  if (activity.includes('birthday') || activity.includes('party') || activity.includes('event')) {
    return 'Events/Birthdays';
  }

  return 'Workshops';
}

function normalizePhoneKey(phone?: string): string {
  return String(phone || '').replace(/\D/g, '').slice(-9);
}

export interface ActivitySources {
  bookings: Booking[];
  queue: QueueItem[];
  workshops?: Workshop[];
}

/**
 * Every valid booking or visit scheduled for a given Riyadh date, from both the
 * booking table and the live queue, merged into one row per visit.
 *
 * A queue entry and a booking are the same visit when the queue entry carries the
 * booking's id, or — for rows saved before that link existed — when the phone
 * matches AND the workshop matches AND the check-in time falls within
 * QUEUE_LINK_WINDOW_MINUTES of the booking's scheduled time. Phone and date alone
 * used to be enough, which merged any same-day, same-customer activity into one
 * row regardless of what it actually was — a real website booking and an
 * unrelated walk-in check-in for the same person collapsed into a single row,
 * with the walk-in's status silently overwriting the booking's own. Workshop and
 * time together are real evidence of the same visit; phone alone is not. The
 * booking row wins, and takes its live status from the queue.
 */
export function getActivitiesForDate(
  sources: ActivitySources,
  dateStr: string
): TodayActivity[] {
  const { bookings, queue, workshops = [] } = sources;
  const targetDate = normalizeDateString(dateStr);

  const liveBookings = bookings.filter(
    b => normalizeDateString(b.date) === targetDate && isLiveBooking(b)
  );
  const liveQueue = queue.filter(
    q => normalizeDateString(q.date) === targetDate && isLiveQueueItem(q)
  );

  // Index the queue by the booking it belongs to, by id first and phone second.
  const queueByBookingId = new Map<string, QueueItem>();
  const queueByPhone = new Map<string, QueueItem>();
  liveQueue.forEach(q => {
    if (q.bookingId) queueByBookingId.set(String(q.bookingId), q);
    const key = normalizePhoneKey(q.phone);
    if (key && !queueByPhone.has(key)) queueByPhone.set(key, q);
  });

  const claimedQueueIds = new Set<string>();
  const activities: TodayActivity[] = [];

  for (const booking of liveBookings) {
    const phoneCandidate = queueByPhone.get(normalizePhoneKey(booking.customerPhone));
    // The phone-only match is real evidence of the same visit only once the
    // workshop also matches and the check-in happened near the booking's own
    // scheduled time — otherwise it's just two activities for the same person
    // on the same day, which is not the same thing.
    const phoneCandidateIsSameVisit =
      !!phoneCandidate &&
      !!phoneCandidate.workshopId &&
      String(phoneCandidate.workshopId) === String(booking.workshopId) &&
      Math.abs(timeToMinutes(phoneCandidate.checkInTime) - timeToMinutes(booking.time)) <= QUEUE_LINK_WINDOW_MINUTES;

    const linkedQueue =
      queueByBookingId.get(String(booking.id)) ||
      (phoneCandidateIsSameVisit ? phoneCandidate : undefined);

    if (linkedQueue) claimedQueueIds.add(linkedQueue.id);

    const time = booking.time || linkedQueue?.checkInTime || '';

    activities.push({
      id: booking.id,
      bookingId: booking.id,
      queueId: linkedQueue?.id,
      customerName: booking.customerName,
      customerPhone: booking.customerPhone,
      title: booking.workshopTitle,
      category: categorizeBooking(booking, workshops),
      source: booking.source === 'Website' ? 'Website' : booking.source === 'Admin' ? 'Admin' : 'Walk-in',
      date: targetDate,
      time,
      sortMinutes: timeToMinutes(time),
      participants: Number(booking.participants) || 0,
      paymentStatus: booking.paymentStatus,
      // The queue is the live signal once the guest is in the studio.
      status: linkedQueue ? linkedQueue.status : booking.status,
      hasQueueEntry: !!linkedQueue
    });
  }

  // Walk-ins that exist only in the queue (self-guided and with-instructor).
  for (const item of liveQueue) {
    if (claimedQueueIds.has(item.id)) continue;

    activities.push({
      id: item.id,
      queueId: item.id,
      bookingId: item.bookingId,
      customerName: item.name,
      customerPhone: item.phone,
      title: item.type === 'Without Instructor'
        ? `Self-Guided Studio Time${item.hours ? ` (${item.hours} hrs)` : ''}`
        : item.activity,
      category: categorizeQueueItem(item),
      source: item.source === 'Website' ? 'Website' : item.source === 'Admin' ? 'Admin' : 'Walk-in',
      date: targetDate,
      time: item.checkInTime,
      sortMinutes: timeToMinutes(item.checkInTime),
      participants: Number(item.participants) || 0,
      status: item.status,
      hasQueueEntry: true
    });
  }

  return activities.sort((a, b) => a.sortMinutes - b.sortMinutes);
}

/**
 * The activity categories a customer belongs to, derived from their real booking
 * and queue history. A customer can belong to more than one.
 */
export function getCustomerActivityCategories(
  customer: { phone?: string; email?: string; name?: string },
  sources: ActivitySources
): ActivityCategory[] {
  const { bookings, queue, workshops = [] } = sources;

  const phoneKey = normalizePhoneKey(customer.phone);
  const emailKey = String(customer.email || '').trim().toLowerCase();
  const nameKey = String(customer.name || '').trim().toLowerCase();

  const matches = (phone?: string, email?: string, name?: string) => {
    if (phoneKey && normalizePhoneKey(phone) === phoneKey) return true;
    if (emailKey && String(email || '').trim().toLowerCase() === emailKey) return true;
    if (!phoneKey && !emailKey && nameKey) {
      return String(name || '').trim().toLowerCase() === nameKey;
    }
    return false;
  };

  const found = new Set<ActivityCategory>();

  bookings.forEach(b => {
    if (!isLiveBooking(b)) return;
    if (!matches(b.customerPhone, b.customerEmail, b.customerName)) return;
    found.add(categorizeBooking(b, workshops));
  });

  queue.forEach(q => {
    if (!isLiveQueueItem(q)) return;
    if (!matches(q.phone, undefined, q.name)) return;
    found.add(categorizeQueueItem(q));
  });

  const order: ActivityCategory[] = ['Workshops', 'Events/Birthdays', 'Self-Guided'];
  return order.filter(c => found.has(c));
}

export const ACTIVITY_CATEGORIES: ActivityCategory[] = ['Workshops', 'Events/Birthdays', 'Self-Guided'];
