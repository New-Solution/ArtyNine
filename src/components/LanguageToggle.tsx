/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useLanguage } from '../context/LanguageContext';

/**
 * The EN / ع switch from the redesign.
 *
 * A segmented pill: the active side is a raised white chip, the other side is
 * quiet. Arabic is labelled in Arabic, which is the convention — someone who
 * needs it should not have to read English to find it.
 */
export const LanguageToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { lang, setLang } = useLanguage();

  const chip = (active: boolean) =>
    `relative cursor-pointer rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] ${
      active
        ? 'bg-white text-brand-charcoal shadow-[0_1px_2px_rgba(46,33,26,0.08)]'
        : 'text-brand-muted hover:text-brand-charcoal'
    }`;

  return (
    <div className={`flex rounded-full bg-brand-sand p-[3px] ${className}`} role="group" aria-label="Language">
      <button
        type="button"
        onClick={() => setLang('en')}
        aria-pressed={lang === 'en'}
        className={chip(lang === 'en')}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLang('ar')}
        aria-pressed={lang === 'ar'}
        lang="ar"
        aria-label="العربية"
        className={`${chip(lang === 'ar')} font-arabic text-[12px]`}
      >
        ع
      </button>
    </div>
  );
};
