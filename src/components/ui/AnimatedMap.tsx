/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { MapPin } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

/**
 * A stylised map of the studio's block — drawn, not embedded.
 *
 * A ruled grid for the streets, a few soft blocks for the buildings, and a pin
 * that drops and keeps a slow pulse. The whole thing is one link: clicking
 * anywhere opens the real Google Maps listing in a new tab.
 *
 * Everything is CSS and SVG, so it costs nothing to load and cannot leak a
 * visitor's details to a third-party frame the way the embed did. The
 * animations sit in index.css so `prefers-reduced-motion` can switch them off
 * in one place.
 */

interface AnimatedMapProps {
  href: string;
  label: string;
  coordinates: string;
  className?: string;
}

export const AnimatedMap: React.FC<AnimatedMapProps> = ({
  href,
  label,
  coordinates,
  className = ''
}) => {
  const { t } = useLanguage();
  return (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={`${t('Open', 'افتح')} ${label} ${t('in Google Maps', 'في خرائط جوجل')}`}
    className={`group relative block overflow-hidden rounded-[22px] border border-brand-clay bg-brand-sand ${className}`}
  >
    {/* Streets */}
    <div
      className="absolute inset-0 bg-[linear-gradient(to_right,#D9CDB8_1px,transparent_1px),linear-gradient(to_bottom,#D9CDB8_1px,transparent_1px)] bg-[size:64px_64px] opacity-70"
      aria-hidden="true"
    />
    {/* Two thicker roads crossing near the pin */}
    <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-brand-clay/80" aria-hidden="true" />
    <div className="absolute inset-y-0 left-[46%] w-[3px] bg-brand-clay/80" aria-hidden="true" />

    {/* Blocks */}
    <div className="absolute inset-0" aria-hidden="true">
      <div className="absolute left-[12%] top-[22%] h-16 w-24 rounded-lg bg-brand-clay/50" />
      <div className="absolute left-[62%] top-[14%] h-24 w-16 rounded-lg bg-brand-clay/40" />
      <div className="absolute left-[70%] top-[62%] h-20 w-28 rounded-lg bg-brand-clay/50" />
      <div className="absolute left-[16%] top-[64%] h-14 w-20 rounded-lg bg-brand-sage/20" />
      <div className="absolute left-[36%] top-[70%] h-12 w-12 rounded-lg bg-brand-clay/35" />
    </div>

    {/* The studio */}
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full" aria-hidden="true">
      <span className="map-pin-drop relative flex flex-col items-center">
        <MapPin className="h-9 w-9 fill-brand-terracotta text-brand-terracotta drop-shadow-sm" />
        <span className="map-pin-pulse absolute -bottom-1 h-3 w-3 rounded-full bg-brand-terracotta/40" />
      </span>
    </div>

    {/* Open badge */}
    <div className="absolute end-4 top-4 inline-flex items-center gap-2 rounded-full bg-brand-cream/95 px-3 py-1.5 text-[11px] font-semibold text-brand-charcoal shadow-card-sm backdrop-blur-sm">
      <span className="map-live-dot h-2 w-2 rounded-full bg-brand-sage" />
      <span>{t('Open today', 'مفتوح اليوم')}</span>
    </div>

    {/* Place */}
    <div className="absolute bottom-0 inset-x-0 p-5">
      <p className="font-display text-lg font-semibold text-brand-charcoal">{label}</p>
      <p className="mt-0.5 font-mono text-xs text-brand-muted"><span className="ltr-numerals">{coordinates}</span></p>
      <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-terracotta">
        {t('Open in Google Maps', 'افتح في خرائط جوجل')}
        <span className="transition-transform duration-200 group-hover:translate-x-1 flip-rtl">→</span>
      </span>
    </div>
  </a>
  );
};

export default AnimatedMap;
