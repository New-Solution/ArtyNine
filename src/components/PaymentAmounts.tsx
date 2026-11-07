/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * How much a booking costs and how much was actually paid, for staff views.
 *
 * An online-paid booking (0046) shows its full price AND what Moyasar took:
 *   Total 150 SAR · Paid online 100 SAR · Balance due at studio 50 SAR
 * Every other booking (walk-ins, staff bookings, bookings made before online
 * payments, unpaid holds) shows its total exactly as before.
 * The numbers come from the booking row (paymentBreakdown); nothing here
 * computes or changes money.
 */

import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { paymentBreakdown, sarAmount } from '../utils/onlinePayments';
import type { Booking } from '../types';

type AmountFields = Pick<Booking, 'totalPrice'> &
  Partial<Pick<Booking, 'paymentStatus' | 'paymentMode' | 'onlineAmount' | 'moyasarPaymentId' | 'paidAt'>>;

/** Table cell: the total on top, paid online and balance underneath.
 *  `align` follows the column: 'end' for a right-aligned amount column.
 *  Logical (start/end), so it mirrors correctly in Arabic. */
export const PaymentAmountsCell: React.FC<{ booking: AmountFields; totalClassName?: string; align?: 'start' | 'end' }> = ({ booking, totalClassName, align = 'start' }) => {
  const { t } = useLanguage();
  const pay = paymentBreakdown(booking);
  const sar = t('SAR', 'ريال');

  if (!pay.online) {
    return <span className={totalClassName}>{booking.totalPrice} {sar}</span>;
  }

  return (
    <span className={`inline-flex flex-col gap-0.5 ${align === 'end' ? 'items-end text-end' : 'items-start text-start'}`}>
      <span className={totalClassName}>
        <span className="font-normal text-brand-charcoal/50">{t('Total', 'الإجمالي')}: </span>
        <span className="ltr-numerals">{sarAmount(pay.total)}</span> {sar}
      </span>
      <span className="text-[10px] font-semibold text-emerald-700">
        {t('Paid online', 'مدفوع إلكترونيًا')}: <span className="ltr-numerals">{sarAmount(pay.paid)}</span> {sar}
      </span>
      {pay.balance > 0 && (
        <span className="text-[10px] font-semibold text-amber-700">
          {t('Balance due at studio', 'المتبقي في الاستوديو')}: <span className="ltr-numerals">{sarAmount(pay.balance)}</span> {sar}
        </span>
      )}
    </span>
  );
};

/** Details panel rows: total, paid online, balance, Moyasar payment id, paid at. */
export const PaymentAmountsDetails: React.FC<{
  booking: AmountFields;
  /** The panel's existing label for the single-total row. */
  totalLabel: string;
  labelClassName?: string;
  valueClassName?: string;
}> = ({ booking, totalLabel, labelClassName = 'font-semibold text-brand-charcoal/50', valueClassName = 'font-bold text-brand-terracotta' }) => {
  const { t, lang } = useLanguage();
  const pay = paymentBreakdown(booking);
  const sar = t('SAR', 'ريال');

  if (!pay.online) {
    return (
      <div className="flex justify-between gap-3">
        <span className={labelClassName}>{totalLabel}</span>
        <span className={valueClassName}>{booking.totalPrice} {sar}</span>
      </div>
    );
  }

  const paidAt = booking.paidAt ? new Date(booking.paidAt) : null;
  const paidAtLabel = paidAt && !Number.isNaN(paidAt.getTime())
    ? paidAt.toLocaleString(lang === 'ar' ? 'ar-SA' : 'en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <>
      <div className="flex justify-between gap-3">
        <span className={labelClassName}>{t('Total', 'الإجمالي')}</span>
        <span className="font-bold text-brand-charcoal ltr-numerals">{sarAmount(pay.total)} {sar}</span>
      </div>
      <div className="flex justify-between gap-3">
        <span className={labelClassName}>
          {pay.mode === 'deposit'
            ? t('Paid online (non-refundable deposit)', 'مدفوع إلكترونيًا (عربون غير مسترد)')
            : t('Paid online (full)', 'مدفوع إلكترونيًا (كاملًا)')}
        </span>
        <span className={`${valueClassName} ltr-numerals`}>{sarAmount(pay.paid)} {sar}</span>
      </div>
      {pay.mode === 'deposit' && (
        <div className="flex justify-between gap-3">
          <span className={labelClassName}>{t('Balance due at studio', 'المتبقي للدفع في الاستوديو')}</span>
          <span className="font-bold text-amber-700 ltr-numerals">{sarAmount(pay.balance)} {sar}</span>
        </div>
      )}
      {booking.moyasarPaymentId && (
        <div className="flex justify-between gap-3">
          <span className={labelClassName}>{t('Moyasar payment', 'دفعة Moyasar')}</span>
          {/* dir="ltr" keeps the uuid readable inside an RTL panel. */}
          <span dir="ltr" className="font-mono text-[10px] text-brand-charcoal select-all break-all text-end">{booking.moyasarPaymentId}</span>
        </div>
      )}
      {paidAtLabel && (
        <div className="flex justify-between gap-3">
          <span className={labelClassName}>{t('Paid at', 'وقت الدفع')}</span>
          <span className="font-semibold text-brand-charcoal">{paidAtLabel}</span>
        </div>
      )}
    </>
  );
};
