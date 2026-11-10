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

export const StudioHours: React.FC = () => {
  const { lang } = useLanguage();
  if (lang === 'ar') {
    const h = STUDIO_HOURS.ar;
    return (
      <>
        يوميًا: <bdi dir="ltr">{h.opens}</bdi> {h.opensPeriod} – <bdi dir="ltr">{h.closes}</bdi> {h.closesPeriod}
      </>
    );
  }
  const h = STUDIO_HOURS.en;
  return <>Every day: <bdi dir="ltr">{h.opens}</bdi> – <bdi dir="ltr">{h.closes}</bdi></>;
};
