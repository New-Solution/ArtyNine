/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { useApp, getRiyadhNow, parseBookingDateTimeToRiyadhDate } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { Calendar, Users, Clock, GraduationCap, AlertCircle, Trash2, CalendarX, Compass, HelpCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Booking } from '../types';
import { resolveBookingInstructor } from '../utils/queueUtils';
import { normalizeCustomerPhone } from '../utils/customerIdentity';
import { STUDIO_PHONE } from '../utils/studioConfig';
import Reveal from './ui/Reveal';
import { ScrollReveal } from './ui/ScrollReveal';
import { AppImage } from './ui/AppImage';
import { durationLabel } from '../utils/workshopMetaLabel';
import { bookingTitleLabel } from '../utils/bookingTitleLabel';
import { timeLabel } from '../utils/availabilityLabel';
import { customerAmountView, isPaidStatus, paymentBreakdown, sarAmount } from '../utils/onlinePayments';

/**
 * Hours of notice that make a cancellation refundable.
 *
 * Mirrors `cancel_own_booking`'s `hours_notice > 24` in migration 0017, which
 * is the authority — this is only what the page shows. Both must agree, or the
 * page promises a refund the backend then refuses.
 */
const REFUND_NOTICE_HOURS = 24;

/**
 * A booking's real start, in Riyadh wall-clock.
 *
 * Both the Upcoming/Past split and the cancellation window used to build this
 * from a hardcoded hour — 11am for the exact string '11:00', 4pm for anything
 * else in one place, and the inverse of that in the other. Neither read
 * `booking.time`, so a 9pm session was treated as 4pm.
 *
 * `parseBookingDateTimeToRiyadhDate` is the same helper cancelBooking() uses,
 * and handles '09:00 PM', '16:00' and the ' - ' range form.
 */
const bookingStart = (booking: Booking): Date => {
  try {
    const start = parseBookingDateTimeToRiyadhDate(
      booking.date,
      String(booking.time || '').split(' - ')[0].trim()
    );
    if (!Number.isNaN(start.getTime())) return start;
  } catch {
    /* fall through to the safe default below */
  }
  // An unparseable time falls back to the end of that day rather than to an
  // invented hour: a booking is then never hidden from Upcoming, and never has
  // its cancellation refused, on the strength of a time nobody could read.
  return new Date(`${booking.date}T23:59:59`);
};

/** Hours between now and the booking's start. Negative once it has begun. */
const hoursUntilStart = (booking: Booking, now: Date): number =>
  (bookingStart(booking).getTime() - now.getTime()) / (1000 * 60 * 60);

export const MyBookingsSection: React.FC = () => {
  const { bookings, cancelOwnBooking, setCustomerTab, workshops, birthdayPackages, currentUser, setAuthScreen, staff, workshopSessions } = useApp();
  const { lang, t } = useLanguage();
  /** The booking currently being cancelled, so its button can be disabled. */
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'Upcoming' | 'Past' | 'Cancelled'>('Upcoming');
  const [hoveredTooltipId, setHoveredTooltipId] = useState<string | null>(null);

  // Divide bookings into Upcoming, Past and Cancelled for current authenticated user
  const categorizedBookings = useMemo(() => {
    const today = getRiyadhNow();

    const upcomingList: Booking[] = [];
    const pastList: Booking[] = [];
    const cancelledList: Booking[] = [];

    if (!currentUser) {
      return { Upcoming: [], Past: [], Cancelled: [] };
    }

    // The customer id is the reliable link — it is what the row-level policy
    // matches on. Email and phone stay as a fallback for older rows saved
    // before the link existed.
    const userBookings = (bookings || []).filter(b =>
      (currentUser.id && b.customerId === currentUser.id) ||
      (currentUser.email && b.customerEmail?.toLowerCase() === currentUser.email.toLowerCase()) ||
      (currentUser.phone &&
        normalizeCustomerPhone(b.customerPhone) === normalizeCustomerPhone(currentUser.phone))
    );

    userBookings.forEach(b => {
      // The booking's real start. This used to hardcode 11am for the exact
      // string '11:00' and 4pm for everything else, so a 9pm session counted
      // as past from 4pm — five hours before it began.
      const bDate = bookingStart(b);
      const isCancelled = b.status === 'Cancelled';

      // A cancelled booking gets its own tab regardless of date, rather than
      // being folded into Upcoming or Past.
      if (isCancelled) {
        cancelledList.push(b);
      } else if (bDate >= today) {
        upcomingList.push(b);
      } else {
        pastList.push(b);
      }
    });

    return { Upcoming: upcomingList, Past: pastList, Cancelled: cancelledList };
  }, [bookings, currentUser]);

  const activeList = categorizedBookings[activeTab];

  /**
   * Display-only paging over the list already in memory. Nothing is re-queried
   * and nothing is filtered out — `activeList` is untouched, and the counts on
   * the tabs still report the whole tab.
   */
  const PAGE_SIZE = 5;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));

  // Switching tabs resets to the first page; without this, moving from a tab on
  // page 3 to one holding a single booking lands on an empty page. Derived
  // rather than stored, so it cannot fall out of step with the list: a booking
  // cancelled from the last page shortens the list under the reader, and this
  // clamps instead of leaving them on a page that no longer exists.
  const currentPage = Math.min(page, pageCount);
  const pagedList = activeList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Whether the free-cancellation window has closed: the session is still to
  // come, but with 24 hours' notice or less. Measured from the booking's real
  // start, so this agrees with what cancel_own_booking decides server-side.
  const isCancellationClosed = (booking: Booking): boolean => {
    const hours = hoursUntilStart(booking, getRiyadhNow());
    return hours < REFUND_NOTICE_HOURS && hours > 0;
  };

  /**
   * Whether cancelling right now would be refunded, by the same rule as
   * cancel_own_booking (0048): nothing paid (an unpaid hold, an Unpaid
   * booking) has nothing to refund, an online deposit is never refunded,
   * anything else that was paid keeps the 24h rule (the studio refunds it).
   */
  const isRefundable = (booking: Booking): boolean => {
    if (!isPaidStatus(booking.paymentStatus)) return false;
    if (booking.paymentMode === 'deposit') return false;
    return hoursUntilStart(booking, getRiyadhNow()) > REFUND_NOTICE_HOURS;
  };

  /** What this customer actually paid: the online amount for a booking
   *  really paid online (shared rule, paymentBreakdown), else the booking
   *  total as before. */
  const paidAmount = (booking: Booking): number => paymentBreakdown(booking).paid;

  const getStatusBadgeColor = (status: Booking['status']) => {
    switch (status) {
      case 'Pending':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Checked In':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'In Progress':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Completed':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      case 'Cancelled':
        return 'bg-red-100 text-red-800 border-red-200';
      default:
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    }
  };

  /** The booked workshop's duration, e.g. "2.5 Hours". Blank if unknown. */
  const getWorkshopDuration = (workshopId: string) => {
    const ws = workshops.find(w => w.id === workshopId);
    return ws?.duration || '';
  };

  /**
   * The booked workshop's photo, or nothing.
   *
   * A stock photograph used to stand in when the workshop could not be found.
   * That is worse than an empty frame: it shows the customer a picture of
   * something they did not book, and it hides a missing record from us.
   */
  const getWorkshopImage = (workshopId: string) => {
    const ws = workshops.find(w => w.id === workshopId);
    return ws?.image || '';
  };

  /** Display label for a tab — the underlying tab value never changes. */
  const tabLabel = (tab: 'Upcoming' | 'Past' | 'Cancelled') =>
    tab === 'Upcoming' ? t('Upcoming', 'القادمة')
    : tab === 'Past' ? t('Past', 'السابقة')
    : t('Cancelled', 'الملغاة');

  /**
   * Display label for a booking status. Translates only what is shown —
   * `b.status` itself and getStatusBadgeColor's switch are untouched.
   * Falls back to the raw English status for any value not among the five
   * enumerated here, so an unanticipated status still renders instead of
   * throwing or going blank.
   */
  const statusLabel = (status: Booking['status']) => {
    switch (status) {
      case 'Pending': return t('Pending', 'قيد الانتظار');
      case 'Checked In': return t('Checked In', 'تم تسجيل الحضور');
      case 'In Progress': return t('In Progress', 'جارٍ الآن');
      case 'Completed': return t('Completed', 'مكتمل');
      case 'Cancelled': return t('Cancelled', 'ملغى');
      default: return status;
    }
  };

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 animate-in fade-in duration-300 text-start">

        {/* Title */}
        <div className="pb-8 border-b border-brand-clay mb-8">
          <Reveal index={0}>
            <h1 className="font-display text-3xl font-semibold text-brand-charcoal">{t('My Reservations', 'حجوزاتي')}</h1>
          </Reveal>
          <Reveal index={1}>
            <p className="text-sm text-brand-ink mt-1">
              {t('Review, reschedule, or cancel your upcoming creative sessions at Arty Café.', 'راجع، أو أعد جدولة، أو ألغِ جلساتك الإبداعية القادمة في آرتي كافيه.')}
            </p>
          </Reveal>
        </div>

        <ScrollReveal
          once
          viewOptions={{ once: true, amount: 0.3, margin: '0px 0px -80px 0px' }}
          transition={{ delay: 0, duration: 0.5, ease: 'easeOut' }}
          variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
        >
        <div className="bg-white border border-brand-clay rounded-[28px] p-8 sm:p-12 shadow-card-sm max-w-md mx-auto space-y-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-terracotta/10 text-brand-terracotta mx-auto">
            <Calendar className="h-8 w-8" />
          </div>
          <h2 className="font-display text-xl font-semibold text-brand-charcoal">{t('Sign In to View Your Reservations', 'سجّل الدخول لعرض حجوزاتك')}</h2>
          <p className="text-xs text-brand-ink leading-relaxed">
            {t(
              'Please log in or register an account to manage your workshop bookings, view reservation details, or request cancellations.',
              'يرجى تسجيل الدخول أو إنشاء حساب لإدارة حجوزات الورش، ومشاهدة تفاصيل الحجز، أو طلب الإلغاء.'
            )}
          </p>
          <div className="pt-2">
            <button
              onClick={() => { setAuthScreen('login'); setCustomerTab('auth'); }}
              className="cursor-pointer bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream font-semibold py-3 px-6 rounded-2xl shadow-card-sm text-xs transition-colors"
            >
              {t('Sign In or Create Account', 'تسجيل الدخول أو إنشاء حساب')}
            </button>
          </div>
        </div>
        </ScrollReveal>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 animate-in fade-in duration-300 text-start">

      {/* Title */}
      <div className="pb-8 border-b border-brand-clay mb-8">
        <Reveal index={0}>
          <h1 className="font-display text-3xl font-semibold text-brand-charcoal">{t('My Reservations', 'حجوزاتي')}</h1>
        </Reveal>
        <Reveal index={1}>
          <p className="text-sm text-brand-ink mt-1">
            {t('Review, reschedule, or cancel your upcoming creative sessions at Arty Café.', 'راجع، أو أعد جدولة، أو ألغِ جلساتك الإبداعية القادمة في آرتي كافيه.')}
          </p>
        </Reveal>
      </div>

      {/* Tabs */}
      {/* Scrolls rather than wraps: three labels with count badges exceed the
          343px available at 375px, and without this the text wrapped inside the
          buttons and the active underline detached from its label. Same pattern
          as the category chips in WorkshopsBrowsingSection. */}
      <div className="flex min-w-0 overflow-x-auto no-scrollbar border-b border-brand-clay mb-8">
        {(['Upcoming', 'Past', 'Cancelled'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setPage(1); }}
            className={`px-6 py-3.5 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors relative cursor-pointer ${
              activeTab === tab
                ? 'border-brand-terracotta text-brand-terracotta'
                : 'border-transparent text-brand-muted hover:text-brand-terracotta'
            }`}
          >
            {/* The underline already says which one is selected; "Tab" was
                reading as part of the name. */}
            <span>{tabLabel(tab)}</span>
            {categorizedBookings[tab].length > 0 && (
              <span className="ms-2 inline-flex items-center rounded-full bg-brand-terracotta/10 px-2 py-0.5 text-xs font-semibold text-brand-terracotta">
                {categorizedBookings[tab].length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List content */}
      <div className="space-y-6">
        {activeList.length === 0 ? (
          /* PAST TAB EMPTY STATE or GENERAL EMPTY STATE */
          /* An empty state is the one thing that must never be the hidden
             thing: a blank page reads as broken rather than as empty. */
          <Reveal
            onMount
          >
          <div className="bg-white border border-brand-clay rounded-2xl p-8 sm:p-12 text-center max-w-md mx-auto shadow-card-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-terracotta/10 text-brand-terracotta mb-4">
              <CalendarX className="h-7 w-7" />
            </div>
            <h3 className="font-display text-lg font-semibold text-brand-charcoal">
              {activeTab === 'Past'
                ? t('No past bookings yet', 'لا توجد حجوزات سابقة بعد')
                : activeTab === 'Cancelled'
                ? t('No cancelled bookings', 'لا توجد حجوزات ملغاة')
                : t('No upcoming bookings', 'لا توجد حجوزات قادمة')}
            </h3>
            <p className="text-sm text-brand-ink mt-2 leading-relaxed">
              {activeTab === 'Past'
                ? t(
                    "You haven't completed any art classes with us yet. Let's make something beautiful!",
                    'لم تكمل أي ورشة فنية معنا بعد. لنصنع شيئًا جميلًا معًا!'
                  )
                : activeTab === 'Cancelled'
                ? t("You don't have any cancelled bookings.", 'ليس لديك أي حجوزات ملغاة.')
                : t(
                    "You don't have any sessions booked. Check our interactive timetable to join.",
                    'ليس لديك أي جلسات محجوزة. تصفح جدولنا التفاعلي للانضمام.'
                  )
              }
            </p>
            <button
              onClick={() => setCustomerTab('workshops')}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-5 py-3 text-xs font-semibold text-brand-cream hover:bg-brand-terracotta-hover shadow-card-sm cursor-pointer"
            >
              <Compass className="h-4 w-4" />
              <span>{t('Browse Workshops', 'تصفح الورش')}</span>
            </button>
          </div>
          </Reveal>
        ) : (
          pagedList.map((b, rowIndex) => {
            const isClosed = isCancellationClosed(b);
            const isCancelled = b.status === 'Cancelled';
            const imageUrl = getWorkshopImage(b.workshopId);
            const duration = getWorkshopDuration(b.workshopId);
            const titleLabel = bookingTitleLabel(b, workshops, birthdayPackages, lang);

            return (
              /* Capped stagger. 0.12s per row is fine for two bookings and turns
                 into a second of cascade at eight; past the sixth they land
                 together. Same cap as the workshop grid. */
              <Reveal
                key={b.id}
                onMount
                index={Math.min(rowIndex, 5)}
              >
              <div
                className={`flex flex-col sm:flex-row items-start sm:items-center justify-between p-5 rounded-[22px] border border-brand-clay bg-brand-cream shadow-2xs gap-4 transition-all hover:shadow-card-sm relative ${
                  isCancelled ? 'opacity-65' : ''
                }`}
              >
                {/* Left block: thumbnail & title info */}
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 shrink-0 rounded-xl overflow-hidden bg-brand-sand border border-brand-clay">
                    <AppImage src={imageUrl} alt={titleLabel} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                  </div>
                  <div className="space-y-1">
                    {/* Pending is not an alert — it is a state, so it is set
                        like the "Paid amount" label rather than as a badge. */}
                    {b.status === 'Pending' ? (
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-brand-sage">
                        {statusLabel(b.status)}
                      </span>
                    ) : (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${getStatusBadgeColor(b.status)}`}>
                        {statusLabel(b.status)}
                      </span>
                    )}
                    <h3 className="font-display text-lg font-semibold text-brand-charcoal leading-tight line-clamp-1">
                      {titleLabel}
                    </h3>
                    
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-brand-muted font-medium">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5 text-brand-sage" />
                        <span>{b.date} {t('at', 'في')} {timeLabel(b.time, lang)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5 text-brand-sage" />
                        {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                        <span>{b.participants} {b.participants === 1 ? t('guest', 'ضيف') : t('guests', 'ضيوف')}</span>
                      </span>
                      {/* Tutor resolved from the booked session record */}
                      <span className="flex items-center gap-1">
                        <GraduationCap className="h-3.5 w-3.5 text-brand-sage" />
                        <span>{resolveBookingInstructor(b, { staff, workshopSessions }).name}</span>
                      </span>
                      {duration && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5 text-brand-sage" />
                          <span>{durationLabel(duration, lang)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right block: total price & actions */}
                <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-center w-full sm:w-auto border-t sm:border-t-0 pt-3 sm:pt-0 border-brand-clay gap-2">
                  {(() => {
                    // Shared rule (customerAmountView): "Paid" only for money
                    // actually received; an unpaid booking shows what is due at
                    // the studio; never-paid / cancelled-unpaid shows nothing.
                    const view = customerAmountView(b);
                    switch (view.kind) {
                      case 'none':
                        return null;
                      case 'online-paid':
                        return (
                          <div className="text-start sm:text-end">
                            <span className="text-[10px] font-semibold text-brand-sage block uppercase tracking-wider">
                              {view.mode === 'deposit' ? t('Deposit paid', 'العربون المدفوع') : t('Paid amount', 'المبلغ المدفوع')}
                            </span>
                            <span className="text-base font-semibold text-brand-charcoal whitespace-nowrap">{sarAmount(view.paid)} {t('SAR', 'ريال')}</span>
                            {view.balance > 0 && (
                              <span className="block text-[10px] text-brand-muted whitespace-nowrap">
                                {t(`Balance ${sarAmount(view.balance)} SAR at the studio`, `المتبقي ${sarAmount(view.balance)} ريال في الاستوديو`)}
                              </span>
                            )}
                          </div>
                        );
                      case 'awaiting':
                        // A live hold: what is due, nothing claimed as paid.
                        return (
                          <div className="text-start sm:text-end">
                            <span className="text-[10px] font-semibold text-amber-700 block uppercase tracking-wider">{t('Awaiting payment', 'بانتظار الدفع')}</span>
                            <span className="text-base font-semibold text-brand-charcoal whitespace-nowrap">{sarAmount(view.amount)} {t('SAR', 'ريال')}</span>
                          </div>
                        );
                      case 'paid':
                        // Marked paid by staff (no online payment).
                        return (
                          <div className="text-start sm:text-end">
                            <span className="text-[10px] font-semibold text-brand-sage block uppercase tracking-wider">
                              {view.depositOnly ? t('Booking total', 'إجمالي الحجز') : t('Paid amount', 'المبلغ المدفوع')}
                            </span>
                            <span className="text-base font-semibold text-brand-charcoal whitespace-nowrap">{sarAmount(view.amount)} {t('SAR', 'ريال')}</span>
                            {view.depositOnly && (
                              <span className="block text-[10px] text-brand-muted whitespace-nowrap">
                                {t('Deposit paid · balance at the studio', 'تم دفع العربون · المتبقي في الاستوديو')}
                              </span>
                            )}
                          </div>
                        );
                      case 'due':
                        // Pay-at-studio booking, nothing paid yet.
                        return (
                          <div className="text-start sm:text-end">
                            <span className="text-[10px] font-semibold text-brand-sage block uppercase tracking-wider">{t('Amount due at the studio', 'المبلغ المستحق في الاستوديو')}</span>
                            <span className="text-base font-semibold text-brand-charcoal whitespace-nowrap">{sarAmount(view.amount)} {t('SAR', 'ريال')}</span>
                          </div>
                        );
                    }
                  })()}

                  {/* Cancel Booking Action Trigger with Hover Tooltip simulation */}
                  {activeTab === 'Upcoming' && !isCancelled && (
                    <div className="relative">
                      {isClosed ? (
                        /* Cancellation Closed Variant */
                        <div className="relative">
                          <button
                            onMouseEnter={() => setHoveredTooltipId(b.id)}
                            onMouseLeave={() => setHoveredTooltipId(null)}
                            /* window.alert() renders as browser chrome and cannot be RTL-styled regardless of translation — translating the text anyway. */
                            onClick={() => alert(t(
                              `Cancellation closed. It is less than 24 hours before class start. Please contact the front desk at ${STUDIO_PHONE}.`,
                              `تم إغلاق باب الإلغاء. تبقّى أقل من 24 ساعة على بدء الورشة. يرجى التواصل مع مكتب الاستقبال على ${STUDIO_PHONE}.`
                            ))}
                            className="text-xs font-semibold text-gray-400 bg-gray-100 border border-gray-200 px-3 py-2 min-h-11 rounded-lg flex items-center gap-1.5 cursor-not-allowed"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>{t('Cancel booking', 'إلغاء الحجز')}</span>
                            <HelpCircle className="h-3 w-3 text-brand-terracotta shrink-0" />
                          </button>

                          {/* Hover Tooltip - requested in the prompt */}
                          {hoveredTooltipId === b.id && (
                            <div className="absolute end-0 bottom-full mb-2 z-50 w-[min(16rem,calc(100vw-2rem))] p-3 bg-brand-charcoal text-brand-cream rounded-xl text-[11px] leading-relaxed shadow-card border border-brand-clay animate-in fade-in slide-in-from-bottom-2 duration-200 font-semibold">
                              <div className="flex items-start gap-1.5">
                                <AlertCircle className="h-4 w-4 text-brand-terracotta shrink-0 mt-0.5" />
                                <span>{t('Cancellation closed — less than 24 hours before start', 'الإلغاء مغلق — أقل من 24 ساعة على البدء')}</span>
                              </div>
                              <div className="absolute top-full end-4 w-2 h-2 bg-brand-charcoal rotate-45 -mt-1 border-e border-b border-brand-clay"></div>
                            </div>
                          )}
                        </div>
                      ) : (
                        /* Normal Cancel Button */
                        <button
                          disabled={cancellingId === b.id}
                          onClick={async () => {
                            // Worded from the same rule the backend applies, so
                            // the dialog cannot promise a refund the function
                            // then declines to give.
                            const willRefund = isRefundable(b);
                            const consequence = b.paymentStatus === 'Awaiting Payment'
                              ? t('Nothing has been charged for it.', 'لم يُخصم أي مبلغ مقابله.')
                              : b.paymentMode === 'deposit'
                                ? t(
                                    `The ${paidAmount(b)} SAR deposit is non-refundable.`,
                                    `العربون البالغ ${paidAmount(b)} ريال غير قابل للاسترداد.`
                                  )
                                : !isPaidStatus(b.paymentStatus)
                                  // Nothing was paid, so nothing is refunded.
                                  ? t('Nothing has been paid for it.', 'لم يُدفع أي مبلغ مقابله.')
                                : willRefund
                                  ? (b.paymentStatus === 'Deposit Paid' && !b.moyasarPaymentId
                                      // Deposit taken at the studio: its amount is not recorded.
                                      ? t('The studio will refund your deposit.', 'سيعيد الاستوديو العربون المدفوع.')
                                      : t(
                                          `The studio will refund your payment of ${paidAmount(b)} SAR.`,
                                          `سيعيد الاستوديو مبلغ الدفع البالغ ${paidAmount(b)} ريال.`
                                        ))
                                  : t(
                                      'This booking is within 24 hours of its start, so it is not eligible for a refund.',
                                      'هذا الحجز خلال 24 ساعة من بدايته، لذا فهو غير مؤهل لاسترداد المبلغ.'
                                    );
                            // window.confirm() renders as browser chrome and cannot be RTL-styled regardless of translation — translating the text anyway.
                            if (!window.confirm(t(
                              `Are you sure you want to cancel your booking for ${b.workshopTitle}? ${consequence}`,
                              `هل أنت متأكد أنك تريد إلغاء حجزك في ${titleLabel}؟ ${consequence}`
                            ))) return;

                            // The result is acted on rather than discarded: the
                            // old call could be refused server-side and the page
                            // would still look as though it had worked.
                            setCancellingId(b.id);
                            const result = await cancelOwnBooking(b.id);
                            setCancellingId(null);
                            if (!result.success) {
                              // window.alert() renders as browser chrome and cannot be RTL-styled regardless of translation — translating the text anyway.
                              window.alert(result.error || t('That booking could not be cancelled.', 'تعذّر إلغاء هذا الحجز.'));
                            }
                          }}
                          className="text-xs font-semibold text-brand-terracotta hover:text-brand-terracotta-hover hover:underline py-2 px-3 min-h-11 rounded-lg border border-transparent hover:border-brand-clay flex items-center gap-1.5 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>{t('Cancel booking', 'إلغاء الحجز')}</span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Cancelled placeholder marker */}
                  {isCancelled && (
                    <span className="text-xs font-semibold text-brand-charcoal/40 italic block py-1">
                      {/* Said only when it is true: this read "Refund complete" for
                          every cancelled booking, refunded or not. */}
                      {b.paymentStatus === 'Refunded'
                        ? t('Refunded', 'تم استرداد المبلغ')
                        : b.paymentStatus === 'Needs Refund' || b.paymentStatus === 'Refund Processing'
                          ? t('Refund on its way from the studio', 'سيعيد الاستوديو المبلغ')
                          : b.paymentStatus === 'Expired'
                            ? t('Not paid in time — nothing charged', 'لم يُدفع في الوقت — لم يُخصم أي مبلغ')
                            : b.paymentStatus === 'Awaiting Payment'
                              ? t('Cancelled — nothing charged', 'ملغى — لم يُخصم أي مبلغ')
                              : t('Cancelled', 'ملغى')}
                    </span>
                  )}
                </div>

              </div>
              </Reveal>
            );
          })
        )}
      </div>

      {/* Prev / Next only. At three pages a numbered row adds nothing, and it
          would need its own truncation rules the moment the list grew. Hidden
          altogether at one page rather than shown as a dead "Page 1 of 1". */}
      {pageCount > 1 && (
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            aria-label={t('Previous page', 'الصفحة السابقة')}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-brand-clay bg-brand-cream text-brand-charcoal transition-colors hover:bg-brand-clay-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-cream cursor-pointer"
          >
            <ChevronLeft className="h-4 w-4 flip-rtl" />
          </button>

          <span aria-live="polite" className="text-sm font-semibold text-brand-charcoal ltr-numerals">
            {t('Page', 'صفحة')} {currentPage} {t('of', 'من')} {pageCount}
          </span>

          <button
            type="button"
            onClick={() => setPage(p => Math.min(pageCount, p + 1))}
            disabled={currentPage === pageCount}
            aria-label={t('Next page', 'الصفحة التالية')}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-brand-clay bg-brand-cream text-brand-charcoal transition-colors hover:bg-brand-clay-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-cream cursor-pointer"
          >
            <ChevronRight className="h-4 w-4 flip-rtl" />
          </button>
        </div>
      )}

    </div>
  );
};
