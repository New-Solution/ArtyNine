/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Every day: 05:00 PM – 12:00 AM" / "يوميًا: 5:00 مساءً – 12:00 منتصف الليل".
 *
 * Do not put this inside an `ltr-numerals` element: that class forces the
 * whole run left-to-right in Arabic, which is what scrambled the line before.
 * Here only the times are isolated (<bdi dir="ltr">); the words around them
 * follow the page direction.
 */

import React from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { STUDIO_HOURS } from '../../utils/studioConfig';

/**
 * `compact` is the short form for tight spots such as the map badge:
 * "Daily 5:00 PM – 12:00 AM" / "يوميًا 5:00 مساءً – 12:00 منتصف الليل".
 * Same hours, no colon, and no leading zero on the hour.
 */
export const StudioHours: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { lang } = useLanguage();
  const time = (value: string) => (compact ? value.replace(/^0/, '') : value);
  if (lang === 'ar') {
    const h = STUDIO_HOURS.ar;
    return (
      <>
        {compact ? 'يوميًا ' : 'يوميًا: '}<bdi dir="ltr">{time(h.opens)}</bdi> {h.opensPeriod} – <bdi dir="ltr">{time(h.closes)}</bdi> {h.closesPeriod}
      </>
    );
  }
  const h = STUDIO_HOURS.en;
  return <>{compact ? 'Daily ' : 'Every day: '}<bdi dir="ltr">{time(h.opens)}</bdi> – <bdi dir="ltr">{time(h.closes)}</bdi></>;
};
