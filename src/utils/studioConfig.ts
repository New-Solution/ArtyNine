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
export const STUDIO_MAPS_URL = 'https://maps.app.goo.gl/Br4QagaCrPKeJ8EW8';

/** Shown after "Every day" / "يوميًا". */
export const STUDIO_HOURS = '05:00 PM – 12:00 AM';

export const STUDIO_INSTAGRAM_HANDLE = '@arty.cafe';
export const STUDIO_INSTAGRAM_URL = 'https://www.instagram.com/arty.cafe';
export const STUDIO_TIKTOK_URL = 'https://www.tiktok.com/@artycafe';
export const STUDIO_FACEBOOK_URL = 'https://www.facebook.com/people/Arty-Cafe/100041894486483/';

/** STUDIO_PHONE as a tel: link. */
export const STUDIO_PHONE_TEL = `tel:${STUDIO_PHONE.replace(/\s+/g, '')}`;
