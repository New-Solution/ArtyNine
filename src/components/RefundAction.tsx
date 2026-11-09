/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The refund action for a booking whose refund is due, in the Bookings ledger
 * and Events detail panels.
 *
 *   Paid online (moyasarPaymentId)  "Refund {amount} SAR" -> confirm ->
 *                                   refund-payment returns the money to the
 *                                   customer's card through Moyasar (void or
 *                                   refund), records it, and sends the
 *                                   refunded SMS and bell once. No Moyasar
 *                                   dashboard needed.
 *   Paid at the studio              "Mark as Refunded" (secondary): staff give
 *                                   the money back in person, then record it
 *                                   — markBookingRefunded() sends the SMS and
 *                                   bell once.
 *
 * The amount shown is the booking's own online amount; the server ignores
 * anything but the booking id and reads the amount from the database.
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Loader2, RotateCcw, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import type { Booking } from '../types';

/** 150 -> "150", 150.5 -> "150.50". */
function sar(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** What was paid online, in SAR, from the booking record. */
function onlineAmount(booking: Booking): number | null {
  if (Number.isInteger(booking.onlineAmountHalalas)) return (booking.onlineAmountHalalas as number) / 100;
  const n = Number(booking.onlineAmount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const RefundAction: React.FC<{ booking?: Booking | null }> = ({ booking }) => {
  const { markBookingRefunded, refundBookingOnline } = useApp();
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Kept per booking, so the note does not follow staff to another booking. */
  const [done, setDone] = useState<{ bookingId: string; text: string } | null>(null);

  if (!booking) return null;

  const successNote = done && done.bookingId === booking.id ? (
    <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900">
      <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{done.text}</span>
    </div>
  ) : null;

  const isOnline = !!booking.moyasarPaymentId;
  const due = booking.paymentStatus === 'Needs Refund';
  const processing = booking.paymentStatus === 'Refund Processing';

  if (!due && !(isOnline && processing)) return successNote;

  // ---------------------------------------------------------------------------
  // Paid at the studio: refunded in person, then recorded.
  // ---------------------------------------------------------------------------
  if (!isOnline) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-brand-charcoal/75 leading-relaxed">
          {t(
            'Paid at the studio: give the money back in person, then record it here. The customer gets the refunded SMS and notification.',
            'مدفوع في الاستوديو: أعد المبلغ للعميل شخصيًا ثم سجّله هنا. يصل العميل رسالة وإشعار الاسترداد.'
          )}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const result = await markBookingRefunded(booking.id, 'Staff');
            setBusy(false);
            if (!result.success) setError(result.error || t('Could not record the refund.', 'تعذر تسجيل الاسترداد.'));
            else setDone({ bookingId: booking.id, text: t('Recorded as refunded.', 'تم التسجيل كمسترد.') });
          }}
          className="cursor-pointer w-full bg-white text-brand-charcoal border border-brand-clay hover:bg-brand-sand disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold py-2.5 rounded-xl transition-colors text-center block"
        >
          {t('Mark as Refunded', 'تسجيل كمسترد')}
        </button>
        {error && <p className="text-[11px] text-red-700">{error}</p>}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Paid online: refund through Moyasar.
  // ---------------------------------------------------------------------------
  const amount = onlineAmount(booking);
  const amountText = amount === null ? '' : `${sar(amount)} `;

  const runRefund = async () => {
    setBusy(true);
    setError(null);
    const result = await refundBookingOnline(booking.id);
    setBusy(false);
    setConfirming(false);
    if (!result.success) {
      setError(result.error || t('The refund did not go through.', 'لم يتم الاسترداد.'));
      return;
    }
    setDone({
      bookingId: booking.id,
      text: result.method === 'moyasar_refunded' || result.method === 'moyasar_voided'
        ? t('Moyasar already showed this payment returned; the booking is now marked Refunded.',
            'أظهر Moyasar أن المبلغ أُعيد مسبقًا؛ تم تسجيل الحجز كمسترد.')
        : t(`Refunded ${amountText}SAR to the customer's card through Moyasar.`,
            `تم استرداد ${amountText}ريال إلى بطاقة العميل عبر Moyasar.`)
    });
  };

  if (processing) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 p-3 rounded-xl bg-sky-50 border border-sky-200 text-[11px] text-sky-900 leading-relaxed">
          <Loader2 className="h-4 w-4 shrink-0 mt-0.5 animate-spin" />
          <span>
            {t(
              'A refund is being processed through Moyasar. If this does not clear within a few minutes, check again: it asks Moyasar first, so it never refunds twice.',
              'جارٍ معالجة الاسترداد عبر Moyasar. إن لم يكتمل خلال دقائق، تحقّق مرة أخرى: يسأل Moyasar أولًا فلا يُسترد المبلغ مرتين.'
            )}
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={runRefund}
          className="cursor-pointer w-full bg-white text-brand-charcoal border border-brand-clay hover:bg-brand-sand disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold py-2.5 rounded-xl transition-colors text-center flex items-center justify-center gap-1.5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {busy ? t('Checking…', 'جارٍ التحقق…') : t('Check again', 'تحقّق مرة أخرى')}
        </button>
        {error && <p className="text-[11px] text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => { setError(null); setConfirming(true); }}
        className="cursor-pointer w-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold py-2.5 rounded-xl transition-colors text-center flex items-center justify-center gap-1.5 shadow-sm"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t(`Refund ${amountText}SAR`, `استرداد ${amountText}ريال`)}
      </button>
      {error && <p className="text-[11px] text-red-700 leading-relaxed">{error}</p>}

      {confirming && createPortal(
        <div className="fixed inset-0 bg-brand-charcoal/65 backdrop-blur-xs z-[60] flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true"
               className="bg-brand-cream border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-md w-full text-start space-y-5 text-brand-charcoal">
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <h3 className="font-display text-lg font-extrabold flex items-center gap-2">
                <RotateCcw className="h-5 w-5 text-blue-600" />
                <span>{t(`Refund ${amountText}SAR?`, `استرداد ${amountText}ريال؟`)}</span>
              </h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="p-1 rounded-lg hover:bg-brand-sand cursor-pointer disabled:opacity-40 focus:outline-none"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2 text-xs leading-relaxed">
              <p className="font-bold">
                {t("This returns the money to the customer's card through Moyasar.",
                   'سيعيد هذا المبلغ إلى بطاقة العميل عبر Moyasar.')}
              </p>
              <p className="text-brand-charcoal/75">
                {t('It cannot be undone. The customer gets the refunded SMS and notification.',
                   'لا يمكن التراجع عن ذلك. يصل العميل رسالة وإشعار الاسترداد.')}
              </p>
              <p className="text-[11px] text-brand-charcoal/60">
                {booking.customerName} · {booking.workshopTitle}
                <br />
                <span dir="ltr" className="font-mono break-all">{booking.moyasarPaymentId}</span>
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="cursor-pointer flex-1 bg-white border border-brand-clay hover:bg-brand-sand disabled:opacity-40 py-3 text-xs font-bold rounded-xl transition-colors text-center"
              >
                {t('Go Back', 'رجوع')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={runRefund}
                className="cursor-pointer flex-1 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 py-3 text-xs font-bold rounded-xl transition-colors text-center shadow-md flex items-center justify-center gap-1.5"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? t('Refunding…', 'جارٍ الاسترداد…') : t(`Refund ${amountText}SAR`, `استرداد ${amountText}ريال`)}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
