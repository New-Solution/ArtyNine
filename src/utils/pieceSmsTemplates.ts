/**
 * The one source of truth for customer-facing piece texts: the SMS body, the stored
 * (English) bell notification, and the Arabic bell rendering in notificationText.ts.
 *
 * Keyed on the stage's system key (pipeline_stages.system_key, 0045), so renaming a
 * stage never changes which text is sent. pieceStatusText() still answers by the
 * stored name, for notificationText.ts matching rows already written. Every text
 * here is a registered SMS template — pinned in pieceSmsTemplates.test.ts.
 */

import type { StageSystemKey } from '../types';

export interface PieceText { en: string; ar: string }

/** Which message the customer gets on entering 'First Burn and Colored'. */
export type KilnSmsVariant = 'color' | 'kiln';
export const DEFAULT_KILN_VARIANT: KilnSmsVariant = 'kiln';

const GREETING_EN = 'Dear Arty artist,\n';
const GREETING_AR = 'عزيزنا فنان Arty،\n';

const CREATED: PieceText = {
  en: GREETING_EN + 'Thank you for visiting us! 🤍 We hope you had a wonderful time and enjoyed your pottery experience!\nYour pottery piece is now resting on our shelf to dry. It should be ready for pickup in approximately two weeks. 🏺✨',
  ar: GREETING_AR + 'شكرًا لزيارتكم لنا! 🤍 نتمنى إنكم استمتعتوا بوقتكم وكانت تجربة الفخار جميلة وممتعة!\nقطعتكم الفخار الآن على الرف عشان تنشف، ومتوقع تكون جاهزة للاستلام خلال أسبوعين تقريبًا. 🏺✨'
};

export const KILN_TEXTS: Record<KilnSmsVariant, PieceText> = {
  color: {
    en: GREETING_EN + 'Exciting update! 🔥 Your pottery piece has finished its first firing and is ready for you to color! Come by the café whenever suits you to paint it. 🎨🤍',
    ar: GREETING_AR + 'عندنا لكم تحديث حلو! 🔥 قطعتكم الفخار خلصت أول مرحلة حرق وصارت جاهزة للتلوين! تقدروا تزورونا بأي وقت يناسبكم عشان تلونوها. 🎨🤍'
  },
  kiln: {
    en: GREETING_EN + 'Exciting update! 🔥 Your pottery piece is now in the kiln, getting one step closer to being ready! 🤍',
    ar: GREETING_AR + 'عندنا لكم تحديث حلو! 🔥 قطعتكم الفخار الآن داخل الفرن، وقربت خطوة أكثر إنها تكون جاهزة! 🤍'
  }
};

const READY: PieceText = {
  en: GREETING_EN + "Great news! 🎉 Your pottery piece has finished firing and is now ready for pickup! We can't wait for you to see your creation! 🤍🏺",
  ar: GREETING_AR + 'عندنا لكم خبر حلو! 🎉 قطعتكم الفخار خلصت مرحلة الحرق وصارت جاهزة للاستلام! متحمسين تشوفوا إبداعكم 🤍🏺'
};

const COLLECTED: PieceText = {
  en: GREETING_EN + "Thank you for picking up your pottery piece! 🤍 We hope you loved making it, and we can't wait to see you again soon! 🏺",
  ar: GREETING_AR + 'شكرًا لاستلامكم قطعتكم الفخار! 🤍 نتمنى إنكم استمتعتوا بصنعها، ومتحمسين نشوفكم مرة ثانية قريب! 🏺'
};

const broken = (code: string): PieceText => ({
  en: GREETING_EN + `We're so sorry 🤍 Unfortunately, your pottery piece ${code} was damaged during the process. Please contact us so we can arrange a replacement for you.`,
  ar: GREETING_AR + `نعتذر منكم كثير 🤍 للأسف قطعتكم الفخار ${code} تضررت أثناء المراحل. نرجو تتواصلوا معنا عشان نرتب لكم بديل.`
});

export const PICKUP_REMINDER_TEXT: PieceText = {
  en: GREETING_EN + 'Just a friendly reminder 🤍 Your pottery piece is ready and waiting for you on our shelf! Drop by the café whenever suits you to pick it up. 🏺',
  ar: GREETING_AR + 'تذكير بسيط 🤍 قطعتكم الفخار جاهزة وتنتظركم على الرف! تقدروا تمرّون علينا بأي وقت يناسبكم لاستلامها. 🏺'
};

/**
 * Customer text for a piece entering the system stage `key`, or null for a
 * custom stage (no key), which has no registered template. `code` is the piece
 * code (falling back to the piece id) — only the Broken message uses it.
 */
export function pieceTextForKey(
  key: StageSystemKey | null | undefined,
  code: string,
  variant: KilnSmsVariant = DEFAULT_KILN_VARIANT
): PieceText | null {
  switch (key) {
    case 'created': return CREATED;
    case 'kiln': return KILN_TEXTS[variant] ?? KILN_TEXTS[DEFAULT_KILN_VARIANT];
    case 'ready': return READY;
    case 'collected': return COLLECTED;
    case 'broken': return broken(code);
    default: return null;
  }
}

/** The names the five system stages had when their notifications were stored. */
const STORED_NAME_KEYS: Record<string, StageSystemKey> = {
  'Created': 'created',
  'First Burn and Colored': 'kiln',
  'Ready for Pickup': 'ready',
  'Collected': 'collected',
  'Broken': 'broken'
};

/**
 * Customer text by a stored status NAME, or null for any other name. For
 * matching notification rows already written; new notifications use
 * pieceTextForKey().
 */
export function pieceStatusText(status: string, code: string, variant: KilnSmsVariant = DEFAULT_KILN_VARIANT): PieceText | null {
  return pieceTextForKey(STORED_NAME_KEYS[status], code, variant);
}

/** Every piece SMS is sent in both languages, English first, regardless of the customer's language. */
export const bilingualSms = (text: PieceText): string => `${text.en}\n\n${text.ar}`;
