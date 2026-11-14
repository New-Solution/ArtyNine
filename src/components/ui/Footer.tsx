/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * The site footer's layout: wordmark on one side, circular social buttons on
 * the other, then a rule with the links ranged right and the copyright left.
 *
 * Adapted from the shadcn Footer block. Two departures worth naming:
 *
 *  - The shadcn/originui `Button` is not used. Its base class sets
 *    `rounded-lg`, which fights the circular icon buttons this footer wants,
 *    and its `bg-secondary`/`text-muted-foreground` tokens do not exist in this
 *    project's Tailwind theme. Plain anchors and buttons carry brand classes
 *    instead, so nothing can override their shape.
 *  - Links are actions, not hrefs. This app has no router — navigation goes
 *    through `setCustomerTab` — so a link is `{ label, onClick }`. Social
 *    entries keep real `href`s, because those genuinely leave the site.
 */

export interface FooterSocial {
  icon: React.ReactNode;
  href: string;
  label: string;
}

export interface FooterAction {
  label: string;
  onClick?: () => void;
  /** A real link instead of an action — for leaving the app. Opens in the
   *  same tab. */
  href?: string;
  /** Renders in the brand colour — used for the staff console entry. */
  emphasis?: boolean;
}

interface FooterProps {
  logo: React.ReactNode;
  brandName: string;
  /** Small uppercase line under the brand name. */
  tagline?: string;
  blurb?: string;
  socialLinks: FooterSocial[];
  mainLinks: FooterAction[];
  legalLinks?: FooterAction[];
  copyright: { text: string; license?: string };
}

export const Footer: React.FC<FooterProps> = ({
  logo,
  brandName,
  tagline,
  blurb,
  socialLinks,
  mainLinks,
  legalLinks = [],
  copyright
}) => {
  return (
    <footer className="border-t border-brand-clay bg-brand-cream pt-10 pb-[calc(3rem+env(safe-area-inset-bottom))] lg:pb-8">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-12">

        <div className="md:flex md:items-start md:justify-between md:gap-10">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {logo}
              {/* The brand name is carried by the logo image, so it is not
                  repeated as text — but it stays in the accessibility tree,
                  because the footer logo is decorative (alt=""). */}
              <span className="sr-only">{brandName}</span>
              {tagline && (
                <span className="text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-brand-sage">
                  {tagline}
                </span>
              )}
            </div>
            {blurb && (
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-brand-ink">{blurb}</p>
            )}
          </div>

          {/* Circular icon buttons. rounded-full is on the element itself. */}
          <ul className="mt-6 flex list-none gap-2.5 md:mt-0">
            {socialLinks.map(link => (
              <li key={link.label}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={link.label}
                  title={link.label}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-brand-clay bg-brand-sand text-brand-charcoal transition-colors hover:bg-brand-terracotta hover:border-brand-terracotta hover:text-brand-cream"
                >
                  {link.icon}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 border-t border-brand-clay pt-6 lg:grid lg:grid-cols-10 lg:gap-6">
          <nav className="lg:col-[4/11]">
            <ul className="-mx-2 flex list-none flex-wrap sm:-my-1 lg:justify-end">
              {mainLinks.map(link => (
                <li key={link.label} className="mx-2 shrink-0 sm:my-1">
                  {link.href ? (
                    <a
                      href={link.href}
                      className={`inline-flex min-h-11 cursor-pointer items-center text-sm underline-offset-4 hover:underline sm:min-h-0 ${
                        link.emphasis ? 'font-semibold text-brand-terracotta' : 'text-brand-charcoal'
                      }`}
                    >
                      {link.label}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={link.onClick}
                      className={`inline-flex min-h-11 cursor-pointer items-center text-sm underline-offset-4 hover:underline sm:min-h-0 ${
                        link.emphasis
                          ? 'font-semibold text-brand-terracotta'
                          : 'text-brand-charcoal'
                      }`}
                    >
                      {link.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          {legalLinks.length > 0 && (
            <div className="mt-4 lg:col-[4/11] lg:mt-2">
              <ul className="-mx-3 flex list-none flex-wrap sm:-my-1 lg:justify-end">
                {legalLinks.map(link => (
                  <li key={link.label} className="mx-3 shrink-0 sm:my-1">
                    <button
                      type="button"
                      onClick={link.onClick}
                      className="inline-flex min-h-11 cursor-pointer items-center text-sm text-brand-muted underline-offset-4 hover:underline sm:min-h-0"
                    >
                      {link.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 text-sm leading-6 text-brand-muted lg:col-[1/4] lg:row-[1/3] lg:mt-0">
            <div>{copyright.text}</div>
            {copyright.license && <div>{copyright.license}</div>}
          </div>
        </div>

      </div>
    </footer>
  );
};
