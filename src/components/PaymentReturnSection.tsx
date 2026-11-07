/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where Moyasar sends the customer back: callback_url is this site with
 * ?payment=return, and Moyasar appends &id=<payment id>&status=…&message=….
 *
 * The URL's status is never believed. The payment id is handed to
 * verify-payment, which fetches the payment from Moyasar with the secret key
 * and lets the database decide (0046). This page only shows the answer:
 *   confirmed     -> the normal confirmation screen
 *   pending       -> keep asking for a while (3-D Secure still settling)
 *   failed        -> try again, in place, while the hold lasts
 *   studio cases  -> what happened and that the studio will follow up
 *
 * React state did not survive the redirect. What is needed comes from the
 * payment id (in the URL) and, as a convenience, sessionStorage
 * (rememberPendingPayment, set when the hold was created).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Info } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import {
  readPaymentReturn,
  clearPaymentReturnFromUrl,
  verifyPayment,
  fetchPaymentQuote,
  readPendingPayment,
  forgetPendingPayment,
  type PaymentQuote,
  type VerifyOutcome
} from '../lib/onlinePayment';
import { paymentStateMessage, paymentCheckUnavailable, type PaymentMessage } from '../utils/paymentMessages';
import { MoyasarPaymentPanel } from './MoyasarPaymentPanel';
import type { Booking } from '../types';

/** How long to keep asking while Moyasar still says 'initiated'. */
const PENDING_RETRIES = 10;
const RETRY_MS = 3000;

export const PaymentReturnSection: React.FC = () => {
  const { setCustomerTab, setLastBookingCreated, setPendingBooking } = useApp();
  const { t } = useLanguage();

  // Read once: the URL is cleaned straight after, so a refresh does not
  // re-run the return (verify-payment is idempotent anyway).
  const [paymentId] = useState(() => readPaymentReturn());
  const [pending] = useState(() => readPendingPayment());
  const [message, setMessage] = useState<PaymentMessage | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(pending?.bookingId ?? null);
  const [retryHold, setRetryHold] = useState<{ bookingId: string; quote: PaymentQuote } | null>(null);
  const attempts = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    clearPaymentReturnFromUrl();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const finishConfirmed = useCallback((outcome: Extract<VerifyOutcome, { ok: true }>) => {
    const b = outcome.booking;
    const nowIso = new Date().toISOString();
    // The confirmation screen reads id, title, date, time, participants,
    // totalPrice and workshopId. The rest is filled so the object is a valid
    // Booking; personal details come from this browser's own session only.
    const confirmed: Booking = {
      id: b?.id ?? outcome.bookingId ?? '',
      customerName: pending?.customerName ?? '',
      customerEmail: pending?.customerEmail ?? '',
      customerPhone: pending?.customerPhone ?? '',
      workshopId: pending?.workshopId ?? (pending?.isBirthday ? 'birthday-party-event' : ''),
      workshopTitle: b?.workshopTitle ?? '',
      date: b?.date ?? '',
      time: b?.time ?? '',
      participants: b?.participants ?? 1,
      totalPrice: b?.totalPrice ?? 0,
      source: 'Website',
      status: 'Pending',
      paymentStatus: (b?.paymentStatus as Booking['paymentStatus']) ?? 'Paid',
      paymentMode: b?.paymentMode === 'full' ? 'full' : b?.paymentMode === 'deposit' ? 'deposit' : undefined,
      onlineAmount: b?.onlineAmount ?? undefined,
      // The payment verify-payment just confirmed with Moyasar. Carried so the
      // confirmation screen treats this exactly like any other online-paid
      // booking (paymentBreakdown requires a recorded payment).
      moyasarPaymentId: paymentId ?? undefined,
      createdAt: nowIso,
      timeline: []
    };
    forgetPendingPayment();
    setPendingBooking(null);
    setLastBookingCreated(confirmed);
    setCustomerTab('confirmation');
  }, [pending, setCustomerTab, setLastBookingCreated, setPendingBooking]);

  const check = useCallback(async () => {
    if (!paymentId) return;
    const outcome = await verifyPayment(paymentId, 'return-page');

    if (!outcome.ok) {
      // verify-payment unreachable. Keep trying a few times; never suggest
      // paying again.
      setMessage(paymentCheckUnavailable(t));
      if (attempts.current++ < PENDING_RETRIES) timer.current = window.setTimeout(check, RETRY_MS * 2);
      return;
    }

    if (outcome.bookingId) setBookingId(outcome.bookingId);

    if (outcome.state === 'confirmed') {
      finishConfirmed(outcome);
      return;
    }

    setMessage(paymentStateMessage(outcome.state, t, outcome.message));

    if (outcome.state === 'pending' && attempts.current++ < PENDING_RETRIES) {
      timer.current = window.setTimeout(check, RETRY_MS);
      return;
    }

    // Declined: offer the form again for the same hold, if it still exists.
    if (outcome.state === 'failed') {
      const holdId = outcome.bookingId ?? pending?.bookingId ?? null;
      if (holdId) {
        try {
          const quote = await fetchPaymentQuote(holdId);
          if (quote) setRetryHold({ bookingId: holdId, quote });
        } catch {
          /* no retry offered; the message already says what happened */
        }
      }
    }
  }, [paymentId, pending, t, finishConfirmed]);

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetryExpired = useCallback(() => {
    setRetryHold(null);
    forgetPendingPayment();
    setMessage({
      kind: 'retry',
      title: t('Your place was released', 'تم تحرير مكانك'),
      body: t(
        'The time to pay ran out. Nothing was charged. Please book again.',
        'انتهت مهلة الدفع. لم يُخصم أي مبلغ. يرجى الحجز مرة أخرى.'
      )
    });
  }, [t]);

  if (!paymentId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h2 className="font-display text-2xl font-semibold text-brand-charcoal">{t('No payment to show', 'لا توجد دفعة لعرضها')}</h2>
        <button
          onClick={() => setCustomerTab('home')}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-6 py-3 text-sm font-semibold text-brand-cream"
        >
          {t('Back to home', 'العودة إلى الرئيسية')}
        </button>
      </div>
    );
  }

  const icon = !message || message.kind === 'wait'
    ? <Loader2 className="h-8 w-8 text-brand-sage animate-spin" />
    : message.kind === 'success'
      ? <CheckCircle2 className="h-8 w-8 text-emerald-600" />
      : message.kind === 'studio'
        ? <Info className="h-8 w-8 text-brand-terracotta" />
        : <AlertTriangle className="h-8 w-8 text-amber-600" />;

  return (
    <div className="mx-auto max-w-xl px-4 py-12 animate-in fade-in duration-300 text-start">
      <div className="bg-brand-cream rounded-[28px] p-6 sm:p-8 border border-brand-clay shadow-card space-y-5">
        <div className="flex items-start gap-4" aria-live="polite">
          <div className="shrink-0">{icon}</div>
          <div>
            <h1 className="font-display text-2xl font-semibold text-brand-charcoal">
              {message?.title ?? t('Checking your payment…', 'جارٍ التحقق من دفعتك…')}
            </h1>
            <p className="mt-2 text-sm text-brand-ink leading-relaxed">
              {message?.body ?? t('This takes a few seconds. Please do not close this page or pay again.', 'يستغرق ذلك بضع ثوانٍ. يرجى عدم إغلاق هذه الصفحة أو الدفع مرة أخرى.')}
            </p>
            {bookingId && (
              <p className="mt-3 text-xs text-brand-muted">
                {t('Booking reference', 'رقم الحجز')}: <span className="font-mono font-semibold text-brand-charcoal">{bookingId}</span>
              </p>
            )}
          </div>
        </div>

        {retryHold && (
          <MoyasarPaymentPanel
            bookingId={retryHold.bookingId}
            quote={retryHold.quote}
            description={t('Try again with the same or another card.', 'حاول مرة أخرى بالبطاقة نفسها أو بطاقة أخرى.')}
            onExpired={handleRetryExpired}
          />
        )}

        {message && message.kind !== 'wait' && !retryHold && (
          <div className="flex flex-wrap gap-2 pt-1">
            {message.kind === 'retry' && (
              <button
                onClick={() => setCustomerTab('workshops')}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-5 py-2.5 text-sm font-semibold text-brand-cream cursor-pointer"
              >
                {t('Book again', 'احجز مرة أخرى')}
              </button>
            )}
            <button
              onClick={() => setCustomerTab('home')}
              className="inline-flex items-center gap-2 rounded-xl border border-brand-clay bg-white px-5 py-2.5 text-sm font-semibold text-brand-charcoal cursor-pointer"
            >
              {t('Back to home', 'العودة إلى الرئيسية')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
