/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import Reveal from './ui/Reveal';
import { Search, SlidersHorizontal, RefreshCw, ChevronDown, Clock, Sparkles, Paintbrush } from 'lucide-react';
import { BackButton } from './ui/BackButton';
import { WorkshopCardSlideshow, workshopGalleryImages } from './ui/WorkshopCardSlideshow';
import { Workshop } from '../types';
import { BirthdayPackagesShowcase } from './BirthdayPackagesShowcase';
import { isWorkshopFullyBooked } from '../utils/queueUtils';
import { useSessionSeats, useRecentBookings } from '../lib/sessionSeats';
import { recentBookingsWindow } from '../utils/featuredWorkshops';
import { localizedText } from '../utils/localizedText';
import { categoryLabel, categoryChipLabel } from '../utils/categoryLabel';
import { enumLabel } from '../utils/enumLabels';
import { durationLabel, ageRangeLabel } from '../utils/workshopMetaLabel';

/** Pseudo-category: not a real DB category, it swaps the whole grid to birthday packages. */
const BIRTHDAY_CATEGORY = 'Birthday Packages';

export const WorkshopsBrowsingSection: React.FC = () => {
  const {
    workshops, setCustomerTab, setSelectedWorkshopId, categories: dbCategories,
    publishedBirthdayPackages, selectedBirthdayPackage, setSelectedBirthdayPackage,
    workshopsInitialCategory, workshopSessions, todayDateStr
  } = useApp();
  const { lang, t } = useLanguage();

  /**
   * Seats for every published upcoming session on the grid, in one call.
   *
   * The "Class Full" badge used to be decided by summing the RLS-scoped
   * `bookings` array, which on the public site is empty, so the badge could
   * effectively never appear.
   */
  const gridSeatSessionIds = useMemo(
    () => workshopSessions
      .filter(s => s.status === 'Published' && s.date >= todayDateStr)
      .map(s => String(s.id)),
    [workshopSessions, todayDateStr]
  );
  const gridSeats = useSessionSeats(gridSeatSessionIds);

  /** Popularity for the default sort — see the sort block below. */
  const rankingWindow = useMemo(() => recentBookingsWindow(todayDateStr), [todayDateStr]);
  const recentBookings = useRecentBookings(rankingWindow.from, rankingWindow.to);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(workshopsInitialCategory || 'All');
  const [selectedSkillLevel, setSelectedSkillLevel] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'Popularity' | 'PriceLow' | 'PriceHigh'>('Popularity');

  const isBirthdayView = selectedCategory === BIRTHDAY_CATEGORY;

  // Categories come from the shared data layer, plus the birthday pseudo-category.
  const categories = useMemo(() => {
    const excluded = ['Kids', 'Couples', 'Group'];
    const list = ['All'];
    (dbCategories || []).forEach(c => {
      if (!list.includes(c.name) && !excluded.includes(c.name)) {
        list.push(c.name);
      }
    });
    // Fallback if db is still loading or empty
    const base = list.length === 1 ? ['All', 'Pottery', 'Painting'] : list.filter(c => !excluded.includes(c));
    return [...base, BIRTHDAY_CATEGORY];
  }, [dbCategories]);

  // Filter & Sort math
  const filteredWorkshops = useMemo(() => {
    if (isBirthdayView) return [];

    let result = [...workshops];

    // Published only. This excluded Drafts alone, so Archived workshops — ones
    // staff have deliberately retired — stayed visible and bookable. It also
    // meant the grid and the home page's "Workshops running" stat were counting
    // by two different rules, which is how that stat came to advertise drafts.
    // One rule, in both places.
    result = result.filter(ws => ws.status === 'Published');

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(ws => 
        ws.title.toLowerCase().includes(q) || 
        ws.hook.toLowerCase().includes(q) ||
        (ws.titleAr ?? '').toLowerCase().includes(q) ||
        (ws.hookAr ?? '').toLowerCase().includes(q) ||
        ws.instructor.toLowerCase().includes(q)
      );
    }

    // Category chip
    if (selectedCategory !== 'All') {
      result = result.filter(ws => ws.category === selectedCategory);
    }

    // Skill level filter. A workshop tagged "All Levels" is suitable for
    // every specific level, so it matches whichever one is selected — not
    // just the "All Levels" filter itself.
    if (selectedSkillLevel !== 'All') {
      result = result.filter(ws => ws.skillLevel === selectedSkillLevel || ws.skillLevel === 'All Levels');
    }

    // Sort order
    if (sortBy === 'PriceLow') {
      result.sort((a, b) => a.price - b.price);
    } else if (sortBy === 'PriceHigh') {
      result.sort((a, b) => b.price - a.price);
    } else {
      // Popularity: bookings taken over the trailing 30 days, counted by the
      // database — the same signal the home page's featured carousel ranks by.
      //
      // This used to sort on workshops.spots_left, a single per-workshop
      // counter for a per-session quantity, which a workshop save reset to full
      // and walk-ins never decremented. That column is gone. Seats remaining
      // would not have been popularity either: a 4-seat class that fills would
      // outrank a 20-seat class that sold 15.
      //
      // Order is held until the counts arrive rather than ranking everything
      // equal, so the grid does not reshuffle under the reader.
      if (recentBookings.ready) {
        result.sort((a, b) =>
          (recentBookings.get(b.id) ?? 0) - (recentBookings.get(a.id) ?? 0)
        );
      }
    }

    return result;
  }, [workshops, searchQuery, selectedCategory, selectedSkillLevel, sortBy, isBirthdayView, recentBookings]);

  // Birthday packages are shown in full, unfiltered: with two of them a search
  // box only ever hides one, so it was removed along with the old card grid.
  const filteredBirthdayPackages = useMemo(
    () => (isBirthdayView ? publishedBirthdayPackages : []),
    [publishedBirthdayPackages, isBirthdayView]
  );

  const visibleCount = isBirthdayView ? filteredBirthdayPackages.length : filteredWorkshops.length;

  const handleCardClick = (ws: Workshop) => {
    setSelectedWorkshopId(ws.id);
    setCustomerTab('detail');
  };

  const handleBookPackage = (pkgId: string) => {
    setSelectedBirthdayPackage(pkgId);
    setCustomerTab('birthday-booking');
  };

  const resetFilters = () => {
    setSearchQuery('');
    setSelectedCategory('All');
    setSelectedSkillLevel('All');
    setSortBy('Popularity');
  };

  return (
    <div className="animate-in fade-in duration-300 text-start">

      {/* Catalogue intro + filters — an ivory band sitting directly on the
          page, no page-level card wrapper. */}
      <div className="bg-brand-cream border-b border-brand-clay">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 md:py-14">

      {/* Header Title — no bottom padding on the birthday view, where the
          filter row below it is gone and the packages follow directly. */}
      <div className={isBirthdayView ? '' : 'pb-8'}>
        {/* Way out of the birthday view, now that the category chips are gone.
            Clearing the category is the same switch those chips made, so this
            is the existing navigation rather than a new route.
            Styling comes from the shared BackButton, as it does on every other
            page-level back control. */}
        {isBirthdayView && (
          <Reveal index={0}>
            <BackButton onClick={() => setSelectedCategory('All')} className="mb-6">
              {t('Back to Workshops', 'العودة إلى الورش')}
            </BackButton>
          </Reveal>
        )}

        <Reveal index={0}>
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
            {isBirthdayView ? t('Private Parties', 'حفلات خاصة') : t('Catalogue', 'الكتالوج')}
          </span>
        </Reveal>
        <Reveal index={1}>
          <h1 className="mt-3 font-display text-4xl sm:text-5xl font-semibold text-brand-charcoal max-w-lg">
            {isBirthdayView ? t('Birthday Packages', 'باقات أعياد الميلاد') : t('Creative Workshops', 'ورش إبداعية')}
          </h1>
        </Reveal>
        <Reveal index={2}>
          <p className="text-brand-ink mt-4 max-w-xl text-base leading-[1.7]">
            {isBirthdayView
              ? t(
                  "Browse our birthday party packages, see everything that's included, and pick the one that fits before you book.",
                  'تصفح باقات حفلات أعياد الميلاد لدينا، واطّلع على كل ما تتضمنه، واختر الأنسب لك قبل الحجز.'
                )
              : t(
                  'Discover Jeddah’s premier pottery and painting workshops. Center clay on the wheel, explore watercolor glazes, or paint canvases under guidance of Saudi artists.',
                  'اكتشف أفضل ورش الفخار والرسم في جدة. شكّل الطين على العجلة، أو استكشف تقنيات الألوان المائية، أو ارسم على القماش بإشراف فنانين سعوديين.'
                )}
          </p>
        </Reveal>
      </div>

      {/* Filter and Search Bar — hidden entirely on the birthday view. The
          category chips in particular made a page the visitor already chose
          look like the general workshops catalogue. Only the controls go; the
          category itself is still applied, so nothing about what is listed
          changes. */}
      {!isBirthdayView && (
      <div className="mt-8 space-y-4">
        <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-center justify-between">
          
          {/* Search Box — workshops only. */}
          {!isBirthdayView && (
          <div className="relative flex-1 max-w-md">
            <Search className="absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-muted" />
            <input
              type="text"
              placeholder={isBirthdayView
                ? t('Search packages...', 'ابحث في الباقات...')
                : t('Search by workshop, theme, or tutor...', 'ابحث حسب الورشة، الموضوع، أو المدرّب...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-brand-clay rounded-full py-3.5 ps-11 pe-4 text-sm font-medium text-brand-charcoal placeholder-brand-muted focus:ring-1 focus:ring-brand-sage"
            />
          </div>
          )}

          {/* Sort Dropdown — skill level and popularity/price sorting don't
              apply to birthday packages, so hide them for that category. */}
          {!isBirthdayView && (
            <div className="flex flex-wrap items-center gap-3">
              {/* appearance-none drops the browser's own native arrow (which
                  reserves its own wide gutter regardless of padding) in favor
                  of a chevron placed right against the text. */}
              <div className="relative w-full sm:w-auto">
                <select
                  value={selectedSkillLevel}
                  onChange={(e) => setSelectedSkillLevel(e.target.value)}
                  aria-label={t('Skill Level', 'المستوى المهاري')}
                  className="w-full appearance-none bg-white border border-brand-clay rounded-full py-3 ps-4 pe-9 text-sm font-medium text-brand-charcoal cursor-pointer focus:ring-1 focus:ring-brand-sage sm:w-auto"
                >
                  {/*
                    Two of these once read "All Levels" and "All Levels
                    (Strict)", which are indistinguishable to a customer. They
                    are different kinds of thing: the first is the absence of a
                    filter, the rest are skill tags staff put on a workshop.
                    "Any level" says "show me everything"; "Suitable for all
                    levels" describes the class, matching how the tag reads on
                    the card itself.
                  */}
                  <option value="All">{t('Any level', 'أي مستوى')}</option>
                  <option value="Beginner">{t('Beginner', 'مبتدئ')}</option>
                  <option value="Intermediate">{t('Intermediate', 'متوسط')}</option>
                  <option value="Advanced">{t('Advanced', 'متقدم')}</option>
                  <option value="All Levels">{t('Suitable for all levels', 'مناسب لجميع المستويات')}</option>
                </select>
                <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-muted" />
              </div>

              <div className="relative w-full sm:w-auto">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  aria-label={t('Sort by', 'ترتيب حسب')}
                  className="w-full appearance-none bg-white border border-brand-clay rounded-full py-3 ps-4 pe-9 text-sm font-medium text-brand-charcoal cursor-pointer focus:ring-1 focus:ring-brand-sage sm:w-auto"
                >
                  <option value="Popularity">{t('Popularity (Filling Fast)', 'الأكثر رواجًا (يمتلئ بسرعة)')}</option>
                  <option value="PriceLow">{t('Price: Low to High', 'السعر: من الأقل إلى الأعلى')}</option>
                  <option value="PriceHigh">{t('Price: High to Low', 'السعر: من الأعلى إلى الأقل')}</option>
                </select>
                <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-brand-muted" />
              </div>
            </div>
          )}

        </div>

        {/* Scrollable Category Chips on Mobile */}
        <div className="flex items-center justify-between gap-4 border-t border-brand-clay pt-5">
        <div className="min-w-0 overflow-x-auto no-scrollbar py-1 flex gap-2">
          {categories.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`min-h-11 px-5 py-2.5 rounded-full text-sm sm:text-[13px] font-medium whitespace-nowrap transition-colors duration-150 border cursor-pointer active:scale-[0.97] ${
                  isActive
                    ? 'bg-brand-terracotta border-brand-terracotta text-brand-cream font-semibold'
                    : 'bg-white border-brand-clay text-brand-ink hover:text-brand-charcoal hover:border-brand-muted'
                }`}
              >
                {categoryChipLabel(cat, dbCategories, lang)}
              </button>
            );
          })}
        </div>

        <span className="hidden sm:block shrink-0 text-[13px] text-brand-muted ltr-numerals">
          {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
          {visibleCount} {isBirthdayView ? t('packages', 'باقات') : t('workshops', 'ورش')}
        </span>
        </div>
      </div>
      )}

      </div>
      </div>

      {/* Grid — full-bleed white band, matching the rest of the site instead
          of a page-level card. */}
      {/* Warm off-white under the birthday packages rather than the flat white
          the workshop grid sits on — enough to read as intentional, not enough
          to become a second card behind the panels. */}
      <div className={isBirthdayView ? 'bg-brand-sand/25' : 'bg-white'}>
      <div className={`mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-20 ${
        // Tighter top on the birthday view so the two panels read as part of
        // the heading above them rather than a separate block far below it.
        isBirthdayView ? 'pt-8 md:pt-10' : 'py-10 md:py-14'
      }`}>

      {/* DYNAMIC VIEWS GRID */}
      <div>

        {/* EMPTY STATE */}
        {visibleCount === 0 && (
          <div className="bg-brand-sand/20 border border-brand-clay rounded-2xl py-16 px-4 text-center max-w-lg mx-auto mt-6">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-terracotta/10 text-brand-terracotta mb-4">
              <SlidersHorizontal className="h-7 w-7" />
            </div>
            <h3 className="font-display text-xl font-semibold text-brand-charcoal">
              {isBirthdayView
                ? t('No packages available right now', 'لا توجد باقات متاحة حاليًا')
                : t('No workshops match your filters', 'لا توجد ورش مطابقة لعوامل التصفية')}
            </h3>
            <p className="text-sm text-brand-ink mt-2 max-w-sm mx-auto leading-relaxed">
              {isBirthdayView
                ? t(
                    'Our birthday packages are being updated. Please check back shortly or call the studio.',
                    'يتم حاليًا تحديث باقات أعياد الميلاد لدينا. يرجى العودة قريبًا أو الاتصال بالاستوديو.'
                  )
                : t(
                    'We couldn’t find any clay or painting classes matching your search query or selected category chip. Try clearing the query.',
                    'لم نجد أي ورش فخار أو رسم مطابقة لبحثك أو الفئة المختارة. جرّب مسح كلمة البحث.'
                  )}
            </p>
            <button
              onClick={resetFilters}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-5 py-3 text-xs font-semibold text-brand-cream hover:bg-brand-terracotta-hover shadow-card-sm cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t('Reset All Filters', 'إعادة تعيين عوامل التصفية')}</span>
            </button>
          </div>
        )}
        {/* BIRTHDAY PACKAGES — the redesigned experience replaces the old
            pair of expandable cards. */}
        {isBirthdayView && filteredBirthdayPackages.length > 0 && (
          <BirthdayPackagesShowcase
            packages={filteredBirthdayPackages}
            initialPackageId={
              workshopsInitialCategory === BIRTHDAY_CATEGORY && selectedBirthdayPackage
                ? selectedBirthdayPackage
                : undefined
            }
            onFocusChange={setSelectedBirthdayPackage}
            onChoose={handleBookPackage}
          />
        )}


        {/* LIVE GRID — WORKSHOPS */}
        {!isBirthdayView && filteredWorkshops.length > 0 && (
          /* Two-up below md. The card is ~163px there, so the body drops to
             photo / title / duration / price — the description, ages and
             instructor are all on the detail page. md:grid-cols-3 is
             unaffected: it is a different breakpoint and still wins at 768. */
          <div className="grid grid-cols-2 gap-4 sm:gap-8 md:grid-cols-3">
            {filteredWorkshops.map((ws, cardIndex) => {
              // Fully booked considers every published, upcoming session for
              // this workshop — not just the one date most recently looked at
              // — so a workshop with other open dates is never shown as full.
              const isFull = isWorkshopFullyBooked(ws.id, { workshopSessions }, todayDateStr, gridSeats.get);
              const title = localizedText(ws.title, ws.titleAr, lang);
              const hook = localizedText(ws.hook, ws.hookAr, lang);
              return (
                /* The same Reveal the page headings use, so the grid and the
                   type above it share one fade-and-rise and stay in step if it
                   is ever retuned. `onMount` is what changes: the cards played
                   on scroll and stayed invisible until reached, which on a page
                   the customer has just opened reads as nothing having loaded.

                   The stagger index is capped — 0.1s each is right for a few
                   cards and turns into a slow cascade once a search returns a
                   dozen. Past the sixth they all land together. */
                <Reveal
                  key={ws.id}
                  onMount
                  index={Math.min(cardIndex, 5)}
                  className="h-full"
                >
                <div
                  onClick={() => handleCardClick(ws)}
                  /* The birthday package panel's shell: same radius, ring,
                     shadow and hover lift, so the two card families read as one
                     system. Vertical at every width, as those panels are — the
                     compact phone row this replaced could not carry a title
                     over the image. */
                  className={`group relative flex h-full w-full flex-col overflow-hidden rounded-[32px] bg-white text-start shadow-card ring-1 ring-brand-clay/70 transition-all duration-300 ${
                    isFull
                      ? 'opacity-70 saturate-75 cursor-not-allowed'
                      : 'cursor-pointer hover:shadow-2xl hover:shadow-brand-terracotta/10 hover:ring-brand-clay motion-safe:hover:-translate-y-1'
                  }`}
                >
                  {/* Image banner. Shorter than the package panels' at lg,
                      where these sit three to a row rather than two, so the
                      card does not turn tall and narrow. */}
                  <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-brand-sand md:aspect-auto md:h-64 lg:h-[17rem]">
                    {/* The workshop's own photographs, cross-fading inside this
                        frame — unchanged by this layout pass. */}
                    <WorkshopCardSlideshow
                      images={workshopGalleryImages(ws)}
                      alt={title}
                      cardIndex={cardIndex}
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                    />

                    {/* Weighted to the foot of the frame, so the photograph
                        stays clear where it is not carrying text. */}
                    <div className="absolute inset-0 bg-gradient-to-t from-brand-charcoal/75 via-brand-charcoal/10 to-transparent" />

                    {/* Availability pill — silent unless every upcoming date
                        is full, since exposing live seat counts here just
                        confuses a workshop that runs on multiple dates. */}
                    {isFull && (
                      <div className="absolute top-4 start-4 z-10">
                        <span className="inline-flex items-center rounded-lg bg-brand-charcoal/85 text-brand-cream px-2.5 py-1 text-xs font-semibold tracking-wide shadow-card-sm">
                          {t('FULLY BOOKED', 'مكتمل الحجز')}
                        </span>
                      </div>
                    )}

                    {/* Category over the photograph where the package number
                        sits on those panels, then the name. The skill level
                        stays appended to the category, as it was on this card
                        before — it is existing content, not new metadata. */}
                    <div className="absolute inset-x-0 bottom-0 p-3 sm:p-7">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-cream/70">
                        {/* Same wording as the filter's "All Levels" option — the tag
                            and the filter describe the same thing and should read alike. */}
                        {categoryLabel(ws.category, dbCategories, lang)}{ws.skillLevel ? ` · ${ws.skillLevel === 'All Levels' ? t('Suitable for all levels', 'مناسب لجميع المستويات') : enumLabel('skillLevel', ws.skillLevel, lang)}` : ''}
                      </span>
                      <h3 className="mt-1.5 font-display text-[17px] font-semibold leading-tight text-brand-cream sm:text-[26px] line-clamp-2">
                        {title}
                      </h3>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-col p-3 sm:p-7">
                    {/* The description opens the white area — the title is over
                        the image now and is not repeated here. */}
                    {hook && (
                      <p className="max-md:hidden text-[15px] leading-[1.7] text-brand-ink line-clamp-2">{hook}</p>
                    )}

                    {/* The site's meta treatment: lucide at h-4 w-4 in sage,
                        1.5 gap. Same fields as before — nothing added. */}
                    <div className="mt-0 text-[13px] text-brand-ink space-y-2 sm:mt-4">
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 min-w-0">
                        {ws.duration && (
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <Clock className="h-4 w-4 shrink-0 text-brand-sage" />
                            <span className="truncate" dir="auto">{durationLabel(ws.duration, lang)}</span>
                          </span>
                        )}
                        {ws.ageRange && (
                          <span className="max-md:hidden inline-flex min-w-0 items-center gap-1.5">
                            <Sparkles className="h-4 w-4 shrink-0 text-brand-sage" />
                            <span className="truncate" dir="auto">{ageRangeLabel(ws.ageRange, lang)}</span>
                          </span>
                        )}
                      </div>
                      {ws.instructor && (
                        <p className="max-md:hidden inline-flex min-w-0 max-w-full items-center gap-1.5 text-brand-muted">
                          <Paintbrush className="h-4 w-4 shrink-0 text-brand-sage" />
                          <span className="truncate">{t('Instructor', 'المدرّب')} {ws.instructor}</span>
                        </p>
                      )}
                    </div>

                    {/* mt-auto anchors the price to the foot, so prices line up
                        across a row whatever length the descriptions run. No
                        CTA beside it: the whole card is the click target. */}
                    <div className="mt-auto border-t border-brand-clay pt-3 sm:pt-6">
                      <div className="flex items-baseline gap-1.5">
                        {/* brand-ink at every width — the colour the duration
                            above it inherits — so the price reads as part of
                            the meta block rather than announcing itself. The
                            size steps down with it: 20px on a phone, 29px from
                            sm, which is the same 0.909 ratio applied to the
                            32px this used to be. */}
                        <span className="font-display text-[20px] font-semibold leading-none text-brand-ink ltr-numerals sm:text-[29px]">
                          {ws.price}
                        </span>
                        <span className="text-sm font-medium text-brand-ink">{t('SAR', 'ريال')}</span>
                      </div>
                    </div>
                  </div>

                  {/* Visual full indicator banner overlay */}
                  {isFull && (
                    <div className="absolute inset-0 bg-brand-cream/10 flex items-center justify-center pointer-events-none">
                      <div className="bg-brand-charcoal text-brand-cream px-4 py-2 rounded-xl text-xs font-semibold tracking-widest uppercase shadow-card-sm rotate-12">
                        {t('Class Full', 'الفصل مكتمل')}
                      </div>
                    </div>
                  )}
                </div>
                </Reveal>
              );
            })}
          </div>
        )}

      </div>
    </div>
    </div>
    </div>
  );
};
