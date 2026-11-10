/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { categoryLabel } from '../utils/categoryLabel';
import { ImageSlider } from './ui/ImageSlider';
import Reveal from './ui/Reveal';
import { ScrollReveal } from './ui/ScrollReveal';
import { getRiyadhNow, parseBookingDateTimeToRiyadhDate, getRiyadhDateString } from '../utils/dateUtils';
import { resolveStaffName } from '../utils/staffAssignments';
import { useSessionSeats } from '../lib/sessionSeats';
import { validateBookingForm } from '../utils/validation';
import { MONTH_NAMES, WEEKDAY_NAMES_SHORT } from '../utils/calendarConfig';
import { Edit, ChevronLeft, ChevronRight } from 'lucide-react';
import { BackButton } from './ui/BackButton';
import { localizedText } from '../utils/localizedText';
import { durationLabel, ageRangeLabel } from '../utils/workshopMetaLabel';
import { isBuiltInFieldCustomerVisible } from '../types';
import { ONLINE_PAYMENTS_SETTING_ID, normalizeOnlinePayments, bookingPaymentNote } from '../utils/onlinePayments';
import { ONLINE_PAYMENTS_AVAILABLE } from '../utils/featureFlags';
import { InfoPageNewTabLink } from './ui/InfoPage';

export const WorkshopDetailSection: React.FC = () => {
  const { 
    workshops, selectedWorkshopId, setCustomerTab, setPendingBooking, currentUser, todayDateStr, staff, queue,
    workshopFields, categories, appSettings,
    // Shared records, narrowed to this workshop below.
    workshopSessions
  } = useApp();
  const { lang, t } = useLanguage();

  const workshop = useMemo(() => {
    return workshops.find(ws => ws.id === selectedWorkshopId) || workshops[0];
  }, [workshops, selectedWorkshopId]);

  /**
   * Every image this workshop has, for the slider: the cover first, then the
   * rest as staff ordered them in the console. A workshop saved before multiple
   * photos existed has an empty `additionalImages`, so it simply yields a list
   * of one and the slider renders a still image with no dots.
   */
  const galleryImages = useMemo(
    () =>
      [workshop?.image, ...(workshop?.additionalImages || [])].filter(
        (src): src is string => typeof src === 'string' && src.trim() !== ''
      ),
    [workshop]
  );

  // This workshop's sessions, taken from the shared data layer. Seat counts
  // come from the database — see `seats` below.
  const dbSessions = useMemo(
    () => workshopSessions.filter(s => s.workshopId === (workshop?.id || '')),
    [workshopSessions, workshop?.id]
  );


  /**
   * Seats for every published session of this workshop, counted by the database.
   *
   * This page used to sum the `bookings` array from context. That array is
   * RLS-scoped — a signed-out visitor has none of it and a signed-in customer
   * has only their own rows — so every session read as completely empty.
   */
  const seatSessionIds = useMemo(
    () => dbSessions.filter(s => s.status === 'Published').map(s => String(s.id)),
    [dbSessions]
  );
  const seats = useSessionSeats(seatSessionIds);

  // Identify dates with available published sessions
  const datesWithPublishedSessions = useMemo(() => {
    const setOfDates = new Set<string>();
    const riyadhNow = getRiyadhNow();
    const todayStr = getRiyadhDateString();

    for (const sess of dbSessions) {
      if (sess.status !== 'Published') continue;
      if (sess.date < todayStr) continue;

      // Only a session KNOWN to be full is hidden. While its count is still in
      // flight the date stays offered: the session list behind it reports its
      // own state, so a date is never wrongly removed on the strength of a
      // number that has not arrived.
      const sessSeats = seats.get(sess.id);
      if (sessSeats && sessSeats.seatsRemaining <= 0) continue;

      const sessDateObj = parseBookingDateTimeToRiyadhDate(sess.date, sess.startTime);
      const isPastCutoff = sess.date === todayStr && sessDateObj.getTime() < riyadhNow.getTime() + 30 * 60 * 1000;
      if (!isPastCutoff) {
        setOfDates.add(sess.date);
      }
    }
    return setOfDates;
  }, [dbSessions, seats]);

  // Dynamic Date Strip Generation (Starting from TODAY i = 0 for same-day booking)
  const dateStrip = useMemo(() => {
    const dates = [];
    const days = WEEKDAY_NAMES_SHORT;
    const todayRiyadhStr = getRiyadhDateString();
    const [y, m, d] = (todayRiyadhStr || '2026-07-23').split('-').map(Number);
    const baseDate = new Date(y, m - 1, d);
    
    for (let i = 0; i < 7; i++) {
      const cur = new Date(baseDate);
      cur.setDate(baseDate.getDate() + i);
      const isoStr = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
      dates.push({
        dayName: days[cur.getDay()],
        dayNum: cur.getDate(),
        fullDate: isoStr,
        isToday: i === 0,
        hasSlots: datesWithPublishedSessions.has(isoStr)
      });
    }
    return dates;
  }, [datesWithPublishedSessions]);

  const [selectedDate, setSelectedDate] = useState<string>(() => getRiyadhDateString());

  // Month navigation calendar state
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const todayRiyadhStr = getRiyadhDateString();
    const [y, m] = (todayRiyadhStr || '2026-07-23').split('-').map(Number);
    return new Date(y, m - 1, 1);
  });

  // Month Calendar Grid logic
  const calendarGrid = useMemo(() => {
    const todayRiyadhStr = getRiyadhDateString();
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth(); // 0-indexed
    const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const items = [];
    for (let p = 0; p < firstDayOfWeek; p++) {
      items.push(null);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isPast = dateStr < todayRiyadhStr;
      const isToday = dateStr === todayRiyadhStr;
      const hasAvailableSessions = datesWithPublishedSessions.has(dateStr);
      items.push({
        dayNum: d,
        dateStr,
        isPast,
        isToday,
        hasAvailableSessions
      });
    }
    return items;
  }, [calendarMonth, datesWithPublishedSessions]);

  const currentMonthStart = useMemo(() => {
    const todayRiyadhStr = getRiyadhDateString();
    const [y, m] = (todayRiyadhStr || '2026-07-23').split('-').map(Number);
    return new Date(y, m - 1, 1);
  }, []);

  const isPrevMonthDisabled = calendarMonth.getTime() <= currentMonthStart.getTime();

  const handlePrevMonth = () => {
    if (isPrevMonthDisabled) return;
    setCalendarMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCalendarMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  };

  // English Gregorian month names from the shared calendar configuration.
  const monthNames = MONTH_NAMES;

  // Time Slots for selected date calculated from Dexie
  const slots = useMemo(() => {
    if (!selectedDate || !workshop) return [];
    
    const matchingSessions = dbSessions.filter(
      s => s.date === selectedDate && s.status === 'Published'
    );

    const riyadhNow = getRiyadhNow();
    const todayStr = getRiyadhDateString();

    return matchingSessions.map(sess => {
      // undefined until the real figure arrives. Never defaulted: 0 would show
      // a bookable session as full, and capacity would invite a customer into
      // checkout for a seat that does not exist.
      const sessSeats = seats.get(sess.id);

      const sessDateObj = parseBookingDateTimeToRiyadhDate(selectedDate, sess.startTime);
      const isPastCutoff = selectedDate < todayStr || (selectedDate === todayStr && sessDateObj.getTime() < riyadhNow.getTime() + 30 * 60 * 1000);

      return {
        id: sess.id,
        time: sess.startTime,
        spots: sessSeats?.seatsRemaining,
        capacity: sess.capacity,
        seatsKnown: sessSeats !== undefined,
        isFull: sessSeats !== undefined && sessSeats.seatsRemaining <= 0,
        isPastCutoff,
        // Resolve the tutor from the assignment's staff ID so renames show through.
        instructor: resolveStaffName(staff, sess.staffId || workshop.staffId, sess.instructor || workshop.instructor)
      };
    });
  }, [dbSessions, selectedDate, workshop, staff, seats]);

  const workshopTutorName = resolveStaffName(staff, workshop?.staffId, workshop?.instructor);

  /**
   * Admin-created fields the Staff Console marked visible to customers. Core
   * fields already have their own places on this page, and internal fields stay
   * hidden unless explicitly configured.
   */
  const customerVisibleFields = useMemo(
    () => workshopFields.filter(f => f.enabled && f.customerVisible && !f.system),
    [workshopFields]
  );

  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // Id of the chosen workshop session — travels with the booking so the tutor
  // can always be resolved from the real session record.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<number>(1);
  // Capacity/session message from the shared validation layer.
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Participant edit info sync
  const [isEditingInfo, setIsEditingInfo] = useState(false);
  const [custName, setCustName] = useState(currentUser?.name || '');
  const [custPhone, setCustPhone] = useState(currentUser?.phone || '');
  const [custEmail, setCustEmail] = useState(currentUser?.email || '');

  // Keep local state in sync if currentUser changes
  useEffect(() => {
    if (currentUser) {
      setCustName(currentUser.name);
      setCustPhone(currentUser.phone);
      setCustEmail(currentUser.email);
    } else {
      setCustName('');
      setCustPhone('');
      setCustEmail('');
    }
  }, [currentUser]);

  const totalPrice = useMemo(() => {
    if (!workshop) return 0;
    if (workshop.pricingType === 'Per pair') {
      return workshop.price * Math.ceil(participants / 2);
    }
    if (workshop.pricingType === 'Fixed price') {
      return workshop.price;
    }
    return workshop.price * participants;
  }, [workshop, participants]);

  const priceSubtitle = useMemo(() => {
    if (!workshop) return '';
    if (workshop.pricingType === 'Per pair') return `${workshop.price} ${t('SAR / Pair', 'ريال / للزوج')}`;
    if (workshop.pricingType === 'Fixed price') return `${workshop.price} ${t('SAR (Fixed Price)', 'ريال (سعر ثابت)')}`;
    return `${workshop.price} ${t('SAR / Person', 'ريال / للشخص')}`;
  }, [workshop, t]);

  // Live remaining seats for the chosen session, not an arbitrary cap. Falls
  // back to the session's total capacity while the live count is still
  // loading, and to 1 if neither is known yet.
  const selectedSlotData = useMemo(
    () => slots.find(s => (selectedSessionId ? s.id === selectedSessionId : s.time === selectedSlot)),
    [slots, selectedSessionId, selectedSlot]
  );
  const maxParticipants = selectedSlotData?.spots ?? selectedSlotData?.capacity ?? 1;

  // Pull participants back down if a session switch lowers the live max
  // below what was already selected.
  useEffect(() => {
    setParticipants(prev => Math.max(1, Math.min(prev, maxParticipants)));
  }, [maxParticipants]);

  const handleBook = async () => {
    if (!selectedSlot) return;

    // Re-read capacity from the database rather than trusting the number the
    // page loaded with, and confirm the session is still bookable.
    const bookingErrors = await validateBookingForm({
      sessionId: selectedSessionId,
      participants
    }, undefined, undefined, lang);
    if (Object.keys(bookingErrors).length > 0) {
      setBookingError(bookingErrors.sessionId || bookingErrors.participants || null);
      return;
    }
    setBookingError(null);

    setPendingBooking({
      workshopId: workshop.id,
      sessionId: selectedSessionId || undefined,
      workshopTitle: workshop.title,
      date: selectedDate,
      time: selectedSlot,
      participants: participants,
      totalPrice: totalPrice,
      customerName: currentUser ? currentUser.name : '',
      customerEmail: currentUser ? currentUser.email : '',
      customerPhone: currentUser ? currentUser.phone : '',
    });

    if (!currentUser) {
      setCustomerTab('checkout-info');
    } else {
      setCustomerTab('checkout-info');
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8 pb-8 animate-in fade-in duration-300 text-start">
      
      {/* Back button */}
      <BackButton onClick={() => setCustomerTab('workshops')} className="mb-6">
        {t('Back to Workshops', 'العودة إلى الورش')}
      </BackButton>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pb-16">
        
        {/* LEFT COLUMN: Gallery & Info */}
        <div className="lg:col-span-7 space-y-8">
          
          {/* Photos — same position and size as the single image it replaces. */}
          <ImageSlider
            images={galleryImages}
            alt={localizedText(workshop.title, workshop.titleAr, lang)}
            className="aspect-[16/9] w-full rounded-[32px]"
          />

          {/* Title & Metadata */}
          <div className="space-y-4">
            <Reveal index={0}>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center rounded-lg bg-brand-terracotta/10 px-2.5 py-1 text-xs font-semibold text-brand-terracotta">
                  {categoryLabel(workshop.category, categories, lang)}
                </span>
              </div>
            </Reveal>

            <Reveal index={1}>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold text-brand-charcoal">
                {localizedText(workshop.title, workshop.titleAr, lang)}
              </h1>
            </Reveal>

            <Reveal index={2}>
              <p className="text-lg font-medium text-brand-terracotta">
                "{localizedText(workshop.hook, workshop.hookAr, lang)}"
              </p>
            </Reveal>
          </div>

          {/* Fact grid — boxed cells, label over value, no icons. */}
          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.3, margin: '0px 0px -80px 0px' }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
          {/* Below sm the cross rules are drawn by a 1px grid gap over a clay
              background, not by per-cell borders: the cell count is 4 plus
              however many custom fields the client has enabled, so no cell can
              know whether it ends a row. From sm up the gap closes and the
              original per-cell borders take over unchanged. */}
          <div className="grid grid-cols-2 gap-px bg-brand-clay sm:grid-cols-2 sm:gap-0 sm:bg-brand-cream lg:grid-cols-4 rounded-[22px] border border-brand-clay overflow-hidden">
            {[
              // Built-in fields follow their "Visible to Customers" toggle in
              // Settings -> Workshop Detail Lists, like the custom ones below.
              ...([
                { boundTo: 'duration', label: t('Duration', 'المدة'), value: durationLabel(workshop.duration, lang) },
                { boundTo: 'ageRange', label: t('Ages', 'الأعمار'), value: ageRangeLabel(workshop.ageRange, lang) },
                { boundTo: 'staffId', label: t('Tutor', 'المدرّب'), value: workshopTutorName },
                { boundTo: 'roomId', label: t('Location', 'الموقع'), value: workshop.room.split('(')[0] }
              ]
                .filter(cell => isBuiltInFieldCustomerVisible(workshopFields, cell.boundTo))
                .map(({ label, value }) => ({ label, value }))),
              ...customerVisibleFields.map(field => {
                const raw = workshop?.customFields?.[field.fieldKey];
                const text = Array.isArray(raw) ? raw.join(', ') : raw;
                if (text === undefined || text === null || String(text).trim() === '') return null;
                return {
                  label: field.label,
                  value: typeof text === 'boolean' ? (text ? t('Yes', 'نعم') : t('No', 'لا')) : String(text)
                };
              }).filter(Boolean) as { label: string; value: string }[]
            ].map(cell => (
              <div
                key={cell.label}
                className="bg-brand-cream p-3.5 sm:border-b sm:border-e sm:p-5 border-brand-clay last:border-e-0 text-start"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">
                  {cell.label}
                </p>
                <p className="mt-1.5 font-display text-base font-semibold text-brand-charcoal break-words">
                  {cell.value}
                </p>
              </div>
            ))}
          </div>
          </ScrollReveal>

          {/* Description details */}
          <div className="space-y-4">
            <Reveal index={0}>
              <h3 className="font-display text-2xl font-semibold text-brand-charcoal">{t('What you’ll do', 'ماذا ستفعل')}</h3>
            </Reveal>
            <Reveal index={1}>
              <p className="text-brand-ink leading-[1.75] text-[15px]">
                {localizedText(workshop.description, workshop.descriptionAr, lang)}
              </p>
            </Reveal>
            <Reveal index={2}>
              <p className="text-brand-ink leading-[1.75] text-[15px]">
                {localizedText(workshop.fullDetails, workshop.fullDetailsAr, lang)}
              </p>
            </Reveal>
          </div>

          {/* Materials Bullet Points List */}
          <div className="space-y-4 pt-6 border-t border-brand-clay">
            <Reveal index={0}>
              <h3 className="font-display text-2xl font-semibold text-brand-charcoal">{t('Included', 'يشمل')}</h3>
            </Reveal>
            <ScrollReveal
              once
            viewOptions={{ once: true, amount: 0.3, margin: '0px 0px -80px 0px' }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
              transition={{ delay: 0.12, duration: 0.5, ease: 'easeOut' }}
            >
            <div className="flex flex-wrap gap-2.5">
              {(lang === 'ar' && workshop.materialsAr && workshop.materialsAr.length > 0 ? workshop.materialsAr : workshop.materials).map((mat, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center rounded-full border border-brand-clay bg-brand-cream px-4 py-2 text-[13px] text-brand-charcoal"
                >
                  {mat}
                </span>
              ))}
            </div>
            </ScrollReveal>
          </div>

        </div>

        {/* RIGHT COLUMN: Sticky Booking Panel */}
        <div className="lg:col-span-5">
          <div className="lg:sticky lg:top-24 bg-brand-cream rounded-[28px] p-6 sm:p-8 shadow-card shadow-brand-charcoal/5 border border-brand-terracotta/5 flex flex-col gap-6">
            
            <div>
              <Reveal index={0}>
                <span className="text-[10px] font-semibold text-brand-sage uppercase tracking-widest block">{t('SECURE BOOKING', 'حجز آمن')}</span>
              </Reveal>
              <Reveal index={1}>
                <h2 className="font-display text-2xl font-semibold text-brand-charcoal">{t('Reserve your workspace', 'احجز مساحتك')}</h2>
              </Reveal>
            </div>

            {/* 1. Date Selection (Month Calendar) */}
            <div className="space-y-3">
              <label className="text-xs font-semibold uppercase tracking-widest text-brand-charcoal/40 block">
                {t('1. Select a Date', '1. اختر تاريخًا')}
              </label>

              {/* Full Month Calendar with Forward Navigation */}
              {/* The shadow is on the month grid alone, not the panel around it. */}
              <div className="bg-brand-sand/20 rounded-2xl p-4 border border-brand-clay shadow-card space-y-3 animate-in fade-in duration-200">
                
                {/* Calendar Month Header */}
                <div className="flex items-center justify-between pb-2 border-b border-brand-clay">
                  <button
                    type="button"
                    disabled={isPrevMonthDisabled}
                    onClick={handlePrevMonth}
                    className="h-11 w-11 flex items-center justify-center rounded-xl hover:bg-brand-sand border border-brand-clay disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer text-brand-charcoal"
                    title={t('Previous Month', 'الشهر السابق')}
                  >
                    <ChevronLeft className="h-4 w-4 flip-rtl" />
                  </button>
                  <span className="font-display font-semibold text-sm text-brand-charcoal">
                    {monthNames[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}
                  </span>
                  <button
                    type="button"
                    onClick={handleNextMonth}
                    className="h-11 w-11 flex items-center justify-center rounded-xl hover:bg-brand-sand border border-brand-clay cursor-pointer text-brand-charcoal"
                    title={t('Next Month', 'الشهر التالي')}
                  >
                    <ChevronRight className="h-4 w-4 flip-rtl" />
                  </button>
                </div>

                {/* Day of week headers */}
                <div className="grid grid-cols-7 text-center text-[10px] font-semibold text-brand-muted uppercase">
                  {/* ⚠ ARABIC DAY ABBREVIATIONS — best-effort single letters, needs a native speaker's review. */}
                  <span>{t('Su', 'ح')}</span>
                  <span>{t('Mo', 'ن')}</span>
                  <span>{t('Tu', 'ث')}</span>
                  <span>{t('We', 'ر')}</span>
                  <span>{t('Th', 'خ')}</span>
                  <span>{t('Fr', 'ج')}</span>
                  <span>{t('Sa', 'س')}</span>
                </div>

                {/* Grid of Days */}
                <div className="grid grid-cols-7 gap-1">
                  {calendarGrid.map((item, idx) => {
                    if (!item) {
                      return <div key={`empty-${idx}`} className="h-11"></div>;
                    }

                    const isSelected = selectedDate === item.dateStr;

                    if (item.isPast) {
                      return (
                        <div
                          key={item.dateStr}
                          className="h-11 flex items-center justify-center text-xs text-brand-charcoal/20 rounded-xl cursor-not-allowed select-none"
                        >
                          {item.dayNum}
                        </div>
                      );
                    }

                    return (
                      <button
                        key={item.dateStr}
                        type="button"
                        onClick={() => {
                          setSelectedDate(item.dateStr);
                          setSelectedSlot(null);
                        }}
                        // h-11 is the 44px touch minimum. The WIDTH cannot reach
                        // it — seven columns in this card leave ~34px at 375px —
                        // so the height is taken as far as it goes.
                        className={`h-11 rounded-xl text-xs font-semibold flex flex-col items-center justify-center transition-all cursor-pointer relative ${
                          isSelected
                            ? 'bg-brand-terracotta text-brand-cream shadow-card-sm font-black'
                            : item.isToday
                            ? 'border-2 border-brand-terracotta text-brand-terracotta hover:bg-brand-terracotta/10'
                            : item.hasAvailableSessions
                            ? 'text-brand-charcoal bg-brand-sand/40 border border-brand-clay hover:bg-brand-sand'
                            : 'text-brand-charcoal/40 hover:bg-brand-sand border border-transparent'
                        }`}
                      >
                        <span>{item.dayNum}</span>
                        {item.hasAvailableSessions && !isSelected && (
                          <span className="w-1 h-1 rounded-full bg-brand-terracotta shrink-0"></span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <p className="text-[10px] text-center text-brand-muted pt-1">
                  {t('Selected', 'المحدد')}: <strong className="text-brand-terracotta">{selectedDate}</strong>
                </p>
              </div>
            </div>

            {/* 2. Grid of Time-Slot Buttons */}
            <div className="space-y-3">
              <label className="text-xs font-semibold uppercase tracking-widest text-brand-charcoal/40 block">{t('2. Pick a Time', '2. اختر وقتًا')}</label>
              {slots.length === 0 ? (
                <div className="p-4 rounded-2xl bg-brand-sand/30 border border-brand-clay text-center text-xs font-medium text-brand-muted">
                  {t(
                    'No active published sessions scheduled for this date. Please select another date.',
                    'لا توجد جلسات منشورة متاحة لهذا التاريخ. يرجى اختيار تاريخ آخر.'
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {slots.map((s) => {
                    const isSelected = selectedSlot === s.time;

                    if (s.isPastCutoff) {
                      return (
                        <button
                          key={s.id || s.time}
                          disabled
                          className="px-4 py-3 rounded-[22px] border border-brand-clay/20 text-brand-charcoal/30 font-semibold text-sm flex justify-between items-center cursor-not-allowed bg-brand-sand/10"
                        >
                          <span>{s.time}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/60 bg-amber-50 px-2 py-0.5 rounded">{t('PASSED / CLOSED', 'انتهى / مغلق')}</span>
                        </button>
                      );
                    }

                    // Count not in yet. The slot is shown but not selectable:
                    // offering it with no number is honest, offering it with a
                    // guessed one is not.
                    if (!s.seatsKnown) {
                      return (
                        <button
                          key={s.id || s.time}
                          disabled
                          className="px-4 py-3 rounded-[22px] border border-brand-clay/20 text-brand-charcoal/40 font-semibold text-sm flex justify-between items-center cursor-wait"
                        >
                          <span>{s.time}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-muted bg-brand-clay/10 px-2 py-0.5 rounded">{t('CHECKING…', 'جارٍ التحقق…')}</span>
                        </button>
                      );
                    }

                    if (s.isFull) {
                      return (
                        <button
                          key={s.id || s.time}
                          disabled
                          className="px-4 py-3 rounded-[22px] border border-brand-clay/20 text-brand-charcoal/40 font-semibold text-sm flex justify-between items-center cursor-not-allowed bg-red-50/30"
                        >
                          <span>{s.time}</span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-red-600 bg-red-100 px-2 py-0.5 rounded">{t('FULLY BOOKED', 'مكتمل الحجز')}</span>
                        </button>
                      );
                    }
                    
                    return (
                      <button
                        key={s.id || s.time}
                        onClick={() => {
                          setSelectedSlot(s.time);
                          setSelectedSessionId(s.id ? String(s.id) : null);
                        }}
                        className={`px-5 py-3 rounded-full border transition-all cursor-pointer text-sm font-semibold flex justify-between items-center ${
                          isSelected 
                            ? 'border-2 border-brand-terracotta bg-brand-terracotta/5 text-brand-terracotta shadow-card-sm' 
                            : 'border border-brand-clay text-brand-charcoal hover:border-brand-terracotta/50'
                        }`}
                      >
                        <div className="text-start">
                          <span className="block font-semibold">{s.time}</span>
                          {s.instructor && <span className="text-[10px] text-brand-muted block font-normal">{t('Tutor', 'المدرّب')}: {s.instructor}</span>}
                        </div>
                        {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                        <span className="text-[10px] font-semibold bg-brand-sage/10 text-brand-sage px-2 py-1 rounded-lg">{s.spots} {s.spots === 1 ? t('open seat', 'مقعد متاح') : t('open seats', 'مقاعد متاحة')}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Customer Details info block (Rendered ONLY when logged in) */}
            {currentUser ? (
              <div className="p-4 bg-brand-sand/30 rounded-[22px] border border-brand-clay text-xs text-brand-ink space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold uppercase tracking-wider text-[10px] text-brand-sage">{t('Booking Participant', 'مشارك الحجز')}</span>
                  <button 
                    onClick={() => setIsEditingInfo(!isEditingInfo)}
                    // The tap area is expanded by a transparent pseudo-element
                    // rather than by growing the button: it sits opposite a
                    // label in a justify-between row, and a visually larger
                    // control would unbalance it. 13px of text + 16px each side.
                    className="relative text-[10px] text-brand-terracotta font-semibold flex items-center gap-1 hover:underline cursor-pointer before:absolute before:-inset-4 before:content-['']"
                  >
                    <Edit className="h-3 w-3" />
                    <span>{isEditingInfo ? t('Save', 'حفظ') : t('Edit', 'تعديل')}</span>
                  </button>
                </div>

                {isEditingInfo ? (
                  <div className="space-y-1.5 pt-1">
                    <input 
                      type="text" 
                      value={custName} 
                      onChange={e => setCustName(e.target.value)} 
                      placeholder={t('Name', 'الاسم')}
                      className="w-full bg-brand-cream border border-brand-clay p-2 rounded-xl font-semibold text-xs text-brand-charcoal"
                    />
                    <input
                      type="text"
                      value={custPhone}
                      onChange={e => setCustPhone(e.target.value)}
                      placeholder={t('Phone', 'الجوال')}
                      className="w-full bg-brand-cream border border-brand-clay p-2 rounded-xl font-semibold text-xs text-brand-charcoal"
                    />
                  </div>
                ) : (
                  <p className="font-semibold text-brand-charcoal">
                    {currentUser.name} ({currentUser.phone})
                  </p>
                )}
              </div>
            ) : null}

            {/* 3. Participant stepper */}
            <div className="flex items-center justify-between py-1">
              <label className="text-xs font-semibold uppercase tracking-widest text-brand-charcoal/40">{t('3. Participants', '3. المشاركون')}</label>
              <div className="flex items-center gap-4 bg-brand-sand/40 rounded-full px-4 py-2 border border-brand-clay/20">
                <button
                  disabled={participants <= 1}
                  onClick={() => setParticipants(prev => Math.max(1, prev - 1))}
                  className="w-9 h-9 flex items-center justify-center text-brand-charcoal/40 hover:text-brand-charcoal disabled:opacity-30 cursor-pointer text-lg font-semibold"
                >
                  −
                </button>
                <span className="font-semibold text-base w-4 text-center text-brand-charcoal">{participants}</span>
                <button
                  disabled={participants >= maxParticipants}
                  onClick={() => setParticipants(prev => Math.min(maxParticipants, prev + 1))}
                  className="w-9 h-9 flex items-center justify-center text-brand-terracotta hover:text-brand-terracotta-hover disabled:opacity-30 cursor-pointer text-lg font-semibold"
                >
                  +
                </button>
              </div>
            </div>

            {/* 4. Live price summary */}
            <div className="pt-6 border-t border-brand-clay/35 space-y-3 text-sm text-brand-charcoal/95">
              <div className="flex justify-between items-end">
                <div>
                  <p className="text-xs text-brand-charcoal/40">{t('Total Amount', 'المبلغ الإجمالي')}</p>
                  <p className="text-2xl font-serif font-semibold text-brand-terracotta">
                    {totalPrice} <span className="text-sm font-sans font-normal">{t('SAR', 'ريال')}</span>
                  </p>
                </div>
                <p className="text-[10px] text-brand-charcoal/40 italic font-medium">{priceSubtitle}</p>
              </div>
            </div>

            {bookingError && (
              <p className="text-xs text-red-500 font-semibold text-center">{bookingError}</p>
            )}

            {/* 5. Book button */}
            <button
              disabled={!selectedSlot}
              onClick={handleBook}
              className={`w-full py-4 text-white rounded-full font-semibold text-lg shadow-card transition-all duration-150 cursor-pointer ${
                selectedSlot 
                  ? 'bg-brand-terracotta shadow-brand-terracotta/20 hover:scale-[1.02] active:scale-[0.98]' 
                  : 'bg-brand-sand text-brand-charcoal/40 border border-brand-clay cursor-not-allowed shadow-none'
              }`}
            >
              {selectedSlot ? t('Confirm Booking', 'تأكيد الحجز') : t('Select a Time Slot', 'اختر وقتًا')}
            </button>

            {/* The real policy, from the same Online Payments setting the
                database enforces (bookingPaymentNote), then a link to the full
                Cancellation & Refund Policy. The link opens in a new tab so the
                chosen time slot and form here are not lost. */}
            {(() => {
              const note = bookingPaymentNote({
                available: ONLINE_PAYMENTS_AVAILABLE,
                config: normalizeOnlinePayments(appSettings.find(s => s.id === ONLINE_PAYMENTS_SETTING_ID)?.value),
                kind: 'workshop',
                total: totalPrice
              });
              return (
                <p className="text-[10px] text-center text-brand-charcoal/40 italic">
                  {t(note.en, note.ar)}{' '}
                  <InfoPageNewTabLink
                    page="cancellation-policy"
                    className="not-italic font-semibold text-brand-terracotta underline underline-offset-2 hover:text-brand-terracotta-hover"
                  >
                    {t('Cancellation policy', 'سياسة الإلغاء')}
                  </InfoPageNewTabLink>
                </p>
              );
            })()}

          </div>
        </div>
      </div>

    </div>
  );
};
