/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { categoryLabel } from '../utils/categoryLabel';
import { enumLabel } from '../utils/enumLabels';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { PhotoGallery } from './ui/PhotoGallery';
import { VerticalCutReveal } from './ui/VerticalCutReveal';
import { CountingNumber } from './ui/CountingNumber';
import { ScrollReveal } from './ui/ScrollReveal';
import Reveal from './ui/Reveal';
import { AnimatedMap } from './ui/AnimatedMap';
import { BirthdayBalloons } from './ui/BirthdayBalloons';
import { CoverflowCarousel } from './ui/CoverflowCarousel';
import {
  ContainerStagger,
  ContainerAnimated
} from './ui/CtaSectionWithGallery';
import { formatDate } from '../utils/calendarConfig';
import { selectFeaturedWorkshops, recentBookingsWindow } from '../utils/featuredWorkshops';
import { STUDIO_PHONE, STUDIO_WHATSAPP_URL, STUDIO_WHATSAPP_DISPLAY, STUDIO_EMAIL, STUDIO_ADDRESS, STUDIO_ADDRESS_AR, STUDIO_MAPS_URL } from '../utils/studioConfig';
import { StudioHours } from './ui/StudioHours';
import { localizedText } from '../utils/localizedText';
import { durationLabel, ageRangeLabel } from '../utils/workshopMetaLabel';
import { useSessionSeats, useRecentBookings } from '../lib/sessionSeats';
import { Sparkles, ChevronRight, Paintbrush, MousePointerClick, CalendarRange, Gift, Phone, Mail, UserCheck, Star, ArrowLeft, Clock } from 'lucide-react';

/**
 * The arc gallery's photographs, in the order the studio supplied them.
 * They live in /public so they are served as plain files, not bundled.
 */
const HERO_IMAGES = [
  'hero/studio-01.jpg',
  'hero/studio-02.jpg',
  'hero/studio-03.jpg',
  'hero/studio-04.jpg',
  'hero/studio-05.jpg',
  'hero/studio-06.jpg',
  'hero/studio-07.jpg',
  'hero/studio-08.jpg',
  'hero/studio-09.jpg',
  'hero/studio-10.jpg',
  'hero/studio-11.jpg',
  'hero/studio-12.jpg'
].map(path => `${import.meta.env.BASE_URL}images/${path}`);

const HERO_ALTS = [
  'Underglaze bottles beside a wall of fired colour test tiles',
  'Hands trimming a terracotta pot on the wheel',
  'Throwing a bowl on the potter’s wheel',
  'Paint-covered studio tables under handmade ceramic lamps',
  'A studio wall hung with students’ paintings',
  'Shelves of glazed cups and bowls made by students',
  'A hand reaching for brushes in a handmade cup',
  'An artist holding a loaded paint palette',
  'Shaping a cylinder with a rib tool at the wheel',
  'A visitor looking at the portrait wall',
  'A pot spinning on the wheel, seen from above',
  'The pottery room mid-session, trays of thrown cups drying'
];

export const HomeSection: React.FC = () => {
  const {
    workshops, setCustomerTab, setSelectedWorkshopId, events,
    setSelectedBirthdayPackage, publishedBirthdayPackages, setWorkshopsInitialCategory,
    workshopSessions, bookings, queue, todayDateStr, rawWorkshops, categories
  } = useApp();
  const { lang, t } = useLanguage();

  /**
   * Whether the workshops table has come back yet.
   *
   * useLiveTable returns `undefined` until its first read resolves and an array
   * afterwards (src/lib/supabaseData.ts), and AppContext exposes the raw value
   * alongside the mapped one precisely so that distinction survives. `workshops`
   * itself is `rawWorkshops || []`, so by the time it reaches here an empty
   * studio and a studio still loading look identical.
   *
   * Sessions are deliberately NOT part of this. The featured selection falls
   * back to any published workshop ranked by demand when no session qualifies,
   * so once the workshops are in, the row has something to show whether or not
   * the sessions have landed.
   */
  const workshopsLoading = rawWorkshops === undefined;
  const [showOwnerContact, setShowOwnerContact] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  /**
   * The wipe shared by the map and the Custom Events photograph, reused for the
   * in-place swap between the pitch and the owner's details: in from the
   * trailing edge, out the same way. Reduced motion gets the swap with no
   * movement at all — the panels simply exchange.
   */
  const customEventsSwap = prefersReducedMotion
    ? {
        initial: false as const,
        animate: { opacity: 1 },
        exit: undefined,
        transition: { duration: 0 }
      }
    : {
        initial: { opacity: 0, clipPath: 'inset(0 0 0 100%)' },
        animate: { opacity: 1, clipPath: 'inset(0 0 0 0%)' },
        exit: { opacity: 0, clipPath: 'inset(0 0 0 100%)' },
        transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const }
      };

  /**
   * The week's featured workshops: available in the next seven days, ranked by
   * active bookings over the trailing thirty, capped at four. The aggregation
   * walks every session and booking, so it is memoised on the records it reads
   * — the carousel re-renders on every settle and must not re-run this.
   */
  const featuredSeatSessionIds = useMemo(
    () => workshopSessions.filter(s => (s.status || 'Published') === 'Published').map(s => String(s.id)),
    [workshopSessions]
  );
  const featuredSeats = useSessionSeats(featuredSeatSessionIds);

  /**
   * Popularity, counted by the database over the trailing 30 days. Counting the
   * `bookings` array here scored every workshop zero for the public — see
   * migration 0024 — so the carousel never actually ranked by demand.
   */
  const rankingWindow = useMemo(() => recentBookingsWindow(todayDateStr), [todayDateStr]);
  const recentBookings = useRecentBookings(rankingWindow.from, rankingWindow.to);

  const featuredWorkshops = useMemo(
    () => selectFeaturedWorkshops(
      { workshops, workshopSessions },
      todayDateStr,
      undefined,
      featuredSeats.get,
      recentBookings.get
    ),
    [workshops, workshopSessions, todayDateStr, featuredSeats, recentBookings]
  );

  /** Images only — the carousel renders cards, the details sit below it. */
  const featuredSlides = useMemo(
    () => featuredWorkshops.map(ws => ({ src: ws.image, alt: localizedText(ws.title, ws.titleAr, lang) })),
    [featuredWorkshops, lang]
  );

  const [featuredIndex, setFeaturedIndex] = useState(0);
  // The list can shrink between renders — a session fills up, a workshop is
  // archived — so the index is resolved against the current array rather than
  // trusted, and never points past its end.
  const activeFeatured = featuredWorkshops[featuredIndex] || featuredWorkshops[0] || null;
  const activeTitle = activeFeatured ? localizedText(activeFeatured.title, activeFeatured.titleAr, lang) : '';
  const activeHook = activeFeatured ? localizedText(activeFeatured.hook, activeFeatured.hookAr, lang) : '';

  const publishedEvents = events.filter(evt => evt.status === 'Published');

  /**
   * The home page shows at most three packages. The full list lives on the
   * Birthday Packages page, which the "See packages" button already goes to, so
   * there is nothing here to say "view all" about.
   */
  const homeBirthdayPackages = useMemo(
    () => publishedBirthdayPackages.slice(0, 3),
    [publishedBirthdayPackages]
  );

  /**
   * Workshops a customer can actually see and book.
   *
   * The "Workshops running" stat and the "View All" count both used
   * `workshops.length`, the raw table, so both advertised drafts — 7 when only 4
   * were live. Counted once here so the two figures cannot drift apart again.
   */
  const publishedWorkshops = useMemo(
    () => workshops.filter(ws => ws.status === 'Published'),
    [workshops]
  );

  const formatEventDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return formatDate(d, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  const steps = [
    {
      num: '01',
      title: t('Choose a Workshop', 'اختر ورشة'),
      desc: t(
        'Browse our curated collection of wheel throwing, hand-building, or acrylic canvas painting classes.',
        'تصفح مجموعتنا المختارة من ورش الخزف على العجلة، التشكيل اليدوي، أو رسم الأكريليك على القماش.'
      ),
      icon: MousePointerClick
    },
    {
      num: '02',
      title: t('Pick Your Time', 'اختر وقتك'),
      desc: t(
        'Select a convenient slot on our live scheduler. Hand-molding seats are limited for high quality tuition.',
        'اختر موعدًا مناسبًا من الجدول المباشر. مقاعد التشكيل اليدوي محدودة لضمان جودة التوجيه.'
      ),
      icon: CalendarRange
    },
    {
      num: '03',
      title: t('Book and Create', 'احجز وابدأ الإبداع'),
      desc: t(
        'Secure your spot instantly. Show up at our cozy Jeddah venue—all premium materials and drinks are ready.',
        'احجز مقعدك فورًا. تعال إلى استوديونا الدافئ في جدة — كل المواد المميزة والمشروبات جاهزة لك.'
      ),
      icon: Paintbrush
    }
  ];



  const handleCardClick = (id: string) => {
    setSelectedWorkshopId(id);
    setCustomerTab('detail');
  };

  return (
    <div className="animate-in fade-in duration-300">
      
      {/* HERO — a stack of studio photographs that deals itself into a row.
          Copy, CTAs and the three facts are unchanged; only the arrangement
          around them is new. */}
      <section className="bg-brand-cream pt-10 sm:pt-14 pb-16 md:pb-20 overflow-hidden">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

          <Reveal index={0}>
            <p className="text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
              {t('Creative Sanctuary in Jeddah', 'ملاذ إبداعي في جدة')}
            </p>
          </Reveal>

          <h1 dir={lang === 'ar' ? 'rtl' : 'ltr'} className="mx-auto mt-4 max-w-3xl text-center font-display text-[34px] sm:text-5xl lg:text-[62px] font-semibold text-brand-charcoal">
            <VerticalCutReveal
              key={lang}
              splitBy={lang === 'ar' ? 'words' : 'characters'}
              staggerDuration={0.04}
              staggerFrom="center"
              transition={{ damping: 20, stiffness: 300, type: 'spring' }}
            >
              {t('Melt into the art of ', 'انغمس في فن ')}
              <span className="text-brand-sage">{t('clay & canvas', 'الطين واللوحة')}</span>
              .
            </VerticalCutReveal>
          </h1>

          <Reveal index={1}>
            <p className="mx-auto mt-5 max-w-xl text-center text-base sm:text-lg text-brand-ink leading-[1.7]">
              {t(
                'Slow down, pour a fresh cup of espresso, and handcraft ceramic pottery or vibrant acrylic art in Jeddah’s favorite creative retreat.',
                'خذ وقتك، اصبب فنجانًا من الإسبريسو الطازج، واصنع بيديك أعمال فخارية أو لوحات أكريليك في ملاذ جدة الإبداعي المفضل.'
              )}
            </p>
          </Reveal>

          <PhotoGallery images={HERO_IMAGES} alts={HERO_ALTS} className="mt-10">
            <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-3 sm:gap-4">
              <button
                onClick={() => {
                  setWorkshopsInitialCategory('All');
                  setCustomerTab('workshops');
                }}
                className="cursor-pointer rounded-full bg-brand-terracotta px-7 py-4 text-base font-semibold text-brand-cream shadow-button hover:bg-brand-terracotta-hover transition-colors duration-200 active:scale-[0.98]"
              >
                {t('Browse Workshops', 'تصفح الورش')}
              </button>
              <button
                onClick={() => {
                  setSelectedWorkshopId('ws-1');
                  setCustomerTab('detail');
                }}
                className="cursor-pointer rounded-full border border-brand-clay bg-brand-cream px-7 py-4 text-base font-semibold text-brand-charcoal hover:bg-brand-clay-soft transition-colors duration-200"
              >
                {t('View Top Experience', 'استعرض أفضل التجارب')}
              </button>
            </div>

            {/* Three plain facts about the studio — the design leads with
                proof rather than adjectives. */}
            <dl className="mx-auto mt-12 grid max-w-xl grid-cols-1 xs:grid-cols-3 gap-6 border-t border-brand-clay pt-8">
              <div>
                <dt className="font-display text-2xl font-semibold text-brand-charcoal ltr-numerals">
                  <CountingNumber target={publishedWorkshops.length} />
                </dt>
                <dd className="mt-1 text-[11px] uppercase tracking-[0.1em] text-brand-muted">{t('Workshops running', 'ورشة نشطة')}</dd>
              </div>
              <div>
                <dt className="font-display text-2xl font-semibold text-brand-charcoal ltr-numerals">
                  <CountingNumber target={2} />
                </dt>
                <dd className="mt-1 text-[11px] uppercase tracking-[0.1em] text-brand-muted">{t('Kilns firing weekly', 'أفران تعمل أسبوعيًا')}</dd>
              </div>
              <div>
                <dt className="font-display text-2xl font-semibold text-brand-charcoal ltr-numerals">
                  {/* A year, so no thousands separator — never "2,021". */}
                  <CountingNumber target={2021} from={1990} groupThousands={false} />
                </dt>
                <dd className="mt-1 text-[11px] uppercase tracking-[0.1em] text-brand-muted">{t('On Ahmad Al Attas St.', 'في شارع أحمد العطاس')}</dd>
              </div>
            </dl>
          </PhotoGallery>

        </div>
      </section>

      {/* FEATURED WORKSHOPS — a white full-bleed band, so the cards read against
          a clean backdrop instead of blending into the cream page.

          The whole band is guarded, not just the carousel inside it. The guard
          used to sit on the slides alone, so an empty list left the heading,
          the strapline and "View All" stranded above nothing. With the tiered
          fallback this is now only reachable when the studio has no visible
          workshops at all — but that is exactly when a heading over blank space
          would look most broken.

          Held open while the data is still in flight, though. Unmounting on
          "the list is empty right now" meant the whole band was absent for the
          first few hundred milliseconds of every visit and then popped in,
          shifting the page under anyone already scrolling. The band is only
          absent once the workshops have actually arrived and there is genuinely
          nothing to feature. */}
      {(workshopsLoading || featuredWorkshops.length > 0) && (
      <section className="bg-white border-y border-brand-clay/60 py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Header — the words and the View All action share one row, the action
            sitting against the trailing edge on the same baseline as the
            heading. The whole row is one stagger, so the button still plays in
            on its own beat as the last line of the sequence. */}
        <ContainerStagger className="flex flex-col gap-6 text-start sm:flex-row sm:items-end sm:justify-between sm:gap-10">
          <div className="min-w-0">
            {/* Was "This week". The tiered fallback can now fill this row from
                the fortnight beyond it, or from demand alone, so a week-specific
                label would sometimes be false — the same class of claim as the
                confirmation screen's sent-email line. */}
            <ContainerAnimated className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
              {t('Popular right now', 'الأكثر رواجًا الآن')}
            </ContainerAnimated>
            <ContainerAnimated className="mt-2 font-display text-3xl md:text-[38px] font-semibold text-brand-charcoal">
              <h2>{t('Featured Workshops', 'ورش مميزة')}</h2>
            </ContainerAnimated>
            <ContainerAnimated className="mt-3 max-w-xl text-brand-ink">
              {t(
                'Led by professional artisan tutors. Spaces are kept tight for custom, hands-on feedback.',
                'بإشراف حرفيين محترفين. المقاعد محدودة عمدًا لضمان متابعة فردية عن قرب.'
              )}
            </ContainerAnimated>
          </div>

          <ContainerAnimated className="shrink-0">
            <button
              onClick={() => {
                setWorkshopsInitialCategory('All');
                setCustomerTab('workshops');
              }}
              className="group inline-flex shrink-0 items-center gap-2 rounded-full border border-brand-clay bg-brand-cream px-5 py-2.5 text-sm font-semibold text-brand-charcoal transition-colors hover:bg-brand-clay-soft cursor-pointer"
            >
              <span>{t('View All', 'عرض الكل')} ({publishedWorkshops.length})</span>
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1 flip-rtl" />
            </button>
          </ContainerAnimated>
        </ContainerStagger>

        {/* The carousel. Only the images ride in it; the details for whichever
            card is centred are rendered below in the site's own type, which is
            why the component takes no caption of its own. */}
        {/* The carousel's own height is `var(--cf-card)` plus its py-10 frame, so
            the space it will occupy is known before the data is. Reserving it
            with a plain spacer rather than a skeleton: a skeleton would need
            card shapes, a shimmer and its own reduced-motion handling to say
            nothing the heading above has not already said. This is one div. */}
        {workshopsLoading && (
          <div
            aria-hidden="true"
            className="mt-8 lg:mt-10"
            style={{ minHeight: 'calc(clamp(148px, 22vw, 260px) + 5rem)' }}
          />
        )}

        {featuredSlides.length > 0 && (
          <div className="mt-8 lg:mt-10">
            <CoverflowCarousel
              slides={featuredSlides}
              label={t('Featured workshops', 'الورش المميزة')}
              /* No geometry props on purpose. rotate, depth, perspective,
                 falloff, fade, gap and cardWidth are all left at the reference
                 component's own defaults, which are the visual target — this
                 section previously overrode every one of them, and that is
                 what flattened the rake and narrowed the neighbours. Anything
                 to be adjusted about how this looks belongs around the
                 carousel, not in its numbers. */
              autoPlay
              autoPlayInterval={3500}
              showPagination
              onSelectedChange={setFeaturedIndex}
              onActivate={index => {
                const workshop = featuredWorkshops[index];
                if (workshop) handleCardClick(workshop.id);
              }}
            />

            {/* The centred workshop, in full. Keyed on the id so the block
                re-enters as the carousel settles on a new one. */}
            {activeFeatured && (
              <div key={activeFeatured.id} className="mt-6 text-center animate-in fade-in duration-500">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
                  {categoryLabel(activeFeatured.category, categories, lang)}
                  {activeFeatured.skillLevel ? ` · ${enumLabel('skillLevel', activeFeatured.skillLevel, lang)}` : ''}
                </span>

                <button
                  type="button"
                  onClick={() => handleCardClick(activeFeatured.id)}
                  /* 24/28px sat heavy over a 260px card. One step down keeps it
                     the focal line without outweighing the image it describes. */
                  className="group mt-2 cursor-pointer font-display text-xl md:text-2xl font-semibold text-brand-charcoal transition-colors hover:text-brand-terracotta"
                >
                  {activeTitle}
                </button>

                {activeHook && (
                  /* max-w-xl is 576px — 2.2x the 260px card, so the text block
                     read as the subject and the image as a thumbnail. This clamp
                     tracks the card's own clamp(148px, 22vw, 260px) at roughly
                     1.5x, so the relationship holds at every width instead of
                     only at one breakpoint. Carousel geometry is untouched; the
                     text is what moves. */
                  <p className="mx-auto mt-2 max-w-[clamp(240px,34vw,400px)] text-[15px] leading-[1.7] text-brand-ink">
                    {activeHook}
                  </p>
                )}

                {/* The site's meta treatment: lucide at h-4 w-4 in sage, 1.5
                    gap — the same pairing the workshop and package cards use. */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[13px] text-brand-ink">
                  {activeFeatured.duration && (
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="h-4 w-4 shrink-0 text-brand-sage" />
                      <span dir="auto">{durationLabel(activeFeatured.duration, lang)}</span>
                    </span>
                  )}
                  {activeFeatured.ageRange && (
                    <span className="inline-flex items-center gap-1.5">
                      <Sparkles className="h-4 w-4 shrink-0 text-brand-sage" />
                      <span dir="auto">{ageRangeLabel(activeFeatured.ageRange, lang)}</span>
                    </span>
                  )}
                  {activeFeatured.instructor && (
                    <span className="inline-flex items-center gap-1.5">
                      <Paintbrush className="h-4 w-4 shrink-0 text-brand-sage" />
                      <span>{t('Instructor', 'المدرّب')} {activeFeatured.instructor}</span>
                    </span>
                  )}
                </div>

                <p className="mt-4 font-display text-[26px] font-semibold text-brand-charcoal ltr-numerals">
                  {activeFeatured.price} <span className="text-sm font-medium text-brand-muted">{t('SAR', 'ريال')}</span>
                </p>
              </div>
            )}
          </div>
        )}

      </div>
      </section>
      )}

      {/* HOW BOOKING WORKS */}
      <section className="bg-brand-sand border-y border-brand-clay py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <div className="max-w-xl mx-auto mb-12">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">{t('Three steps', 'ثلاث خطوات')}</span>
            <Reveal index={0}>
              <h2 className="mt-2 font-display text-3xl md:text-[38px] font-semibold text-brand-charcoal">
                {t('How Booking Works', 'كيف يتم الحجز')}
              </h2>
            </Reveal>
            <Reveal index={1}>
              <p className="text-brand-ink mt-2">
                {t(
                  'Three simple, effortless steps from clay mud to beautiful glazed pottery.',
                  'ثلاث خطوات بسيطة وسلسة من طين الفخار إلى قطعة خزفية جميلة ومزجّجة.'
                )}
              </p>
            </Reveal>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {steps.map((step, stepIndex) => {
              const Icon = step.icon;
              return (
                <ScrollReveal
                  key={step.num}
                  once
                  /* Fires a little before the card is 30% in, so the stagger
                     is already running as the section arrives rather than
                     finishing after it has settled. */
                  viewOptions={{ once: true, amount: 0.3, margin: '0px 0px -80px 0px' }}
                  transition={{ delay: stepIndex * 0.12, duration: 0.5, ease: 'easeOut' }}
                  variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
                >
                <div className="bg-brand-cream rounded-[22px] p-7 border border-brand-clay shadow-card-sm relative text-start h-full">
                  <div className="absolute top-5 end-6 font-display text-3xl font-semibold text-brand-clay">
                    {step.num}
                  </div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-brand-sage-soft text-brand-sage-hover mb-5">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-brand-charcoal mb-2">{step.title}</h3>
                  <p className="text-sm text-brand-ink leading-relaxed">{step.desc}</p>
                </div>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* CELEBRATE YOUR BIRTHDAY WITH US — a dark full-bleed band, like every
          other section on the page, instead of a card floating on the cream
          background. Points only at the packages themselves; custom, one-off
          events live in their own section below so the two never blur. */}
      {/* brand-sage (#7C8F80) — the mid sage, the value the hero sets the word
          "canvas" in. The band was charcoal, then sage-hover; this is the same
          design on a lighter green, and the LIGHTER GREEN IS THE ONLY CHANGE.
          Every cream tint below is the one the dark version used.

          KNOWN: cream on #7C8F80 is 3.20:1, under AA for normal text — it
          passes only as large text. Deliberate, and recorded in
          docs/parked-work.md rather than solved by changing the design: fixing
          it means charcoal-only at full opacity, which collapses the type
          hierarchy this section is built on. Revisit it as an accessibility
          item, not as a colour preference. */}
      <section className="relative overflow-hidden bg-brand-sage py-16 md:py-20">
      {/* Decorative only. The balloons layer is pointer-events-none, so the
          button and the package cards stay fully clickable through it. */}
      <BirthdayBalloons />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">

            <div className="text-start">
              {/* Reveal order through this section: badge → heading →
                  paragraph → button → package 01 → package 02. */}
              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.3 }}
                transition={{ delay: 0, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
              >
                {/* /10 and /85 were set against a much darker brown; both lift
                    slightly so the pill still separates from the lighter band. */}
                <div className="inline-flex items-center gap-2 rounded-full bg-brand-cream/15 px-3.5 py-1.5 text-xs font-medium text-brand-cream/90">
                  <Gift className="h-3.5 w-3.5" />
                  <span>{t('Birthday Celebrations & Private Parties', 'احتفالات أعياد الميلاد والحفلات الخاصة')}</span>
                </div>
              </ScrollReveal>

              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.3 }}
                transition={{ delay: 0.12, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
              >
                <ContainerStagger>
                  <ContainerAnimated className="mt-6 font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-brand-cream">
                    <h2>{t('Celebrate your birthday with us', 'احتفل بعيد ميلادك معنا')}</h2>
                  </ContainerAnimated>
                </ContainerStagger>
              </ScrollReveal>

              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.3 }}
                transition={{ delay: 0.24, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
              >
                {/* /70 measured 4.28:1 on the new ground — under AA for 16px
                    body. /80 is 5.0:1. */}
                <p className="mt-5 max-w-lg text-base leading-[1.7] text-brand-cream/80">
                  {t(
                    'Make your child’s special day unforgettable with creative art sessions, balloons, customized cakes, and fun hands-on memories in our studio.',
                    'اجعلوا يوم طفلكم المميز لا يُنسى مع جلسات فنية إبداعية، وبالونات، وكعكات مخصصة، وذكريات ممتعة في استوديونا.'
                  )}
                </p>
              </ScrollReveal>

              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.3 }}
                transition={{ delay: 0.36, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
                className="mt-8 flex flex-wrap gap-3"
              >
                <button
                  type="button"
                  onClick={() => {
                    // Overview mode: clearing the selection is what stops a
                    // package chosen earlier from opening itself here.
                    setSelectedBirthdayPackage('');
                    setWorkshopsInitialCategory('Birthday Packages');
                    setCustomerTab('workshops');
                  }}
                  /* TRY-AND-SEE, part of the sage band above. The site-wide CTA
                     is terracotta on cream, and it stays that way everywhere
                     else — but terracotta (#5A4132) against sage-hover (#4A5B4E)
                     is 1.3:1, a dark brown on a dark green of nearly the same
                     lightness, so the button stopped reading as a button. Cream
                     on the band is 6.7:1 and charcoal on cream is 13.9:1.
                     Inverted for THIS instance only. */
                  className="cursor-pointer rounded-full bg-brand-cream px-6 py-3.5 text-sm font-semibold text-brand-charcoal shadow-button transition-colors hover:bg-brand-clay-soft active:scale-[0.98]"
                >
                  {t('See packages', 'استعرض الباقات')}
                </button>
              </ScrollReveal>
            </div>

            {homeBirthdayPackages.length > 0 && (
              /* Stacked, not side by side. Three tickets across this column made
                 each one a narrow vertical sliver — copy wrapping every two or
                 three words, and the tear notches landing partway down a tall
                 card instead of beside a stub. A ticket is a wide shape. Stacked
                 wide rows read correctly at one, two or three, and the column
                 grows downward beside the heading rather than squeezing sideways.

                 The SHAPE is the `.package-ticket` geometry the Birthday
                 Packages page uses — corner cuts, the two perforation notches,
                 and the dotted divider inset by the stub width. Shape only: the
                 palette, content and type below are this section's own, and the
                 perforation colour is set explicitly rather than inherited. */
              <div className="flex flex-col gap-4 sm:gap-5">
                {homeBirthdayPackages.map((pkg, index) => (
                  <ScrollReveal
                    key={pkg.id}
                    once
                    viewOptions={{ once: true, amount: 0.3 }}
                    transition={{ delay: 0.48 + index * 0.12, duration: 0.5, ease: 'easeOut' }}
                    variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
                  >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedBirthdayPackage(pkg.id);
                      setWorkshopsInitialCategory('Birthday Packages');
                      setCustomerTab('workshops');
                    }}
                    /* 0.07 was a barely-lighter brown on brown and disappears
                       entirely on sage. 0.15 keeps the ticket clearly a separate
                       object without drifting toward cream, which is what the
                       stub and the notches would start to look wrong against. */
                    className="package-ticket group relative flex w-full cursor-pointer flex-col overflow-hidden rounded-[4px] bg-brand-cream/[0.15] text-start shadow-card transition-all duration-300 hover:bg-brand-cream/[0.22] motion-safe:hover:-translate-y-0.5 sm:min-h-[140px] sm:flex-row"
                    /* The perforation is a light dotted line, so a lighter ground
                       costs it contrast rather than gaining it. 0.28 -> 0.45. */
                    style={{ ['--ticket-perf-color' as string]: 'rgba(255, 250, 240, 0.45)' }}
                  >
                    {/* MAIN — everything left of the perforation. */}
                    <div className="flex flex-1 flex-col px-6 py-5 sm:py-6">
                      {/* The ticket's punched holes. */}
                      <span className="flex gap-1" aria-hidden="true">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-cream/35" />
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-cream/35" />
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-cream/35" />
                      </span>

                      <h3 className="mt-2 font-display text-2xl font-semibold text-brand-cream">{localizedText(pkg.name, pkg.nameAr, lang)}</h3>

                      {/* 13px, so AA still wants 4.5:1. /60 no longer reaches it
                          on this ground; /75 does. */}
                      <p className="mt-2 text-[13px] leading-relaxed text-brand-cream/75">
                        {[
                          // ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker.
                          pkg.maxGuests ? `${pkg.maxGuests} ${t('guests', 'ضيوف')}` : null,
                          localizedText(pkg.duration, pkg.durationAr, lang) || null,
                          localizedText(pkg.shortDescription, pkg.shortDescriptionAr, lang) || null
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>

                    {/* STUB — right of the perforation on a wide screen, below it
                        on a phone, matching where .package-ticket moves the
                        notches. The widths track --stub-w exactly (130px, 148px
                        from lg) so the notches land on the boundary rather than
                        near it. */}
                    <div className="flex h-[5.5rem] w-full shrink-0 flex-row items-center justify-between gap-3 px-5 py-3 sm:h-auto sm:w-[130px] sm:flex-col sm:justify-center sm:gap-0 sm:px-4 sm:py-5 sm:text-center lg:w-[148px]">
                      <div>
                        <span className="font-display text-2xl font-semibold text-brand-cream ltr-numerals">
                          {pkg.price}
                        </span>
                        {/* 10px at /50 passed on the brown (4.69:1) and drops to
                            3.0:1 here — the one item the background change
                            genuinely broke. /80 restores it to 5.0:1. */}
                        {/* Per person, not per party — the price is multiplied by
                            headcount. The rest of the birthday flow says the same
                            thing, from each package's own pricingLabel. */}
                        <span className="mt-0.5 block text-[10px] text-brand-cream/80">{t('SAR per person', 'ريال للشخص')}</span>
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-cream/85 transition-colors group-hover:text-brand-cream sm:mt-3">
                        {t('See package', 'عرض الباقة')}
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1 flip-rtl" />
                      </span>
                    </div>
                  </button>
                  </ScrollReveal>
                ))}
              </div>
            )}

          </div>
      </div>
      </section>

      {/* CREATE YOUR OWN EVENT — deliberately its own section, separate from the
          birthday packages above, so customers don't mistake a custom request
          for one of the fixed packages. A white full-bleed band, like Featured
          Workshops, so the page's sections keep alternating backgrounds. */}
      <section className="bg-white border-y border-brand-clay/60 py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* One cream slab holding the whole section: words on the left, the
            studio on the right, the image given the larger share. */}
        <motion.div
          layout={!prefersReducedMotion}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative overflow-hidden rounded-[32px] bg-brand-sand px-6 py-10 sm:px-10 sm:py-12 lg:px-14"
        >

          {/* Quiet studio marks — a clay curve and two sparks. Decorative only. */}
          <svg
            className="pointer-events-none absolute -left-10 -top-10 h-40 w-40 text-brand-clay/50"
            viewBox="0 0 100 100" fill="none" aria-hidden="true"
          >
            <circle cx="50" cy="50" r="34" stroke="currentColor" strokeWidth="1.25" />
            <path d="M22 62c14-10 28-14 42-8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
          <svg
            className="pointer-events-none absolute bottom-6 left-8 h-20 w-20 text-brand-sage/35"
            viewBox="0 0 100 100" fill="none" aria-hidden="true"
          >
            <path d="M50 14c4 22 14 32 36 36-22 4-32 14-36 36-4-22-14-32-36-36 22-4 32-14 36-36Z"
                  stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>

          {/* The card holds two states in the same slab: the pitch, and the
              owner's details. `mode="wait"` lets the outgoing one finish its
              wipe before the incoming one starts, so the two never overlap
              mid-swap; `layout` on the slab absorbs the height difference
              between them instead of snapping. */}
          <AnimatePresence mode="wait" initial={false}>
          {!showOwnerContact ? (
          <motion.div
            key="custom-events-pitch"
            {...customEventsSwap}
            className="relative grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-14"
          >

            {/* Words — five of twelve columns, so the photograph leads. */}
            <div className="text-start lg:col-span-5">
              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.45, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0 }, visible: { opacity: 1 } }}
              >
                <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
                  {t('Custom Events', 'فعاليات مخصصة')}
                </span>
              </ScrollReveal>

              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.4 }}
                transition={{ delay: 0.1, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0 } }}
              >
                <ContainerStagger>
                  <ContainerAnimated className="mt-3 font-display text-[34px] leading-[1.1] md:text-[46px] font-semibold text-brand-charcoal">
                    <h2>{t('Plan your own event', 'خطط لفعاليتك الخاصة')}</h2>
                  </ContainerAnimated>
                </ContainerStagger>
              </ScrollReveal>

              <ScrollReveal
                once
                viewOptions={{ once: true, amount: 0.4 }}
                transition={{ delay: 0.2, duration: 0.5, ease: 'easeOut' }}
                variants={{ hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0 } }}
              >
                <p className="mt-5 max-w-md text-[15px] text-brand-ink leading-[1.75]">
                  {t(
                    'Adult pottery parties, corporate team-building, birthday celebrations, or anything outside our fixed packages — talk to us directly and we will design something custom.',
                    'حفلات فخار للبالغين، أنشطة بناء الفريق للشركات، احتفالات أعياد الميلاد، أو أي فكرة خارج باقاتنا الثابتة — تواصلوا معنا مباشرة وسنصمم لكم شيئًا مخصصًا.'
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
                  onClick={() => setShowOwnerContact(prev => !prev)}
                  className="group cursor-pointer inline-flex items-center justify-center gap-2.5 rounded-full bg-brand-charcoal px-7 py-4 text-base font-semibold text-brand-cream shadow-button transition-colors duration-200 hover:bg-brand-terracotta active:scale-[0.98]"
                >
                  <Sparkles className="h-5 w-5 text-brand-terracotta transition-colors group-hover:text-brand-cream" />
                  <span>{t('Create your own Event', 'أنشئ فعاليتك الخاصة')}</span>
                  {/* Always the forward chevron now: this button only exists on
                      the pitch face, and the way back is the Back control on
                      the contact face rather than a collapse here. */}
                  <ChevronRight className="h-5 w-5 text-brand-cream/70 transition-transform duration-200 group-hover:translate-x-1 flip-rtl" />
                </button>
              </ScrollReveal>
            </div>

            {/* The studio — seven of twelve, wiped in from the trailing edge. */}
            <ScrollReveal
              once
              viewOptions={{ once: true, amount: 0.25 }}
              transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              /* The observed element must not be the clipped one — an element
                 clipped to zero area reports zero intersection, so useInView
                 never fires and the reveal holds it invisible. The wipe is on
                 the inner element, which inherits the variant. */
              variants={{ hidden: { opacity: 0, x: 48 }, visible: { opacity: 1, x: 0 } }}
              className="lg:col-span-7"
            >
              <motion.div
                className="relative overflow-hidden rounded-[26px] shadow-card"
                variants={{
                  hidden: { clipPath: 'inset(0 0 0 100%)' },
                  visible: { clipPath: 'inset(0 0 0 0%)' }
                }}
                transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/custom-events.jpg`}
                  alt={t('The Arty Café studio set up for a private event', 'استوديو آرتي كافيه مجهّز لفعالية خاصة')}
                  className="h-64 w-full object-cover sm:h-80 lg:h-[26rem]"
                  loading="lazy"
                  decoding="async"
                />
              </motion.div>
            </ScrollReveal>

          </motion.div>
          ) : (
            /* The owner's details — same content as the card that used to open
               below this section, now the card's second face. */
            <motion.div
              key="custom-events-contact"
              {...customEventsSwap}
              /* Laid straight onto the slab — no wrapper card of its own. The
                 minimum height is the photograph's on the other face, so the
                 slab stays roughly the same size through the swap instead of
                 collapsing; the content centres in it rather than leaving a
                 band of empty sand underneath. */
              className="relative text-start lg:min-h-[26rem] lg:flex lg:flex-col lg:justify-center"
            >
              {/* Same five/seven split as the pitch: the heading holds the
                  narrow column, the details take the wider one. */}
              <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-14">

                <div className="lg:col-span-5">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-terracotta text-brand-cream shrink-0">
                    <UserCheck className="h-6 w-6" />
                  </div>
                  <h3 className="mt-5 font-display text-[28px] leading-tight font-semibold text-brand-charcoal md:text-[34px]">
                    {t('Talk to Our Events Team', 'تحدث إلى فريق الفعاليات لدينا')}
                  </h3>
                  <p className="mt-4 max-w-md text-[15px] leading-[1.75] text-brand-ink">
                    {t(
                      'Talk to our team directly and we will craft custom events, corporate gatherings, or private parties with you.',
                      'تحدث مع فريقنا مباشرة، وسنصمم لك فعاليات مخصصة، أو تجمعات للشركات، أو حفلات خاصة.'
                    )}
                  </p>

                  {/* Reverses the swap — the pitch, button and photograph wipe
                      back in. The button that opened this is part of the face
                      that just left, so the way back lives here. Sits where
                      that button sat, so the control does not appear to jump
                      across the card between the two faces. */}
                  <button
                    type="button"
                    onClick={() => setShowOwnerContact(false)}
                    className="group mt-8 cursor-pointer inline-flex items-center gap-2 rounded-full border border-brand-clay bg-brand-cream px-6 py-3.5 text-sm font-semibold text-brand-ink transition-colors hover:text-brand-charcoal hover:border-brand-muted active:scale-[0.98]"
                  >
                    <ArrowLeft className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5 flip-rtl" />
                    <span>{t('Back', 'رجوع')}</span>
                  </button>
                </div>

                <div className="space-y-4 lg:col-span-7">
                  {/* Cream on sand, where these sub-boxes used to be sand on
                      cream — the tones swap with the background they now sit
                      on so the blocks stay legible. */}
                  <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                    <div className="bg-brand-cream p-5 rounded-2xl border border-brand-clay flex items-start gap-3">
                      <Phone className="h-5 w-5 text-brand-terracotta shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="text-[10px] font-semibold text-brand-muted uppercase block">{t('Direct Phone & WhatsApp', 'اتصال مباشر وواتساب')}</span>
                        {/* wa.me rather than tel:, because the label offers WhatsApp
                            and that is how these enquiries actually arrive. The href
                            needs the bare international digits; the visible number
                            stays formatted. */}
                        <a
                          href={STUDIO_WHATSAPP_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block font-semibold text-brand-charcoal hover:text-brand-terracotta font-mono ltr-numerals"
                        >
                          {STUDIO_WHATSAPP_DISPLAY}
                        </a>
                      </div>
                    </div>

                    <div className="bg-brand-cream p-5 rounded-2xl border border-brand-clay flex items-start gap-3">
                      <Mail className="h-5 w-5 text-brand-terracotta shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span className="text-[10px] font-semibold text-brand-muted uppercase block">{t('Email Us', 'راسلنا عبر البريد الإلكتروني')}</span>
                        <a href={`mailto:${STUDIO_EMAIL}`} className="mt-1 block break-words font-semibold text-brand-charcoal hover:text-brand-terracotta">
                          {STUDIO_EMAIL}
                        </a>
                      </div>
                    </div>
                  </div>

                  <div className="bg-brand-cream p-5 rounded-2xl border border-brand-clay text-[13px] text-brand-ink space-y-1.5">
                    <p className="font-semibold text-brand-charcoal flex items-center gap-1.5">
                      <Star className="h-3.5 w-3.5 text-brand-terracotta fill-brand-terracotta" />
                      {t('Bespoke Custom Event Planning', 'تخطيط فعاليات مخصص بالكامل')}
                    </p>
                    <p className="leading-[1.7]">
                      {t(
                        'Have a unique theme, adult pottery party, corporate team-building, or birthday celebration in mind? Reach out via WhatsApp or email for custom quotes, private venue buyout availability, and tailored artist arrangements!',
                        'هل لديك فكرة مميزة، حفلة فخار للبالغين، نشاط بناء فريق للشركات، أو احتفال عيد ميلاد؟ تواصل معنا عبر واتساب أو البريد الإلكتروني للحصول على عروض أسعار مخصصة، وحجز الاستوديو بالكامل، وترتيبات فنية مصممة خصيصًا لك!'
                      )}
                    </p>
                  </div>
                </div>

              </div>
            </motion.div>
          )}
          </AnimatePresence>

        </motion.div>
      </div>
      </section>

      {/* LOCATION & CONTACT BLOCK — sits directly on a tan full-bleed band
          (no card wrapper of its own); only the map placeholder on the right
          keeps its own box. The tan tone alternates against its white/cream
          neighbors, matching How Booking Works' treatment above. */}
      <section className="bg-brand-cream border-y border-brand-clay py-16 md:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center text-start">
            
            {/* Info */}
            <div className="lg:col-span-5 space-y-6">
              <Reveal index={0}>
                <h2 className="font-display text-3xl md:text-[38px] font-semibold text-brand-charcoal">
                  {t('Slow down & visit us', 'خذ وقتك وزُرنا')}
                </h2>
              </Reveal>
              <Reveal index={1}>
                <p className="text-brand-ink leading-[1.7]">
                  {t(
                    'We are situated in Al Zahra District. Grab a quiet corner, sculpt some clay, and meet friendly creative people.',
                    'نحن نقع في حي الزهراء. اختر ركنًا هادئًا، شكّل الطين، والتقِ بأشخاص مبدعين وودودين.'
                  )}
                </p>
              </Reveal>
              
              {/* Labelled rows separated by hairlines — no icons, so the
                  eye runs straight down the labels. */}
              <dl className="pt-2 text-sm">
                <Reveal index={2}>
                  <div className="border-t border-brand-clay py-4">
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">{t('Address', 'العنوان')}</dt>
                    <dd className="mt-1.5 text-brand-charcoal">
                      {t(STUDIO_ADDRESS, STUDIO_ADDRESS_AR)}
                    </dd>
                  </div>
                </Reveal>

                <Reveal index={3}>
                  <div className="border-t border-brand-clay py-4">
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">{t('Opening Hours', 'ساعات العمل')}</dt>
                    <dd className="mt-1.5 text-brand-charcoal">
                      <StudioHours />
                    </dd>
                  </div>
                </Reveal>

                <Reveal index={4}>
                  <div className="border-t border-b border-brand-clay py-4">
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">{t('Call Front Desk', 'اتصل بالاستقبال')}</dt>
                    <dd className="mt-1.5 text-brand-charcoal ltr-numerals">
                      {STUDIO_PHONE} ({t('Walk-ins welcome!', 'الزيارات بدون حجز مسبق مرحّب بها!')})
                    </dd>
                  </div>
                </Reveal>
              </dl>
            </div>

            {/* Map — drawn rather than embedded, and clickable as a whole:
                it opens the studio's real Google Maps listing.

                Wiped in from the trailing edge, the same way the Custom Events
                studio photo arrives. As there, the observed element is not the
                clipped one: an element clipped to zero area reports zero
                intersection, so useInView would never fire and the reveal would
                hold it invisible. The wipe lives on the inner element, which
                inherits the variant. */}
            <ScrollReveal
              once
              viewOptions={{ once: true, amount: 0.25 }}
              transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              variants={{ hidden: { opacity: 0, x: 48 }, visible: { opacity: 1, x: 0 } }}
              className="lg:col-span-7"
            >
              <motion.div
                className="relative overflow-hidden rounded-[26px]"
                variants={{
                  hidden: { clipPath: 'inset(0 0 0 100%)' },
                  visible: { clipPath: 'inset(0 0 0 0%)' }
                }}
                transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              >
                <AnimatedMap
                  href={STUDIO_MAPS_URL}
                  label={t('Arty Café Jeddah', 'آرتي كافيه جدة')}
                  coordinates="21.5897° N, 39.1288° E"
                  className="h-72 md:h-96"
                />
              </motion.div>
            </ScrollReveal>

          </div>
      </div>
      </section>

    </div>
  );
};
