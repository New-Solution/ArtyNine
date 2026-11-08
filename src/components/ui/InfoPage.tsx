/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared layout for the public info pages (policy, terms, contact): the same
 * eyebrow + display heading the checkout uses, then a single cream card of
 * text sections. Logical properties only (ms-/ps-/text-start), so the layout
 * mirrors in Arabic without branching.
 */

import React from 'react';
import { useApp } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import { CONFIRM_WITH_CLIENT, infoPageHref, type InfoPage } from '../../utils/infoPages';

interface InfoPageLayoutProps {
  eyebrow: string;
  title: string;
  intro?: React.ReactNode;
  /** "Last updated" date line, already localized. */
  updated?: string;
  children: React.ReactNode;
}

export const InfoPageLayout: React.FC<InfoPageLayoutProps> = ({ eyebrow, title, intro, updated, children }) => (
  <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 md:py-16">
    <header className="mb-8">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">{eyebrow}</span>
      <h1 className="mt-3 font-display text-3xl font-semibold text-brand-charcoal sm:text-[42px]">{title}</h1>
      {intro && <div className="mt-3 text-sm leading-[1.7] text-brand-ink">{intro}</div>}
      {updated && <p className="mt-2 text-xs text-brand-muted">{updated}</p>}
    </header>
    <div className="space-y-8 rounded-[28px] border border-brand-clay bg-brand-cream p-6 shadow-card sm:p-8">
      {children}
    </div>
  </div>
);

export const InfoSection: React.FC<{ title: string; children: React.ReactNode; id?: string }> = ({ title, children, id }) => (
  <section id={id} className="space-y-3 text-start">
    <h2 className="font-display text-xl font-semibold text-brand-charcoal">{title}</h2>
    <div className="space-y-3 text-sm leading-[1.75] text-brand-ink">{children}</div>
  </section>
);

/** A bulleted list with the brand's spacing; items may contain inline markup. */
export const InfoList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="list-disc space-y-2 ps-5 marker:text-brand-terracotta">
    {items.map((item, i) => <li key={i}>{item}</li>)}
  </ul>
);

/**
 * Text the studio still has to confirm. Rendered visibly, in both languages,
 * with the literal CONFIRM_WITH_CLIENT marker so it cannot slip into launch
 * unnoticed and every one can be found with a single search.
 */
export const ConfirmWithClient: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <span className="rounded bg-amber-100 px-1 py-0.5 font-semibold text-amber-900">
    {children}
    {children ? ' ' : ''}
    <span dir="ltr">{CONFIRM_WITH_CLIENT}</span>
  </span>
);

/** An in-site link to another customer page. */
export const InfoPageLink: React.FC<{ page: InfoPage; children: React.ReactNode }> = ({ page, children }) => {
  const { setCustomerTab } = useApp();
  return (
    <button
      type="button"
      onClick={() => setCustomerTab(page)}
      className="cursor-pointer font-semibold text-brand-terracotta underline underline-offset-4 hover:text-brand-terracotta-hover"
    >
      {children}
    </button>
  );
};

/** "Last updated" line. The date is the day the wording was written. */
export const useUpdatedLine = (): string => {
  const { t } = useLanguage();
  return t('Last updated: 8 November 2026', 'آخر تحديث: ٨ نوفمبر ٢٠٢٦');
};

/**
 * A link to an info page that opens in a NEW tab (`?page=…`). Used where
 * navigating in place would lose work: on the checkout payment step it would
 * unmount the payment form and drop the hold being paid for.
 */
export const InfoPageNewTabLink: React.FC<{ page: InfoPage; children: React.ReactNode; className?: string }> = ({
  page, children, className = 'font-semibold text-brand-terracotta underline underline-offset-4 hover:text-brand-terracotta-hover'
}) => (
  <a href={infoPageHref(page, import.meta.env.BASE_URL)} target="_blank" rel="noopener" className={className}>
    {children}
  </a>
);
