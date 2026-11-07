/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Moyasar payment form for a booking that is already HELD (0046:
 * 'Awaiting Payment'). The parent creates the hold and reads its quote from
 * the database; this renders the form for exactly that amount, counts down
 * the hold, and reports expiry.
 *
 * Card details are typed into Moyasar's form and go straight to Moyasar; they
 * never touch this app or its database.
 *
 * Flow: Moyasar creates the payment -> on_completed sends its id to
 * verify-payment (awaited by Moyasar.js before any 3-D Secure redirect, so the
 * payment is on record even if the customer never returns) -> Moyasar
 * redirects to callback_url -> the return handler in AppContext finishes.
 *
 * Apple Pay has no 3-D Secure step: the payment is usually already 'paid'
 * when on_completed fires, so that first verify-payment call confirms the
 * booking. Moyasar.js (v2.3.0) then closes the Apple Pay sheet and redirects
 * to callback_url with ?id=…&status=paid exactly as for a card, and the return
 * page's own verify-payment call answers 'confirmed' again (idempotent), so
 * the customer lands on the same confirmation screen.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Clock, Lock, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  loadMoyasar,
  verifyPayment,
  paymentCallbackUrl,
  MOYASAR_METHODS,
  type PaymentQuote,
  type MoyasarInitConfig
} from '../lib/onlinePayment';
import { MOYASAR_PUBLISHABLE_KEY } from '../utils/featureFlags';
import { MOYASAR_APPLE_PAY, moyasarDescription, moyasarConfigProblem } from '../utils/moyasarConfig';

interface Props {
  bookingId: string;
  quote: PaymentQuote;
  /** Shown to the customer above the form, e.g. "Wheel Basics — 2 guests". */
  description: string;
  onExpired: () => void;
}

/** How long the Apple Pay sheet waits for verify-payment before Moyasar.js
 *  moves on to the return page (which checks again). */
const APPLE_PAY_VERIFY_WAIT_MS = 10_000;

const formatClock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const MoyasarPaymentPanel: React.FC<Props> = ({ bookingId, quote, description, onExpired }) => {
  const { lang, t } = useLanguage();
  const formRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState(false);
  // Moyasar.js refused the configuration. Shown in place of its own raw
  // "Form configuration issue!" box; the real reason goes to the console.
  const [configError, setConfigError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(() => Date.parse(quote.expiresAt) - Date.now());
  const expiredRef = useRef(false);

  // Hold countdown. The database releases the place at expiresAt whatever
  // this page shows; the countdown only tells the customer.
  useEffect(() => {
    const expires = Date.parse(quote.expiresAt);
    const tick = () => {
      const left = expires - Date.now();
      setRemainingMs(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpired();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [quote.expiresAt, onExpired]);

  // Mount the form once per held booking.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    setConfigError(false);
    loadMoyasar()
      .then(Moyasar => {
        if (cancelled || !formRef.current) return;
        const element = formRef.current;
        element.innerHTML = '';
        const config: MoyasarInitConfig = {
          element,
          amount: quote.amountHalalas,
          currency: 'SAR',
          // For the studio's Moyasar dashboard. Booking id only, never a
          // workshop title (could be Arabic): printable ASCII, see moyasarConfig.
          description: moyasarDescription(bookingId),
          publishable_api_key: MOYASAR_PUBLISHABLE_KEY,
          callback_url: paymentCallbackUrl(),
          methods: MOYASAR_METHODS,
          supported_networks: ['mada', 'visa', 'mastercard'],
          language: lang === 'ar' ? 'ar' : 'en',
          fixed_width: false,
          // What verify-payment matches the payment to. Never trusted alone:
          // the amount owed is the booking's, not the form's.
          metadata: { booking_id: bookingId },
          // label must be printable ASCII or Moyasar.js rejects the whole form.
          apple_pay: { ...MOYASAR_APPLE_PAY },
          on_completed: async payment => {
            // Record the payment before any 3-D Secure redirect. A failure here
            // is not the customer's problem: the return page and the
            // auto-cancel job both check again.
            const verifying = verifyPayment(payment.id);
            if (payment.source?.type === 'applepay') {
              // The Apple Pay sheet stays open until this returns, and Apple
              // gives up on it after about 30 s. Don't keep it waiting on a
              // slow verify-payment: the redirect's return page verifies again.
              await Promise.race([verifying, new Promise(r => window.setTimeout(r, APPLE_PAY_VERIFY_WAIT_MS))]);
            } else {
              await verifying;
            }
          },
          on_failure: async () => {
            setFailure(t(
              'The payment could not be started. Please check your payment details and try again.',
              'تعذّر بدء عملية الدفع. يرجى التحقق من بيانات الدفع والمحاولة مرة أخرى.'
            ));
          }
        };

        const refuse = (reason: unknown) => {
          console.error('Moyasar payment form could not be set up:', reason);
          element.innerHTML = '';
          if (!cancelled) setConfigError(true);
        };

        // Moyasar.init does not throw on a bad config: it logs the reason and
        // draws its own "Form configuration issue!" box instead of the form.
        // So: check what we know it validates first, catch anything thrown,
        // and treat its error box, if drawn anyway, as a refusal too.
        const problem = moyasarConfigProblem(config);
        if (problem) {
          refuse(problem);
          return;
        }
        try {
          Moyasar.init(config);
        } catch (err) {
          refuse(err);
          return;
        }
        if (/Form configuration issue/i.test(element.textContent ?? '')) {
          refuse('Moyasar.js rejected the configuration (see the error logged above).');
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
    // lang is read once: switching language mid-payment would wipe what the
    // customer has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, quote.amountHalalas]);

  const expired = remainingMs <= 0;
  const amountLabel = `${quote.amount.toFixed(2).replace(/\.00$/, '')} ${t('SAR', 'ريال')}`;
  const balance = Math.max(0, Math.round((quote.totalPrice - quote.amount) * 100) / 100);

  return (
    <div className="space-y-4">
      <div className="p-4 bg-brand-sand/20 rounded-[22px] border border-brand-clay space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-brand-charcoal">
            {quote.mode === 'deposit' ? t('Deposit due now', 'العربون المستحق الآن') : t('Total due now', 'الإجمالي المستحق الآن')}
          </span>
          <span className="font-serif text-xl font-semibold text-brand-terracotta">{amountLabel}</span>
        </div>
        {quote.mode === 'deposit' && (
          <p className="text-[11px] text-brand-ink">
            {balance > 0
              ? t(`Non-refundable. The balance of ${balance} SAR is paid at the studio.`, `غير قابل للاسترداد. يُدفع المبلغ المتبقي (${balance} ريال) في الاستوديو.`)
              : t('Non-refundable.', 'غير قابل للاسترداد.')}
          </p>
        )}
        <p className="text-[11px] text-brand-muted">{description}</p>
        <p
          className={`flex items-center gap-1.5 text-[11px] font-semibold ${remainingMs < 120_000 ? 'text-amber-700' : 'text-brand-sage'}`}
          aria-live="polite"
        >
          <Clock className="h-3.5 w-3.5" />
          {expired
            ? t('Your place is no longer held.', 'لم يعد مكانك محجوزًا.')
            : t(`Your place is held for ${formatClock(remainingMs)}`, `مكانك محجوز لمدة ${formatClock(remainingMs)}`)}
        </p>
      </div>

      {loadError ? (
        <p className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-semibold">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            {t(
              'The secure payment form could not be loaded. Check your connection and reload the page — your place stays held until the timer ends.',
              'تعذّر تحميل نموذج الدفع الآمن. تحقق من اتصالك وأعد تحميل الصفحة — يبقى مكانك محجوزًا حتى انتهاء المؤقت.'
            )}
          </span>
        </p>
      ) : configError ? (
        <p role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-semibold">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            {t(
              'Online payment is temporarily unavailable, please try again or contact the studio.',
              'الدفع الإلكتروني غير متاح مؤقتًا، يرجى المحاولة مرة أخرى أو التواصل مع الاستوديو.'
            )}
          </span>
        </p>
      ) : (
        // dir follows the page so the form lays out right-to-left in Arabic.
        <div
          ref={formRef}
          dir={lang === 'ar' ? 'rtl' : 'ltr'}
          className={`mysr-form ${expired ? 'pointer-events-none opacity-40' : ''}`}
          aria-busy={!expired}
        />
      )}

      {failure && <p className="text-xs text-red-500 font-semibold text-center">{failure}</p>}

      <div className="flex items-center justify-center gap-1.5 text-[11px] text-brand-muted pt-1">
        <Lock className="h-3.5 w-3.5 text-brand-sage" />
        <span>{t('Payment details go directly to Moyasar and are never stored by Arty.', 'تُرسل بيانات الدفع مباشرة إلى Moyasar ولا يحتفظ بها Arty أبدًا.')}</span>
      </div>
    </div>
  );
};
