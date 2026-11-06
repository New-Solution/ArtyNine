/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shown in the staff cancel dialogs for a booking paid online (0046).
 * "Mark as Refunded" only records the outcome; the money itself is returned
 * from the Moyasar dashboard. Saying so here stops a booking being marked
 * refunded while the customer is never paid back.
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
            'Marking it refunded does not return any money. To refund, find this payment in the Moyasar dashboard and refund it there:',
            'التسجيل كمسترد لا يعيد أي مبلغ. للاسترداد، ابحث عن هذه الدفعة في لوحة تحكم Moyasar واستردها من هناك:'
          )}{' '}
          <span className="font-mono select-all break-all">{booking.moyasarPaymentId}</span>
        </p>
      </div>
    </div>
  );
};
