/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { ShieldCheck, Lock, ChevronDown, Store } from 'lucide-react';
import { PrePaymentPopup } from './PrePaymentPopup';
import { migratePrePaymentPopup } from '../types';
import { validateBookingForm, validateBirthdayBookingForm } from '../utils/validation';
import { generateBookingRefCode } from '../utils/idGeneration';
import { bookingTitleLabel } from '../utils/bookingTitleLabel';
import { timeLabel } from '../utils/availabilityLabel';
import { CheckoutStepper } from './ui/CheckoutStepper';
import { BackButton } from './ui/BackButton';
import { MoyasarPaymentPanel } from './MoyasarPaymentPanel';
import { ONLINE_PAYMENTS_AVAILABLE, ONLINE_CHECKOUT_SHIPPED } from '../utils/featureFlags';
import {
  ONLINE_PAYMENTS_SETTING_ID, normalizeOnlinePayments, estimateOnlineAmount, birthdayFullPrice
} from '../utils/onlinePayments';
import { fetchPaymentQuote, rememberPendingPayment, type PaymentQuote } from '../lib/onlinePayment';

export const CheckoutPaymentSection: React.FC = () => {
  const { 
    pendingBooking, setPendingBooking, setCustomerTab, addBooking, setLastBookingCreated, workshops, currentUser,
    birthdayPackages,
    sessionExpired,
    appSettings
  } = useApp();
  const { lang, t } = useLanguage();

  // The guidelines pop-up is configured in Settings -> Booking Pop-up. Reading
  // it live means an admin edit shows up here without a rebuild or a reload.
  const popupConfig = migratePrePaymentPopup(
    appSettings.find(s => s.id === 'prePaymentInstructions')?.value
  );
  const [showPopup, setShowPopup] = useState(false);
  // Capacity/session message from the shared validation layer.
  const [bookingError, setBookingError] = useState<string | null>(null);
  /**
   * A failure from the booking WRITE, as opposed to the pre-check above it.
   *
   * Kept separate because the two have opposite recoveries. A pre-check failure
   * means the seat is gone and retrying cannot help, so it disables the button.
   * A write failure may be transient — a dropped connection, a stale PostgREST
   * schema cache — and the customer must be able to press the button again
   * without rebuilding the whole booking.
   */
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * One reference code for every attempt at THIS booking.
   *
   * A retry after a timeout must not mint a new id. The write may have
   * committed server-side with the reply lost on the way back, and a second id
   * would then give the customer two bookings and consume two seats. Reusing
   * the code lets the RPCs recognise the retry and return the existing booking
   * instead of writing another (migration 0028).
   *
   * Reset when the pending booking changes, so a genuinely new booking gets a
   * genuinely new code.
   */
  const refCodeRef = useRef<string | null>(null);
  const pendingKey = `${pendingBooking?.sessionId || ''}|${pendingBooking?.date || ''}|${pendingBooking?.time || ''}`;
  const lastPendingKeyRef = useRef(pendingKey);
  if (lastPendingKeyRef.current !== pendingKey) {
    lastPendingKeyRef.current = pendingKey;
    refCodeRef.current = null;
  }
  if (!refCodeRef.current) {
    refCodeRef.current = generateBookingRefCode();
  }

  const [isProcessing, setIsProcessing] = useState(false);

  const workshop = workshops.find(w => w.id === pendingBooking?.workshopId) || workshops[0];
  const titleLabel = pendingBooking ? bookingTitleLabel(pendingBooking, workshops, birthdayPackages, lang) : '';

  // ---- Online payment (Moyasar, migration 0046) ----------------------------
  // On only when this build has the payment step and a key, AND the studio has
  // switched it on in Settings. Off: nothing is taken online — the booking is
  // saved Unpaid and paid at the studio (0050 enforces Unpaid in the database).
  const onlineConfig = normalizeOnlinePayments(appSettings.find(s => s.id === ONLINE_PAYMENTS_SETTING_ID)?.value);
  const onlineLive = ONLINE_PAYMENTS_AVAILABLE && onlineConfig.enabled;
  const isBirthdayBooking = !!pendingBooking && (
    pendingBooking.workshopId === 'birthday-party-event' ||
    pendingBooking.workshopTitle.toLowerCase().includes('birthday')
  );
  // Display only, before the hold exists. What is charged is the database's
  // figure (booking_payment_quote), shown once the place is held.
  const fullPrice = !pendingBooking
    ? 0
    : isBirthdayBooking
      ? birthdayFullPrice(birthdayPackages.find(p => p.id === pendingBooking.birthdayDetails?.packageId), pendingBooking.participants)
      : pendingBooking.totalPrice;
  const estimate = estimateOnlineAmount(fullPrice, isBirthdayBooking ? onlineConfig.birthday : onlineConfig.workshop);

  /** The held booking being paid for, once the hold exists. */
  const [hold, setHold] = useState<{ bookingId: string; quote: PaymentQuote } | null>(null);

  const handleHoldExpired = useCallback(() => {
    setHold(null);
    // A new attempt is a new booking: the expired one cannot be revived (0046
    // refuses a retry of an expired hold).
    refCodeRef.current = generateBookingRefCode();
    setSubmitError(t(
      'The time to pay ran out and your place was released. Nothing was charged. Please press the button to try again.',
      'انتهت مهلة الدفع وتم تحرير مكانك. لم يُخصم أي مبلغ. يرجى الضغط على الزر للمحاولة مرة أخرى.'
    ));
  }, [t]);

  if (!pendingBooking) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h2 className="font-display text-2xl font-semibold text-brand-charcoal">{t('No Workshop Selected', 'لم يتم اختيار ورشة')}</h2>
        <p className="text-sm text-brand-ink mt-2">{t('Please select a workshop from the catalog to book.', 'يرجى اختيار ورشة من الكتالوج للحجز.')}</p>
        <button
          onClick={() => setCustomerTab('workshops')}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-6 py-3 text-sm font-semibold text-brand-cream"
        >
          {t('Browse Workshops', 'تصفح الورش')}
        </button>
      </div>
    );
  }

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;
    setSubmitError(null);

    // Capacity is re-read from the database here, at submit time. The number
    // shown when the page loaded may be stale — someone else can take the last
    // seat while this customer is filling in their card details.
    const bookingErrors = await validateBookingForm({
      sessionId: pendingBooking.sessionId,
      participants: pendingBooking.participants
    }, undefined, undefined, lang);
    // A birthday package has no workshop session; its own rules apply below.
    const isBirthday = pendingBooking.workshopId === 'birthday-party-event' ||
      pendingBooking.workshopTitle.toLowerCase().includes('birthday');
    const capacityError = Object.values(bookingErrors)[0];
    if (!isBirthday && capacityError) {
      setBookingError(capacityError);
      return;
    }
    setBookingError(null);

    // Advance notice, daily maximum and same-slot maximum are all re-checked
    // here against a fresh read, exactly like workshop capacity above — the
    // page's own numbers can go stale while the customer is on this screen.
    if (isBirthday) {
      const birthdayErrors = await validateBirthdayBookingForm({
        date: pendingBooking.date,
        time: pendingBooking.time,
        totalPeople: pendingBooking.participants
      }, undefined, undefined, lang);
      const birthdayError = Object.values(birthdayErrors)[0];
      if (birthdayError) {
        setBookingError(birthdayError);
        return;
      }
    }

    // The studio guidelines are shown before the card is charged.
    if (popupConfig.enabled) {
      setShowPopup(true);
      return;
    }

    completePayment();
  };

  const completePayment = () => {
    if (isProcessing) return;
    setIsProcessing(true);

    const name = pendingBooking.customerName || currentUser?.name || 'Guest Customer';
    const email = pendingBooking.customerEmail || currentUser?.email || 'guest@artycafe.sa';
    const phone = pendingBooking.customerPhone || currentUser?.phone || '';

    // The booking write is awaited: the confirmation screen must never appear
    // for a booking the database has not accepted. With online payment this
    // write creates the HOLD and the card is charged afterwards, in Moyasar's
    // form, for the amount the database sets. Without it, nothing is charged:
    // the booking is saved Unpaid and paid at the studio.
    void (async () => {
      let newBooking;
      try {
        newBooking = await addBooking({
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        workshopId: pendingBooking.workshopId,
        // Keep the booked session on the booking so the tutor resolves from it.
        sessionId: pendingBooking.sessionId,
        workshopTitle: pendingBooking.workshopTitle,
        date: pendingBooking.date,
        time: pendingBooking.time,
        participants: pendingBooking.participants,
        totalPrice: pendingBooking.totalPrice,
        source: 'Website',
        status: 'Pending',
        // Never 'Paid' from the browser. Online: the database writes
        // 'Awaiting Payment'. Off: pay at the studio, so Unpaid (0050 forces
        // the same server-side).
        paymentStatus: 'Unpaid',
          // The full birthday submission travels onto the one shared booking record.
          birthdayDetails: pendingBooking.birthdayDetails
        }, refCodeRef.current!);
      } catch (err: any) {
        // Stay on the payment step with the customer's details intact — never
        // advance to the confirmation for a booking the database refused.
        const raw = String(err?.message || '');
        // The RPCs raise check_violation for a seat or slot that has just gone.
        // Those messages are written for a developer; the customer gets the
        // reason in their own terms.
        const isCapacity = /seat\(s\) left|fully booked/i.test(raw);
        // An aborted request is the one case where we genuinely do not know
        // whether the booking landed, so the wording must not claim it failed.
        // Pressing the button again is safe: the same reference code is reused,
        // and the RPC returns the existing booking rather than writing a second.
        const isTimeout = /abort/i.test(raw) || err?.name === 'AbortError';
        // 0046: a retry of a hold that has run out. A fresh code makes the
        // next press a genuinely new booking.
        const isExpiredHold = /hold has expired/i.test(raw);
        if (isExpiredHold) refCodeRef.current = generateBookingRefCode();
        // 0046: the database could not price this for online payment.
        const notPayableOnline = /cannot be paid online|package is no longer available/i.test(raw);
        // 0049: the database refuses a signed-out booking (the session ended
        // between the details step and here, e.g. signed out in another tab).
        const needsSignIn = /sign in to complete your booking/i.test(raw);
        setSubmitError(
          needsSignIn
            ? t(
                'You are no longer signed in. Please sign in again to finish your booking — nothing has been charged.',
                'لم تعد مسجّلًا الدخول. يرجى تسجيل الدخول مرة أخرى لإتمام حجزك — لم يتم خصم أي مبلغ.'
              )
          : isExpiredHold
            ? t(
                'The time to pay for this booking ran out and the place was released. Nothing was charged — please press the button to try again.',
                'انتهت مهلة الدفع لهذا الحجز وتم تحرير المكان. لم يُخصم أي مبلغ — يرجى الضغط على الزر للمحاولة مرة أخرى.'
              )
          : notPayableOnline
            ? t(
                'This booking cannot be paid online right now. Please contact the studio to book.',
                'لا يمكن دفع هذا الحجز إلكترونيًا حاليًا. يرجى التواصل مع الاستوديو لإتمام الحجز.'
              )
          : isCapacity
            ? t(
                'That session filled up while you were paying. Nothing has been charged — please choose another date or time.',
                'امتلأت هذه الجلسة أثناء عملية الدفع. لم يتم خصم أي مبلغ — يرجى اختيار تاريخ أو وقت آخر.'
              )
            : isTimeout
              ? t(
                  'That took too long and we could not confirm your booking. Nothing extra will be charged — please press the button again to check and finish.',
                  'استغرقت العملية وقتًا طويلاً ولم نتمكن من تأكيد حجزك. لن يتم خصم أي مبلغ إضافي — يرجى الضغط على الزر مرة أخرى للتحقق وإتمام الحجز.'
                )
              : t(
                  'We could not complete your booking, and nothing has been charged. Please try again.',
                  'تعذّر إتمام حجزك، ولم يتم خصم أي مبلغ. يرجى المحاولة مرة أخرى.'
                )
        );
        setIsProcessing(false);
        return;
      }

      // Bookings for today are placed on the Live Queue by the shared booking→queue
      // sync, which resolves the tutor from the booked session. Adding one here too
      // produced a second, instructor-less entry for the same booking.

      // Is this booking a hold waiting for payment? Asked of the database, not
      // inferred from this page's copy of the setting: if the studio switched
      // online payments on a moment ago, this page may not know yet, and
      // showing "confirmed" for an unpaid hold would lose the customer's place
      // when it expires. Errors (e.g. before 0046 is applied) mean "no hold".
      let quote: PaymentQuote | null = null;
      if (ONLINE_CHECKOUT_SHIPPED) {
        try {
          quote = await fetchPaymentQuote(newBooking.id);
        } catch {
          quote = null;
        }
      }

      if (quote) {
        if (!ONLINE_PAYMENTS_AVAILABLE) {
          // The database wants a payment this build cannot take (no key).
          setSubmitError(t(
            'Online payment is not available right now. Your place is held for a few minutes — please contact the studio to finish your booking.',
            'الدفع الإلكتروني غير متاح حاليًا. مكانك محجوز لبضع دقائق — يرجى التواصل مع الاستوديو لإتمام حجزك.'
          ));
          setIsProcessing(false);
          return;
        }
        rememberPendingPayment({
          bookingId: newBooking.id,
          workshopId: pendingBooking.workshopId,
          isBirthday: isBirthdayBooking,
          customerName: name,
          customerPhone: phone,
          customerEmail: email,
          startedAt: Date.now()
        });
        setSubmitError(null);
        setHold({ bookingId: newBooking.id, quote });
        setIsProcessing(false);
        return;
      }

      if (onlineLive) {
        // Expected a hold and the database did not create one: the studio
        // switched online payments off meanwhile. The booking stands, unpaid.
        setSubmitError(t(
          'Your booking was received but online payment is not available right now. The studio will contact you about payment.',
          'تم استلام حجزك لكن الدفع الإلكتروني غير متاح حاليًا. سيتواصل معك الاستوديو بخصوص الدفع.'
        ));
        setIsProcessing(false);
        return;
      }

      setLastBookingCreated(newBooking);
      setPendingBooking(null);
      setIsProcessing(false);
      setCustomerTab('confirmation');
    })();
  };

  const summaryBody = (
    <>
            <div className="space-y-1 text-xs text-brand-ink">
              <p className="text-[10px] font-semibold uppercase text-brand-sage">{t('Customer', 'العميل')}</p>
              <p className="font-semibold text-brand-charcoal text-sm">{pendingBooking.customerName}</p>
              <p>{pendingBooking.customerEmail}</p>
              <p>{pendingBooking.customerPhone}</p>
            </div>

            <div className="border-t border-brand-clay pt-3 space-y-2 text-xs text-brand-ink">
              <div className="flex justify-between">
                <span>{t('Workshop', 'الورشة')}:</span>
                <span className="font-semibold text-brand-charcoal">{titleLabel}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Date', 'التاريخ')}:</span>
                <span className="font-semibold text-brand-charcoal">{pendingBooking.date}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Time Slot', 'الوقت')}:</span>
                <span className="font-semibold text-brand-charcoal">{timeLabel(pendingBooking.time, lang)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Participants', 'المشاركون')}:</span>
                {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                <span className="font-semibold text-brand-charcoal">{pendingBooking.participants} {pendingBooking.participants === 1 ? t('guest', 'ضيف') : t('guests', 'ضيوف')}</span>
              </div>
            </div>

            <div className="border-t border-brand-clay pt-3 flex justify-between items-center text-brand-charcoal">
              <span className="font-semibold text-sm">{onlineLive ? t('Total Amount', 'الإجمالي') : t('Pay at the studio', 'الدفع في الاستوديو')}:</span>
              <span className={onlineLive ? 'font-semibold text-sm' : 'font-serif text-2xl font-semibold text-brand-terracotta'}>
                {onlineLive ? (hold?.quote.totalPrice ?? fullPrice) : pendingBooking.totalPrice} {t('SAR', 'ريال')}
              </span>
            </div>
            {onlineLive && (
              <div className="flex justify-between items-center text-brand-charcoal">
                <span className="font-semibold text-sm">
                  {(hold?.quote.mode ?? estimate.mode) === 'deposit'
                    ? t('Deposit due now', 'العربون المستحق الآن')
                    : t('Due now', 'المستحق الآن')}:
                </span>
                <span className="font-serif text-2xl font-semibold text-brand-terracotta">
                  {hold?.quote.amount ?? estimate.dueNow} {t('SAR', 'ريال')}
                </span>
              </div>
            )}
    </>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 animate-in fade-in duration-300 text-start">

      {showPopup && (
        <PrePaymentPopup
          config={popupConfig}
          onCancel={() => setShowPopup(false)}
          onConfirm={() => {
            setShowPopup(false);
            completePayment();
          }}
        />
      )}
      
      {/* Back button */}
      <BackButton onClick={() => setCustomerTab('checkout-info')} className="mb-6">
        {t('Back to Contact Information', 'العودة إلى بيانات التواصل')}
      </BackButton>

      {/* Title then stepper — the same header the birthday reservation uses. */}
      <div className="mb-8">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
          {t('Workshop Booking', 'حجز الورشة')}
        </span>
        <h1 className="mt-3 font-display text-3xl font-semibold text-brand-charcoal sm:text-[42px]">
          {onlineLive ? t('Payment Method', 'طريقة الدفع') : t('Confirm Your Booking', 'تأكيد الحجز')}
        </h1>
        <p className="mt-3 text-sm text-brand-ink">
          {onlineLive
            ? t('Pay securely online to secure your place.', 'ادفع إلكترونيًا بأمان لتأكيد مكانك.')
            : t('No payment is taken online. You pay at the studio.', 'لا يتم الدفع إلكترونيًا. تدفع في الاستوديو.')}
        </p>
      </div>

      <CheckoutStepper steps={[t('Customer Information', 'بيانات العميل'), t('Payment', 'الدفع')]} current={2} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Payment Methods Selection */}
        {/* shadow-card, matching the month grid on the workshop detail page —
            the same 0 18px 44px warm shadow, not a new one. The left panel was
            on shadow-card-sm (8px/20px) and the right had none at all, so both
            sat flat against the sand background. Colours, radius, padding and
            border are untouched; only the lift changes. */}
        <div className="lg:col-span-7 bg-brand-cream rounded-[28px] p-6 sm:p-8 border border-brand-clay shadow-card">
          
          <h2 className="font-display text-lg font-semibold text-brand-charcoal mb-4">
            {onlineLive ? t('Secure Payment', 'الدفع الآمن') : t('Pay at the studio', 'الدفع في الاستوديو')}
          </h2>

          {onlineLive && hold ? (
            <MoyasarPaymentPanel
              bookingId={hold.bookingId}
              quote={hold.quote}
              description={`${titleLabel} — ${pendingBooking.date} ${timeLabel(pendingBooking.time, lang)}`}
              onExpired={handleHoldExpired}
            />
          ) : (
          <form onSubmit={handlePay} className="space-y-4">

            {onlineLive && (
              <p className="p-4 bg-brand-sand/20 rounded-[22px] border border-brand-clay text-xs text-brand-ink leading-relaxed">
                {estimate.mode === 'deposit'
                  ? t(
                      `Pay a non-refundable deposit of ${estimate.dueNow} SAR now by card or mada to secure your place${estimate.balance > 0 ? `; the remaining ${estimate.balance} SAR is paid at the studio` : ''}.`,
                      `ادفع الآن عربونًا غير قابل للاسترداد بقيمة ${estimate.dueNow} ريال بالبطاقة أو مدى لتأكيد مكانك${estimate.balance > 0 ? `، ويُدفع المبلغ المتبقي (${estimate.balance} ريال) في الاستوديو` : ''}.`
                    )
                  : t(
                      `Pay ${estimate.dueNow} SAR now by card or mada to confirm your booking. Cancellations more than 24 hours ahead are refunded.`,
                      `ادفع ${estimate.dueNow} ريال الآن بالبطاقة أو مدى لتأكيد حجزك. يُسترد المبلغ عند الإلغاء قبل أكثر من 24 ساعة.`
                    )}
              </p>
            )}

            {!onlineLive && (
              <div className="flex items-start gap-3 p-4 bg-brand-sand/20 rounded-[22px] border border-brand-clay text-xs text-brand-ink leading-relaxed">
                <Store className="h-5 w-5 shrink-0 text-brand-sage" />
                <p>
                  {t(
                    `Your place is booked as soon as you confirm. Nothing is charged now — please pay ${pendingBooking.totalPrice} SAR at the studio when you arrive.`,
                    `يتم حجز مكانك فور التأكيد. لن يُخصم أي مبلغ الآن — يرجى دفع ${pendingBooking.totalPrice} ريال في الاستوديو عند وصولك.`
                  )}
                </p>
              </div>
            )}

            {/*
              The costliest place to be signed out without being told: the
              customer has filled in everything and is about to pay.
            */}
            {sessionExpired && (
              <p className="text-xs text-amber-700 font-semibold text-center">
                Your session expired, please sign in again.
              </p>
            )}

            {bookingError && (
              <p className="text-xs text-red-500 font-semibold text-center">{bookingError}</p>
            )}

            {submitError && (
              <p className="text-xs text-red-500 font-semibold text-center">{submitError}</p>
            )}

            {/* MOBILE SUMMARY — see CheckoutInfoSection. Open by default here:
                this is the step that charges the card, so the breakdown should
                be on screen rather than one tap away. */}
            <details open className="group lg:hidden rounded-2xl border border-brand-clay bg-brand-sand/30">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 truncate text-sm font-semibold text-brand-charcoal">{titleLabel}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-serif text-lg font-semibold text-brand-terracotta">{onlineLive ? estimate.dueNow : pendingBooking.totalPrice} {t('SAR', 'ريال')}</span>
                  <ChevronDown className="h-4 w-4 text-brand-muted transition-transform group-[[open]]:rotate-180" />
                </span>
              </summary>
              <div className="space-y-4 border-t border-brand-clay p-4">{summaryBody}</div>
            </details>

            <button
              type="submit"
              disabled={isProcessing || !!bookingError}
              className="w-full cursor-pointer bg-brand-terracotta text-brand-cream font-semibold py-4 rounded-2xl shadow-card-sm hover:bg-brand-terracotta-hover transition-all flex items-center justify-center gap-2 text-base mt-6 disabled:opacity-50"
            >
              <Lock className="h-4 w-4" />
              <span>
                {onlineLive
                  ? (isProcessing
                      ? t('Holding your place…', 'جارٍ حجز مكانك…')
                      : `${t('Continue to Secure Payment', 'المتابعة إلى الدفع الآمن')} (${estimate.dueNow} ${t('SAR', 'ريال')})`)
                  : isProcessing
                    ? t('Confirming your booking…', 'جارٍ تأكيد حجزك…')
                    : t('Confirm Booking — Pay at the studio', 'تأكيد الحجز — الدفع في الاستوديو')}
              </span>
            </button>

            <div className="flex items-center justify-center gap-1.5 text-[11px] text-brand-muted pt-1">
              <ShieldCheck className="h-4 w-4 text-brand-sage" />
              <span>
                {onlineLive
                  ? t('Payments are processed securely by Moyasar.', 'تتم معالجة المدفوعات بأمان عبر Moyasar.')
                  : t('Nothing is charged online. You pay at the studio.', 'لا يُخصم أي مبلغ إلكترونيًا. تدفع في الاستوديو.')}
              </span>
            </div>

          </form>
          )}

        </div>

        {/* Right Summary Column */}
        <div className="hidden lg:block lg:col-span-5">
          <div className="bg-brand-sand/30 rounded-[28px] p-6 border border-brand-clay shadow-card space-y-4">
            <h3 className="font-display text-lg font-semibold text-brand-charcoal border-b border-brand-clay pb-3">
              {t('Booking Details', 'تفاصيل الحجز')}
            </h3>

            {summaryBody}
          </div>
        </div>

      </div>

    </div>
  );
};
