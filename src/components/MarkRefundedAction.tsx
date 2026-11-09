/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Mark as Refunded" for a booking whose refund is due ('Needs Refund').
 * Shown in the Bookings ledger and Events detail panels. Recording it sends
 * the customer the registered "refunded" SMS and the refunded bell
 * notification, once — see markBookingRefunded() in AppContext.
 */

import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { OnlineRefundNote } from './OnlineRefundNote';
import type { Booking } from '../types';

export const MarkRefundedAction: React.FC<{ booking?: Booking | null }> = ({ booking }) => {
  const { markBookingRefunded } = useApp();
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!booking || booking.paymentStatus !== 'Needs Refund') return null;

  return (
    <div className="space-y-2">
      <OnlineRefundNote booking={booking} />
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await markBookingRefunded(booking.id, 'Staff');
          setBusy(false);
          if (!result.success) setError(result.error || null);
        }}
        className="cursor-pointer w-full bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold py-2.5 rounded-xl transition-colors text-center block"
      >
        {t('Mark as Refunded', 'تسجيل كمسترد')}
      </button>
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  );
};
