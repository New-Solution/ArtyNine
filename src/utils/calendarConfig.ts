/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One calendar configuration for the whole application.
 *
 * Every calendar, date picker and formatted date must go through here so the app
 * is Gregorian and English everywhere, regardless of the device or browser
 * locale. On an Arabic (ar-SA) browser the native `<input type="date">` picker
 * opens in the Islamic (Hijri) calendar while `input.value` stays ISO Gregorian —
 * which is why a picker could open Hijri and then display a Gregorian date.
 *
 * Riyadh timezone maths is unchanged; this file only fixes locale and calendar.
 */

/** Locale used for every date the app renders. English month and weekday names. */
export const APP_LOCALE = 'en-US';

/**
 * Locale applied to native date inputs via the `lang` attribute. Chromium picks
 * the date picker's calendar and field order from the element's `lang`, so this
 * pins the picker to the English Gregorian calendar.
 */
export const DATE_INPUT_LOCALE = 'en-GB';

/** Explicit calendar — never inherited from the browser locale. */
export const APP_CALENDAR = 'gregory';

/** Timezone for all business dates. Unchanged. */
export const RIYADH_TIME_ZONE = 'Asia/Riyadh';

/** English weekday names, in JS `getDay()` order. */
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

export const WEEKDAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** English Gregorian month names, in `getMonth()` order. */
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Arabic Gregorian month names, in `getMonth()` order — the names
 * `toLocaleDateString('ar-SA-u-ca-gregory')` prints. Display only: dates are
 * still stored and compared as ISO strings.
 */
export const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];

/** Single-letter Arabic weekday headers, in `getDay()` order (Sunday first). */
export const WEEKDAY_LETTERS_AR = ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'];

/** The month's display name in the visitor's language (index from `getMonth()`). */
export function monthName(monthIndex: number, lang: string): string {
  return (lang === 'ar' ? MONTH_NAMES_AR : MONTH_NAMES)[monthIndex] ?? '';
}

export const MONTH_NAMES_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Base options every formatter starts from: explicit English locale and an
 * explicit Gregorian calendar, so a browser locale carrying `-u-ca-islamic`
 * cannot switch the output to Hijri.
 */
export function gregorianOptions(
  options: Intl.DateTimeFormatOptions = {}
): Intl.DateTimeFormatOptions {
  return { calendar: APP_CALENDAR, ...options };
}

/** Creates a formatter pinned to English + Gregorian. Pass a timeZone if needed. */
export function createDateFormatter(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(APP_LOCALE, gregorianOptions(options));
}

/** Formats a date in English Gregorian. Never uses the browser default locale. */
export function formatDate(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' }
): string {
  const value = date instanceof Date ? date : new Date(date);
  if (isNaN(value.getTime())) return '';
  return createDateFormatter(options).format(value);
}

/** Formats a time in English (12-hour), Gregorian calendar. */
export function formatTime(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
): string {
  const value = date instanceof Date ? date : new Date(date);
  if (isNaN(value.getTime())) return '';
  return createDateFormatter(options).format(value);
}

/** Formats a date and time together in English Gregorian. */
export function formatDateTime(
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }
): string {
  return formatDate(date, options);
}

/**
 * Props every native date/time input must spread, so the picker opens in the
 * English Gregorian calendar rather than the device locale's calendar.
 */
export const CALENDAR_INPUT_PROPS = {
  lang: DATE_INPUT_LOCALE,
  dir: 'ltr' as const,
  'data-calendar': APP_CALENDAR
};
