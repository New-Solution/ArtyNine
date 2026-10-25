/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one source of truth for booking cancellation SMS texts: customer
 * self-cancel (notify-own-booking), no-show auto-cancel (auto-cancel-bookings)
 * and staff cancel (notifyBookingCancellation() in src/context/AppContext.tsx,
 * which imports this file directly — the frontend can import from here, the
 * Edge Functions cannot import from src/).
 *
 * Zero Deno/Supabase imports, so it runs under Deno, Vite and plain Node alike.
 *
 * SMS ONLY. In-app bell notifications keep their own stored wording
 * (notificationText.ts matches those), so nothing here is stored or compared.
 *
 * Every message is bilingual, regardless of the customer's language: English,
 * a blank line, then Arabic. {workshopTitle} is the English title in both lines,
 * {date} is DD/MM/YYYY in both, and {amount} is the number alone — the currency
 * is part of the template.
 */

export type BookingCancellationKind = 'refunded' | 'notRefunded' | 'noShow';

export interface BookingSmsInput {
  workshopTitle?: string | null;
  /** Stored booking date, YYYY-MM-DD. */
  date?: string | null;
  /** Refunded amount; only the refunded message uses it. */
  amount?: number | string | null;
}

/** Used for {workshopTitle} when a booking has no title. */
export const FALLBACK_WORKSHOP_TITLE = 'Arty Workshop';

/** YYYY-MM-DD becomes DD/MM/YYYY; anything unreadable is sent as stored. */
export function smsBookingDate(date?: string | null): string {
  const trimmed = String(date ?? '').trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
}

/** The number alone: 150 -> "150", 150.5 -> "150.5". */
export function smsAmount(amount?: number | string | null): string {
  const n = Number(amount);
  return Number.isFinite(n) ? String(n) : String(amount ?? '').trim();
}

/** English and Arabic for one cancellation message. */
export function bookingCancellationText(kind: BookingCancellationKind, input: BookingSmsInput): { en: string; ar: string } {
  const workshopTitle = String(input.workshopTitle ?? '').trim() || FALLBACK_WORKSHOP_TITLE;
  const date = smsBookingDate(input.date);
  const amount = smsAmount(input.amount);

  switch (kind) {
    case 'refunded':
      return {
        en: `Your booking "${workshopTitle}" on ${date} was cancelled and ${amount} SAR refunded.`,
        ar: `تم إلغاء حجزك "${workshopTitle}" بتاريخ ${date} واسترداد ${amount} ريال.`
      };
    case 'notRefunded':
      return {
        en: `Your booking "${workshopTitle}" on ${date} was cancelled and is not eligible for a refund per our cancellation policy.`,
        ar: `تم إلغاء حجزك "${workshopTitle}" بتاريخ ${date}، وهو غير مؤهل للاسترداد حسب سياسة الإلغاء.`
      };
    case 'noShow':
      return {
        en: `Your booking "${workshopTitle}" on ${date} was cancelled as you were not present when called. It is non-refundable.`,
        ar: `تم إلغاء حجزك "${workshopTitle}" بتاريخ ${date} لعدم الحضور عند النداء، وهو غير قابل للاسترداد.`
      };
  }
}

/** The SMS body: English, a blank line, then Arabic. */
export function bookingCancellationSms(kind: BookingCancellationKind, input: BookingSmsInput): string {
  const text = bookingCancellationText(kind, input);
  return `${text.en}\n\n${text.ar}`;
}
