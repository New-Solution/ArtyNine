/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The studio's front-desk phone number, shown wherever the customer site
 * tells someone to call the studio directly.
 *
 * Was previously repeated as a literal string in several components — kept
 * here so a number change only has to happen once.
 */
export const STUDIO_PHONE = '+966 54 822 2055';

/*
 * The studio's public contact details. The home page's "Slow down & visit us"
 * block, the footer's social buttons and the Contact page all read these, so a
 * change is made once.
 */

/** WhatsApp: bare international digits for wa.me, and the formatted form. */
export const STUDIO_WHATSAPP_DIGITS = '966548182404';
export const STUDIO_WHATSAPP_DISPLAY = '+966 54 818 2404';
export const STUDIO_WHATSAPP_URL = `https://wa.me/${STUDIO_WHATSAPP_DIGITS}`;

export const STUDIO_EMAIL = 'arty.cafe85@gmail.com';

export const STUDIO_ADDRESS = '3331 Ahmad Al Attas, Al Zahra District, Jeddah 23521, Saudi Arabia';
export const STUDIO_ADDRESS_AR = '3331 شارع أحمد العطاس، حي الزهراء، جدة 23521، المملكة العربية السعودية';
/** The short form shown on the booking confirmation and in the calendar file. */
export const STUDIO_ADDRESS_SHORT = 'Ahmad Al Attas St, Jeddah';
export const STUDIO_ADDRESS_SHORT_AR = 'شارع أحمد العطاس، جدة';
export const STUDIO_MAPS_URL = 'https://maps.app.goo.gl/Br4QagaCrPKeJ8EW8';

/**
 * Opening hours, every day. Rendered by <StudioHours />, which writes the
 * Arabic as Arabic (مساءً / منتصف الليل, not PM / AM) and isolates only the
 * digits, so the line never reorders in RTL.
 */
export const STUDIO_HOURS = {
  en: { opens: '05:00 PM', closes: '12:00 AM' },
  ar: { opens: '5:00', opensPeriod: 'مساءً', closes: '12:00', closesPeriod: 'منتصف الليل' }
} as const;

export const STUDIO_INSTAGRAM_HANDLE = '@arty.cafe';
export const STUDIO_INSTAGRAM_URL = 'https://www.instagram.com/arty.cafe';
export const STUDIO_TIKTOK_URL = 'https://www.tiktok.com/@artycafe';
export const STUDIO_FACEBOOK_URL = 'https://www.facebook.com/people/Arty-Cafe/100041894486483/';

/** STUDIO_PHONE as a tel: link. */
export const STUDIO_PHONE_TEL = `tel:${STUDIO_PHONE.replace(/\s+/g, '')}`;
