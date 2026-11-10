/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shown in the staff cancel dialogs for a booking paid online (0046).
 * Cancelling moves no money: choosing the refund outcome marks the booking
 * 'Needs Refund' (staffCancelPayment()), and the Refund button in the detail
 * panel returns it through Moyasar (refund-payment, 0054), which is when the
 * customer gets the refunded SMS.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import type { Booking } from '../types';

export const OnlineRefundNote: React.FC<{ booking?: Booking | null }> = ({ booking }) => {
  const { t } = useLanguage();
  if (!booking?.moyasarPaymentId) return null;

  const amount = booking.onlineAmount ?? booking.totalPrice;
  const isDeposit = booking.paymentMode === 'deposit';

  return (
    <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 leading-relaxed">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="font-bold">
          {t(`Paid online: ${amount} SAR via Moyasar`, `مدفوع إلكترونيًا: ${amount} ريال عبر Moyasar`)}
          {isDeposit ? t(' (non-refundable deposit)', ' (عربون غير قابل للاسترداد)') : ''}
        </p>
        <p>
          {t(
            'Cancelling does not return any money. Choosing the refund marks it Needs Refund; then use the Refund button to return the money through Moyasar. Payment:',
            'الإلغاء لا يعيد أي مبلغ. اختيار الاسترداد يسجّله «يحتاج استردادًا»؛ ثم استخدم زر الاسترداد لإعادة المبلغ عبر Moyasar. الدفعة:'
          )}{' '}
          <span className="font-mono select-all break-all">{booking.moyasarPaymentId}</span>
        </p>
      </div>
    </div>
  );
};
