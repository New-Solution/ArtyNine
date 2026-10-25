/**
 * The one source of truth for customer-facing piece texts: the SMS body, the stored
 * (English) bell notification, and the Arabic bell rendering in notificationText.ts.
 *
 * Keyed on the STORED status value ('First Burn and Colored' stays the stored name;
 * staff see it as "Kiln Time" — see enumLabels.ts). Nothing here changes what is
 * stored or compared.
 */

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
 * Customer text for a piece entering `status`, or null for a status with no
 * template. `code` is the piece code (falling back to the piece id) — only the
 * Broken message uses it.
 */
export function pieceStatusText(status: string, code: string, variant: KilnSmsVariant = DEFAULT_KILN_VARIANT): PieceText | null {
  switch (status) {
    case 'Created': return CREATED;
    case 'First Burn and Colored': return KILN_TEXTS[variant] ?? KILN_TEXTS[DEFAULT_KILN_VARIANT];
    case 'Ready for Pickup': return READY;
    case 'Collected': return COLLECTED;
    case 'Broken': return broken(code);
    default: return null;
  }
}

/** Every piece SMS is sent in both languages, English first, regardless of the customer's language. */
export const bilingualSms = (text: PieceText): string => `${text.en}\n\n${text.ar}`;
