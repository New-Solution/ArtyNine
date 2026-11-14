/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "About Arty" on the home page: a short, playful introduction that leads to
 * the full About page. Three studio photos pinned at angles with washi tape, a
 * hand-drawn underline and squiggle, and soft clay and sage shapes behind.
 * Everything decorative is aria-hidden; the photos keep real alt text.
 *
 * Logical properties only (start/end, ms-/me-), so the layout mirrors in
 * Arabic without branching.
 */

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { ScrollReveal } from './ScrollReveal';

const img = (path: string) => `${import.meta.env.BASE_URL}images/${path}`;

/** A strip of washi tape across a photo's top edge. */
const Tape: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    aria-hidden="true"
    className={`absolute -top-3 left-1/2 z-10 h-6 w-20 -translate-x-1/2 rounded-[2px] bg-brand-clay/80 shadow-sm ${className}`}
  />
);

/** A hand-drawn underline that draws itself in once on scroll. */
export const Scribble: React.FC<{ className?: string }> = ({ className = '' }) => {
  const reduce = useReducedMotion();
  return (
    <svg aria-hidden="true" viewBox="0 0 220 18" fill="none" preserveAspectRatio="none" className={className}>
      <motion.path
        d="M3 12c26-7 52-9 78-6s47 7 72 3 40-8 64-5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        initial={reduce ? false : { pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.9, ease: 'easeOut', delay: 0.3 }}
      />
    </svg>
  );
};

interface Props {
  onLearnMore: () => void;
}

export const AboutArtyTeaser: React.FC<Props> = ({ onLearnMore }) => {
  const { t } = useLanguage();

  const photos = [
    {
      src: img('hero/studio-03.jpg'),
      alt: t('Throwing a bowl on the potter’s wheel', 'تشكيل وعاء على عجلة الفخار'),
      // Large card, leaning back.
      frame: 'start-0 top-6 w-[58%] -rotate-6',
      delay: 0
    },
    {
      src: img('hero/studio-07.jpg'),
      alt: t('A hand reaching for brushes in a handmade cup', 'يد تمتد إلى فرش الرسم في كوب مصنوع يدويًا'),
      frame: 'end-0 top-0 w-[46%] rotate-[5deg]',
      delay: 0.12
    },
    {
      src: img('hero/studio-06.jpg'),
      alt: t('Shelves of glazed cups and bowls made by students', 'رفوف من الأكواب والأوعية المزجّجة من صنع المتدربين'),
      frame: 'bottom-0 start-[30%] w-[44%] rotate-[-2deg]',
      delay: 0.24
    }
  ];

  return (
    <section className="relative overflow-hidden bg-brand-cream py-16 md:py-24">
      {/* Soft shapes behind everything. */}
      <div aria-hidden="true" className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-brand-sage-soft" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 -start-16 h-64 w-64 rounded-[42%_58%_63%_37%/45%_40%_60%_55%] bg-brand-clay-soft" />

      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-4 sm:px-6 lg:grid-cols-12 lg:gap-10 lg:px-8">

        {/* The pinned photos. A fixed-ratio stage, so the overlaps hold at
            every width instead of drifting apart on a phone. */}
        <div className="relative mx-auto aspect-[10/9] w-full max-w-[520px] lg:col-span-6 lg:max-w-none">
          {photos.map(photo => (
            <ScrollReveal
              key={photo.src}
              once
              viewOptions={{ once: true, amount: 0.3 }}
              transition={{ delay: photo.delay, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              variants={{ hidden: { opacity: 0, y: 28, scale: 0.96 }, visible: { opacity: 1, y: 0, scale: 1 } }}
              className={`absolute ${photo.frame}`}
            >
              <figure className="relative rounded-[6px] bg-white p-2 pb-6 shadow-card transition-transform duration-500 motion-safe:hover:scale-[1.03] sm:p-2.5 sm:pb-8">
                <Tape />
                <img
                  src={photo.src}
                  alt={photo.alt}
                  className="aspect-[4/5] w-full rounded-[3px] object-cover"
                  loading="lazy"
                  decoding="async"
                />
              </figure>
            </ScrollReveal>
          ))}

          {/* A round "sticker" with the year the studio opened. */}
          <div
            aria-hidden="true"
            className="absolute -bottom-2 end-2 z-20 flex h-20 w-20 rotate-12 flex-col items-center justify-center rounded-full bg-brand-terracotta text-center text-brand-cream shadow-button sm:h-24 sm:w-24"
          >
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em] sm:text-[10px]">{t('Since', 'منذ')}</span>
            <span className="font-display text-xl font-semibold leading-none ltr-numerals sm:text-2xl">2021</span>
          </div>

          {/* Hand-drawn squiggle and spark. */}
          <svg aria-hidden="true" viewBox="0 0 120 60" fill="none" className="absolute -top-6 start-[44%] h-12 w-24 text-brand-sage">
            <path d="M4 40c12-24 24-24 28 0s18 22 26-4 20-24 28 2 16 20 30-6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <svg aria-hidden="true" viewBox="0 0 100 100" fill="none" className="absolute bottom-10 -start-2 h-10 w-10 text-brand-terracotta/70">
            <path d="M50 10c4 22 14 32 36 36-22 4-32 14-36 36-4-22-14-32-36-36 22-4 32-14 36-36Z" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" />
          </svg>
        </div>

        {/* Words */}
        <div className="text-start lg:col-span-6 lg:ps-6">
          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1 } }}
          >
            <span className="inline-block -rotate-2 rounded-full bg-brand-sage-soft px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage-hover rtl:tracking-normal">
              {t('About Arty', 'عن آرتي')}
            </span>
          </ScrollReveal>

          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.4 }}
            transition={{ delay: 0.1, duration: 0.5, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0 } }}
          >
            <h2 className="mt-5 font-display text-[34px] font-semibold leading-[1.1] text-brand-charcoal md:text-[46px]">
              {t('Your creative ', 'وجهتك ')}
              <span className="relative inline-block">
                {t('destination', 'الإبداعية')}
                <Scribble className="absolute -bottom-2 start-0 h-3 w-full text-brand-sage" />
              </span>
              {t(' for art & inspiration', ' للفن والإلهام')}
            </h2>
          </ScrollReveal>

          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.4 }}
            transition={{ delay: 0.2, duration: 0.5, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0 } }}
          >
            <p className="mt-6 max-w-lg text-base leading-[1.75] text-brand-ink sm:text-[17px]">
              {t(
                'Arty: your creative destination for art, expression and inspiration. An interactive art space offering hands-on workshops in pottery, painting and other crafts, in a warm and welcoming environment that blends learning, fun and self-expression.',
                'آرتي: وجهتك الإبداعية للفن والتعبير والإلهام. مساحة فنية تفاعلية تقدّم ورشًا عملية في الفخار والرسم وحِرف يدوية أخرى، في أجواء دافئة ومرحِّبة تجمع بين التعلّم والمتعة والتعبير عن الذات.'
              )}
            </p>
          </ScrollReveal>

          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.4 }}
            transition={{ delay: 0.3, duration: 0.5, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0 } }}
            className="mt-8"
          >
            <button
              type="button"
              onClick={onLearnMore}
              className="pill-btn pill-btn-primary px-7 py-4 text-base shadow-button"
            >
              <span>{t('Learn more', 'اعرف أكثر')}</span>
              <span className="pill-btn-arrow" aria-hidden="true"><ArrowRight className="h-4 w-4 flip-rtl" /></span>
            </button>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
};
