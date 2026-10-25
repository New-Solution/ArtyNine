import type { Lang } from '../context/LanguageContext';
import type { NotificationItem } from '../types';
import { MONTH_NAMES } from './calendarConfig';
import { enumLabel } from './enumLabels';
import { KILN_TEXTS, pieceStatusText, type PieceText } from './pieceSmsTemplates';

/**
 * Arabic display text for a customer notification.
 *
 * DISPLAY ONLY. Notifications are stored in English by four independent writers (AppContext.tsx's
 * notifyBookingCancellation and notifyPieceStatusChange, the cancel_own_booking SQL function, and the
 * auto-cancel-bookings Edge function). Nothing here changes what is stored, sent as SMS, or compared.
 *
 * ROUND-TRIP GUARD: the English title and message are rebuilt from the extracted parts using the same
 * templates the writers use, and Arabic is returned only if BOTH rebuilds equal the stored text exactly.
 * Any difference (reworded template, unexpected date format, missing field, old row) returns the stored
 * English for both title and message, never a partial translation.
 */
type Input = Pick<NotificationItem, 'title' | 'message' | 'newStatus' | 'pieceName'>;
type Result = { title: string; message: string };

const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];

/** "September 16, 2026" or "31 August 2026" becomes "16 سبتمبر 2026"; null for any other shape. */
export function dateAr(text: string): string | null {
  let m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text);
  let month: string, day: string, year: string;
  if (m) { [, month, day, year] = m; }
  else {
    m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
    if (!m) return null;
    [, day, month, year] = m;
  }
  const i = MONTH_NAMES.indexOf(month);
  return i < 0 ? null : `${Number(day)} ${MONTH_NAMES_AR[i]} ${year}`;
}

// ---------------------------------------------------------------- pieces
// Current texts come from pieceSmsTemplates.ts — the same module AppContext.tsx
// notifyPieceStatusChange stores (English) and sends (English + Arabic) from.
// Titles mirror notifyPieceStatusChange exactly, including the display label for
// 'First Burn and Colored' ("Kiln Time").
const enPieceTitle = (s: string, code?: string) =>
  s === 'Ready for Pickup' ? 'Piece Ready for Pickup!'
  : s === 'Broken' ? `Piece ${code} marked as broken`
  : `Piece Status Update: ${enumLabel('pieceStatus', s, 'en')}`;

/** Every current template a stored message for status `s` could have been built from. */
function currentPieceTexts(s: string, code: string): PieceText[] {
  if (s === 'First Burn and Colored') return Object.values(KILN_TEXTS);
  const text = pieceStatusText(s, code);
  return text ? [text] : [];
}

// Rows written before the bilingual templates (pieceSmsTemplates.ts) keep their
// Arabic rendering through the legacy wording below.
const legacyEnPieceTitle = (s: string, code?: string) =>
  s === 'Ready for Pickup' ? 'Piece Ready for Pickup!'
  : s === 'Broken' ? `Piece ${code} marked as broken`
  : `Piece Status Update: ${s}`;
const legacyEnPieceMsg = (s: string, n: string, code?: string, date?: string) =>
  s === 'Ready for Pickup' ? `Your beautiful pottery piece "${n}" is ready for pickup! Please come pick it up at the café shelf.`
  : s === 'Collected' ? `Thank you for picking up your piece "${n}"! We hope you loved crafting it at Arty Café.`
  : s === 'First Burn and Colored' ? `Your piece "${n}" has been through its first burn and is now being coloured.`
  : s === 'Created' ? (date
      ? `Your piece "${n}" has been created and is now resting before its first burn. We expect it to be ready around ${date}.`
      : `Your piece "${n}" has been created and is now resting before its first burn.`)
  : s === 'Broken' ? `Unfortunately, your pottery piece ${code} was damaged and has been marked as broken. Please contact Arty Café so our team can assist you with a replacement.`
  : `Your piece "${n}" has been updated to "${s}".`;

const arPieceTitle = (s: string, code?: string) =>
  s === 'Ready for Pickup' ? 'قطعتك جاهزة للاستلام!'
  : s === 'Broken' ? `تم تسجيل القطعة ${code} كمكسورة`
  : `تحديث حالة القطعة: ${enumLabel('pieceStatus', s, 'ar')}`;
const legacyArPieceMsg = (s: string, n: string, code?: string, date?: string) =>
  s === 'Ready for Pickup' ? `قطعتك الخزفية الجميلة "${n}" جاهزة للاستلام! تفضّل باستلامها من رف المقهى.`
  : s === 'Collected' ? `شكرًا لاستلامك قطعتك "${n}"! نتمنى أن تكون قد استمتعت بصناعتها في Arty Café.`
  : s === 'First Burn and Colored' ? `اجتازت قطعتك "${n}" الحرق الأول وهي الآن قيد التلوين.`
  : s === 'Created' ? (date
      ? `تم إنشاء قطعتك "${n}" وهي الآن في مرحلة الراحة قبل الحرق الأول. نتوقع أن تكون جاهزة في حدود ${date}.`
      : `تم إنشاء قطعتك "${n}" وهي الآن في مرحلة الراحة قبل الحرق الأول.`)
  : s === 'Broken' ? `للأسف، تضررت قطعتك الخزفية ${code} وتم تسجيلها كمكسورة. يرجى التواصل مع Arty Café ليتمكن فريقنا من مساعدتك في الاستبدال.`
  : `تم تحديث حالة قطعتك "${n}" إلى "${enumLabel('pieceStatus', s, 'ar')}".`;

function localizePiece(n: Input): Result | null {
  const s = n.newStatus, name = n.pieceName;
  if (!s || !name) return null;
  const code = s === 'Broken' ? /^Piece (.+) marked as broken$/.exec(n.title)?.[1] : undefined;
  if (s === 'Broken' && !code) return null;

  // Current bilingual templates: the stored English must equal one of them exactly.
  if (enPieceTitle(s, code) === n.title) {
    const match = currentPieceTexts(s, code ?? '').find(text => text.en.normalize('NFC') === n.message);
    if (match) return { title: arPieceTitle(s, code), message: match.ar };
  }

  // Older rows, stored before the bilingual templates.
  const dateEn = s === 'Created' ? /We expect it to be ready around (.+)\.$/.exec(n.message)?.[1] : undefined;
  const dateA = dateEn ? dateAr(dateEn) : undefined;
  if (dateEn && !dateA) return null;
  if (legacyEnPieceTitle(s, code) !== n.title || legacyEnPieceMsg(s, name, code, dateEn) !== n.message) return null;
  return { title: arPieceTitle(s, code), message: legacyArPieceMsg(s, name, code, dateA ?? undefined) };
}

// ----------------------------------------------------------- cancellations
type Kind = 'refund' | 'noRefund' | 'noShow';
const KIND_BY_TITLE: Record<string, Kind> = {
  'Booking Cancelled — Refunded': 'refund',            // AppContext + cancel_own_booking
  'Booking Cancelled': 'noRefund',                     // AppContext + cancel_own_booking
  'Booking Cancelled — Missed Session': 'noShow'       // auto-cancel-bookings
};
const TITLE_AR: Record<Kind, string> = {
  refund: 'تم إلغاء الحجز — تم الاسترداد',
  noRefund: 'تم إلغاء الحجز',
  noShow: 'تم إلغاء الحجز — جلسة فائتة'
};
const CANCEL_RE: Record<Kind, RegExp> = {
  refund: /^Your booking for "(.+)" on (.+) has been cancelled, and (\d+(?:\.\d+)?) SAR has been refunded\. We hope to see you again soon!$/,
  noRefund: /^Your booking for "(.+)" on (.+) has been cancelled\. Per our cancellation policy, this booking was not eligible for a refund\. Please contact Arty Café with any questions\.$/,
  noShow: /^Arty Café: your booking for "(.+?)"(?: on (.+?))? has been cancelled\. We called for you and you had not arrived, so the place has been released\. Per our cancellation policy this booking is not refundable\. Please contact the studio if you think this is a mistake\.$/
};
const enCancelMsg = (k: Kind, t: string, d?: string, amount?: string) =>
  k === 'refund' ? `Your booking for "${t}" on ${d} has been cancelled, and ${amount} SAR has been refunded. We hope to see you again soon!`
  : k === 'noRefund' ? `Your booking for "${t}" on ${d} has been cancelled. Per our cancellation policy, this booking was not eligible for a refund. Please contact Arty Café with any questions.`
  : `Arty Café: your booking for "${t}"${d ? ` on ${d}` : ''} has been cancelled. We called for you and you had not arrived, so the place has been released. Per our cancellation policy this booking is not refundable. Please contact the studio if you think this is a mistake.`;
const arCancelMsg = (k: Kind, t: string, d?: string, amount?: string) =>
  k === 'refund' ? `تم إلغاء حجزك في "${t}" بتاريخ ${d}، وتم استرداد ${amount} ريال. نتطلع لرؤيتك قريبًا!`
  : k === 'noRefund' ? `تم إلغاء حجزك في "${t}" بتاريخ ${d}. وفقًا لسياسة الإلغاء لدينا، لم يكن هذا الحجز مؤهلًا لاسترداد المبلغ. يرجى التواصل مع Arty Café لأي استفسار.`
  : `Arty Café: تم إلغاء حجزك في "${t}"${d ? ` بتاريخ ${d}` : ''}. نادينا عليك ولم تكن قد وصلت، فتم إخلاء المكان. وفقًا لسياسة الإلغاء لدينا، هذا الحجز غير قابل للاسترداد. يرجى التواصل مع الاستوديو إذا كنت تعتقد أن هناك خطأ.`;

function localizeCancellation(n: Input): Result | null {
  const kind = KIND_BY_TITLE[n.title];
  if (!kind) return null;
  const m = CANCEL_RE[kind].exec(n.message);
  if (!m) return null;
  const [, title, dateEn, amount] = m;
  const dateA = dateEn ? dateAr(dateEn) : undefined;
  if (dateEn && !dateA) return null;
  if (enCancelMsg(kind, title, dateEn, amount) !== n.message) return null;
  return { title: TITLE_AR[kind], message: arCancelMsg(kind, title, dateA ?? undefined, amount) };
}

export function localizeNotification(n: Input, lang: Lang): Result {
  const original = { title: n.title, message: n.message };
  if (lang !== 'ar') return original;
  const input = { ...n, title: n.title.normalize('NFC'), message: n.message.normalize('NFC') };  // é can arrive decomposed
  return localizePiece(input) ?? localizeCancellation(input) ?? original;
}
