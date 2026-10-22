/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  CalendarDays, Globe, User, ListOrdered, Palette, Box, AlertTriangle, Coins, 
  TrendingUp, TrendingDown, Clock, Cake, Bell, CheckCircle2, Phone, Mail, ChevronRight, Sparkles, Filter
} from 'lucide-react';
import { Booking, PotteryPiece } from '../types';
import { PieceImage } from '../lib/pieceImages';
import { getActivitiesForDate, categorizeBooking } from '../utils/activityUtils';
import { searchText } from '../utils/search';
import { usePagination, TablePager } from './ui/TablePager';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';

export const AdminDashboardSection: React.FC = () => {
  const {
    bookings,
    queue,
    workshops,
    setAdminTab,
    todayDateStr,
    getRelativeRiyadhDateStr,
    overduePickupPieces: overduePickupPiecesRaw,
    markPieceCollected,
    sendPickupReminder,
    setSelectedEventBookingId
  } = useApp();
  const { lang, t } = useLanguage();

  const tomorrowDateStr = useMemo(() => getRelativeRiyadhDateStr(1), [getRelativeRiyadhDateStr]);
  const currentRiyadhMonth = useMemo(() => todayDateStr.slice(0, 7), [todayDateStr]);

  /**
   * Opens the right details view for a booking:
   * birthday packages and events open in Events & Socials on that exact
   * reservation, workshops open in the Bookings page.
   */
  const openBookingDetails = (booking: Booking) => {
    if (categorizeBooking(booking, workshops) === 'Events/Birthdays') {
      setSelectedEventBookingId(booking.id);
      setAdminTab('events-admin');
      return;
    }
    setAdminTab('bookings');
  };

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // 1. TODAY'S BOOKINGS — one merged view over the shared booking and queue
  // records, so website bookings, admin bookings and walk-ins all appear, and a
  // booking that also has a queue entry appears once. Both lists come from live
  // queries and todayDateStr ticks in Riyadh time, so this stays current without
  // a restart.
  const todaysBookings = useMemo(
    () => getActivitiesForDate({ bookings, queue, workshops }, todayDateStr),
    [bookings, queue, workshops, todayDateStr]
  );

  const todaysTotalParticipants = useMemo(() => {
    return todaysBookings.reduce((sum, a) => sum + a.participants, 0);
  }, [todaysBookings]);

  // 2. TOMORROW'S BOOKINGS
  const tomorrowsBookings = useMemo(() => {
    return bookings
      .filter(b => b.date === tomorrowDateStr && b.status !== 'Cancelled')
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [bookings, tomorrowDateStr]);

  const tomorrowsTotalParticipants = useMemo(() => {
    return tomorrowsBookings.reduce((sum, b) => sum + b.participants, 0);
  }, [tomorrowsBookings]);

  // 3. BIRTHDAY BOOKINGS THIS MONTH
  const monthlyBirthdayBookings = useMemo(() => {
    return bookings
      .filter(b => {
        // A booking with no title is rare but not invalid, and reading it
        // directly took the whole dashboard down with it.
        const title = searchText(b.workshopTitle);
        const isBirthday = b.workshopId === 'birthday-party-event' ||
          title.includes('birthday') ||
          title.includes('package');
        return isBirthday && b.status !== 'Cancelled' && (b.date || '').startsWith(currentRiyadhMonth);
      })
      .sort((a, b) => {
        const dateDiff = a.date.localeCompare(b.date);
        if (dateDiff !== 0) return dateDiff;
        return a.time.localeCompare(b.time);
      });
  }, [bookings, currentRiyadhMonth]);

  // 4. OVERDUE READY-FOR-PICKUP PIECES (7+ DAYS)
  // overduePickupPiecesRaw is already filtered to status = 'Ready for Pickup'
  // server-side, inside get_overdue_pickup_pieces() itself (audit finding
  // C-4) — no need to re-check status here.
  const overduePickupPieces = useMemo(() => {
    return overduePickupPiecesRaw
      .filter(p => {
        // Calculate days waiting since ready date or daysElapsed
        const readyDate = p.expectedReadyDate || p.actualReadyDate || p.readyDate || p.dateCreated || todayDateStr;
        let daysWaiting = p.daysElapsed || 0;

        if (readyDate) {
          const t1 = new Date(todayDateStr).getTime();
          const t2 = new Date(readyDate.split('T')[0]).getTime();
          if (!isNaN(t1) && !isNaN(t2)) {
            const diffDays = Math.max(0, Math.floor((t1 - t2) / (1000 * 60 * 60 * 24)));
            daysWaiting = Math.max(daysWaiting, diffDays);
          }
        }

        return daysWaiting >= 7;
      })
      .map(p => {
        const readyDate = p.expectedReadyDate || p.actualReadyDate || p.readyDate || p.dateCreated || todayDateStr;
        const t1 = new Date(todayDateStr).getTime();
        const t2 = new Date(readyDate.split('T')[0]).getTime();
        let daysWaiting = p.daysElapsed || 7;
        if (!isNaN(t1) && !isNaN(t2)) {
          const diffDays = Math.max(0, Math.floor((t1 - t2) / (1000 * 60 * 60 * 24)));
          daysWaiting = Math.max(daysWaiting, diffDays);
        }
        return {
          ...p,
          daysWaiting
        };
      })
      .sort((a, b) => b.daysWaiting - a.daysWaiting);
  }, [overduePickupPiecesRaw, todayDateStr]);

  /* Five rows a page on every dashboard table. Nothing is dropped — the rest
     is a page turn away — and the page resets itself when the row count
     changes, which is what happens as bookings arrive through the day. */
  const todaysPager = usePagination(todaysBookings, 5);
  const tomorrowsPager = usePagination(tomorrowsBookings, 5);
  const birthdayPager = usePagination(monthlyBirthdayBookings, 5);
  const overduePager = usePagination(overduePickupPieces, 5);

  // Handle Mark Piece as Collected — via markPieceCollected() (audit finding
  // C-4): a direct updatePieceStatus()/updatePiece() call would be refused by
  // pieces/piece_history RLS for a caller without the pieces-admin
  // permission once 0014 is applied. Takes the whole row rather than just an
  // id, since the display fields needed for the notification it writes are
  // already on hand here — a fresh piece read would itself now be blocked.
  const handleMarkCollected = async (piece: PotteryPiece & { daysWaiting: number }) => {
    const result = await markPieceCollected({
      id: piece.id,
      name: piece.name,
      pieceCode: piece.pieceCode,
      customerName: piece.customerName,
      customerPhone: piece.customerPhone
    });
    if (result.success) {
      showToast(t(`Piece ${piece.pieceCode || piece.id} marked as Collected for ${piece.customerName}!`, `تم تسجيل القطعة ${piece.pieceCode || piece.id} كمُستلمة للعميل ${piece.customerName}!`));
    } else {
      showToast(result.error || t('Could not mark this piece as collected. Please try again.', 'تعذّر تسجيل هذه القطعة كمُستلمة. يرجى المحاولة مرة أخرى.'));
    }
  };

  // Handle Send Pickup Reminder — via sendPickupReminder(), same reasoning
  // as handleMarkCollected above. Now also fires a real SMS (SMS
  // integration, Chunk 2): four distinct outcomes are surfaced so staff
  // never mistake a cooldown or a text-only failure for the reminder not
  // having been recorded at all.
  const handleSendReminder = async (piece: PotteryPiece & { daysWaiting: number }) => {
    const result = await sendPickupReminder({
      id: piece.id,
      name: piece.name,
      pieceCode: piece.pieceCode,
      customerName: piece.customerName,
      customerPhone: piece.customerPhone
    });

    if (result.outcome === 'sent') {
      if (result.smsSent === true) {
        showToast(t(`Pickup reminder texted to ${piece.customerName} for piece ${piece.pieceCode || piece.id}.`, `تم إرسال رسالة تذكير بالاستلام إلى ${piece.customerName} للقطعة ${piece.pieceCode || piece.id}.`));
      } else {
        showToast(t(`Reminder recorded for ${piece.pieceCode || piece.id}, but the text message could not be sent: ${result.smsError}`, `تم تسجيل التذكير للقطعة ${piece.pieceCode || piece.id}، لكن تعذّر إرسال الرسالة النصية: ${result.smsError}`));
      }
    } else if (result.outcome === 'cooldown') {
      showToast(t(`${piece.customerName} was already reminded today for piece ${piece.pieceCode || piece.id}.`, `تم تذكير ${piece.customerName} اليوم بالفعل بشأن القطعة ${piece.pieceCode || piece.id}.`));
    } else {
      showToast(result.error || t('Could not send a reminder for this piece. Please try again.', 'تعذّر إرسال تذكير لهذه القطعة. يرجى المحاولة مرة أخرى.'));
    }
  };

  // Live Queue & Revenue Metrics
  const metrics = useMemo(() => {
    const inQueueCount = queue.filter(q => (q.status === 'Waiting' || q.status === 'In Progress') && q.date === todayDateStr).length;
    const unpaidBookingsCount = bookings.filter(b => b.paymentStatus === 'Unpaid' && b.status !== 'Cancelled').length;
    const totalRevenue = bookings
      .filter(b => (b.paymentStatus === 'Paid' || b.paymentStatus === 'Deposit Paid') && b.status !== 'Cancelled')
      .reduce((sum, curr) => sum + curr.totalPrice, 0);

    return {
      inQueueCount,
      unpaidBookingsCount,
      totalRevenue
    };
  }, [queue, bookings, todayDateStr]);

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 text-left animate-in fade-in duration-300 bg-brand-cream min-h-full">
      
      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="fixed top-4 right-4 z-50 bg-brand-charcoal text-brand-cream px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-xs font-bold border border-brand-clay/30 animate-in slide-in-from-top-2 duration-200">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header & Riyadh Date Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-brand-clay/70 p-5 rounded-3xl shadow-2xs">
        <div>
          <h1 className="font-display text-2xl font-bold text-brand-charcoal">{t('Admin Operational Dashboard', 'لوحة التشغيل الإدارية')}</h1>
          <p className="text-xs text-brand-charcoal/60 mt-0.5">
            {t('Real-time daily management, studio attendance, and pottery collection lifecycle in Riyadh Time (GMT+3).', 'إدارة يومية لحظية، وحضور الاستوديو، ودورة استلام الفخار بتوقيت الرياض (GMT+3).')}
          </p>
        </div>

        <div className="flex items-center gap-3 bg-brand-sand/50 border border-brand-clay/60 px-4 py-2 rounded-2xl">
          <CalendarDays className="h-4 w-4 text-brand-terracotta" />
          <div className="text-xs">
            <p className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">{t('Operational Riyadh Date', 'تاريخ التشغيل (الرياض)')}</p>
            <p className="font-bold font-mono text-brand-charcoal">{todayDateStr}</p>
          </div>
        </div>
      </div>

      {/* Top 6 High-Level KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
        
        {/* Card 1: Today's Active Bookings */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t("Today's Bookings", 'حجوزات اليوم')}</span>
            <div className="p-1.5 rounded-lg bg-brand-terracotta/10 text-brand-terracotta">
              <CalendarDays className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold text-brand-charcoal">{todaysBookings.length}</p>
            <p className="text-[10px] font-semibold text-brand-sage mt-0.5">{todaysTotalParticipants} {t('total participants', 'إجمالي المشاركين')}</p>
          </div>
        </div>

        {/* Card 2: Tomorrow's Active Bookings */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t("Tomorrow's Bookings", 'حجوزات الغد')}</span>
            <div className="p-1.5 rounded-lg bg-blue-50 text-blue-600">
              <CalendarDays className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold text-brand-charcoal">{tomorrowsBookings.length}</p>
            <p className="text-[10px] font-semibold text-blue-600 mt-0.5">{tomorrowsTotalParticipants} {t('scheduled guests', 'ضيوف مجدولون')}</p>
          </div>
        </div>

        {/* Card 3: Monthly Birthday Packages */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Birthdays This Month', 'أعياد الميلاد هذا الشهر')}</span>
            <div className="p-1.5 rounded-lg bg-pink-50 text-pink-600">
              <Cake className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold text-pink-700">{monthlyBirthdayBookings.length}</p>
            <p className="text-[10px] font-semibold text-pink-600 mt-0.5">{currentRiyadhMonth} {t('reservations', 'حجوزات')}</p>
          </div>
        </div>

        {/* Card 4: Awaiting Pickup 7+ Days */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Overdue Pickup (7d+)', 'استلام متأخر (7+ أيام)')}</span>
            <div className="p-1.5 rounded-lg bg-amber-50 text-amber-700">
              <Box className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className={`text-2xl font-bold ${overduePickupPieces.length > 0 ? 'text-amber-700' : 'text-brand-charcoal'}`}>
              {overduePickupPieces.length}
            </p>
            <p className="text-[10px] font-semibold text-amber-800 mt-0.5">{t('Shelved & ready 7+ days', 'على الرف وجاهزة منذ 7+ أيام')}</p>
          </div>
        </div>

        {/* Card 5: In Live Queue Now */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('In Live Queue', 'في قائمة الانتظار الحية')}</span>
            <div className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600">
              <ListOrdered className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold text-emerald-700">{metrics.inQueueCount}</p>
            <p className="text-[10px] font-semibold text-emerald-600 mt-0.5">{t('Walk-in studio guests', 'ضيوف الاستوديو (زيارة مباشرة)')}</p>
          </div>
        </div>

        {/* Card 6: Total Recorded Revenue */}
        <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Recorded Revenue', 'الإيرادات المسجلة')}</span>
            <div className="p-1.5 rounded-lg bg-purple-50 text-purple-600">
              <Coins className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2">
            <p className="text-2xl font-bold text-purple-800">{metrics.totalRevenue} {t('SAR', 'ريال')}</p>
            <p className="text-[10px] font-semibold text-purple-600 mt-0.5">{t('Paid & deposits', 'المدفوعات والعرابين')}</p>
          </div>
        </div>

      </div>

      {/* =========================================================
          SECTION 1: TODAY'S BOOKINGS
          ========================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-brand-terracotta/10 rounded-xl text-brand-terracotta">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg text-brand-charcoal">{t("Today's Bookings", 'حجوزات اليوم')}</h2>
              <p className="text-xs text-brand-charcoal/60">
                {t(`Workshops, events, birthday packages and studio walk-ins scheduled for today (${todayDateStr}).`, `ورش وفعاليات وباقات أعياد ميلاد وزيارات مباشرة مجدولة لليوم (${todayDateStr}).`)}
              </p>
            </div>
          </div>

          <button
            onClick={() => setAdminTab('bookings')}
            className="text-xs font-bold text-brand-terracotta hover:underline flex items-center gap-1 cursor-pointer self-start sm:self-auto"
          >
            <span>{t('Manage All Bookings', 'إدارة كل الحجوزات')}</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {todaysBookings.length === 0 ? (
          <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/30 rounded-2xl border border-dashed border-brand-clay">
            {t(`No active bookings or walk-ins for today (${todayDateStr}).`, `لا توجد حجوزات نشطة أو زيارات مباشرة لليوم (${todayDateStr}).`)}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                  <th className="py-2.5 px-3">{t('Time', 'الوقت')}</th>
                  <th className="py-2.5 px-3">{t('Customer Name', 'اسم العميل')}</th>
                  <th className="py-2.5 px-3">{t('Phone', 'الجوال')}</th>
                  <th className="py-2.5 px-3">{t('Booking Type', 'نوع الحجز')}</th>
                  <th className="py-2.5 px-3">{t('Workshop / Event Title', 'عنوان الورشة / الفعالية')}</th>
                  <th className="py-2.5 px-3">{t('Guests', 'الضيوف')}</th>
                  <th className="py-2.5 px-3">{t('Payment', 'الدفع')}</th>
                  <th className="py-2.5 px-3">{t('Status', 'الحالة')}</th>
                  <th className="py-2.5 px-3 text-right">{t('Action', 'الإجراء')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30 font-medium">
                {todaysPager.pageItems.map(a => (
                  <tr key={a.id} className="hover:bg-brand-sand/15 transition-colors">
                    <td className="py-3 px-3 font-mono font-bold text-brand-terracotta">{a.time}</td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{a.customerName}</td>
                    <td className="py-3 px-3 font-mono text-brand-charcoal/80">{a.customerPhone}</td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                        a.category === 'Events/Birthdays' ? 'bg-pink-50 text-pink-800 border-pink-200' :
                        a.category === 'Self-Guided' ? 'bg-purple-50 text-purple-800 border-purple-200' :
                        'bg-blue-50 text-blue-800 border-blue-200'
                      }`}>
                        {enumLabel('category', a.category, lang)}
                      </span>
                      <span className="ml-1.5 inline-flex px-2 py-0.5 rounded text-[10px] font-bold border bg-brand-sand/50 text-brand-charcoal/70 border-brand-clay/50">
                        {enumLabel('source', a.source, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{a.title}</td>
                    <td className="py-3 px-3 font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{a.participants} {t('guest(s)', 'ضيف/ضيوف')}</td>
                    <td className="py-3 px-3">
                      {a.paymentStatus ? (
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                          a.paymentStatus === 'Paid' || a.paymentStatus === 'Deposit Paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                          'bg-red-50 text-red-800 border-red-200'
                        }`}>
                          {enumLabel('payment', a.paymentStatus, lang)}
                        </span>
                      ) : (
                        <span className="text-brand-charcoal/40">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                        a.status === 'Checked In' || a.status === 'Completed' || a.status === 'In Progress'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : 'bg-amber-50 text-amber-800 border-amber-200'
                      }`}>
                        {enumLabel('bookingStatus', a.status, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => {
                          // Birthday and event bookings open in Events & Socials,
                          // on the same shared booking record.
                          if (a.category === 'Events/Birthdays' && a.bookingId) {
                            setSelectedEventBookingId(a.bookingId);
                            setAdminTab('events-admin');
                            return;
                          }
                          setAdminTab(a.bookingId ? 'bookings' : 'queue');
                        }}
                        className="bg-brand-sand border border-brand-clay/60 text-brand-charcoal px-2.5 py-1 rounded-lg text-xs font-bold hover:bg-brand-clay/40 transition-all cursor-pointer"
                      >
                        {t('View Details', 'عرض التفاصيل')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager
            page={todaysPager.page}
            totalPages={todaysPager.totalPages}
            from={todaysPager.from}
            to={todaysPager.to}
            total={todaysPager.total}
            onPage={todaysPager.setPage}
            noun={t('bookings', 'حجوزات')}
          />
          </>
        )}
      </div>

      {/* =========================================================
          SECTION 2: TOMORROW'S BOOKINGS
          ========================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg text-brand-charcoal">{t("Tomorrow's Bookings", 'حجوزات الغد')}</h2>
              <p className="text-xs text-brand-charcoal/60">
                {t(`Advance reservations scheduled for tomorrow (${tomorrowDateStr}).`, `حجوزات مسبقة مجدولة للغد (${tomorrowDateStr}).`)}
              </p>
            </div>
          </div>

          <span className="text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 px-3 py-1 rounded-xl">
            {tomorrowsBookings.length} {t('sessions booked', 'جلسات محجوزة')} ({tomorrowsTotalParticipants} {t('guests', 'ضيوف')})
          </span>
        </div>

        {tomorrowsBookings.length === 0 ? (
          <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/30 rounded-2xl border border-dashed border-brand-clay">
            {t(`No bookings scheduled for tomorrow (${tomorrowDateStr}) yet.`, `لا توجد حجوزات مجدولة للغد (${tomorrowDateStr}) بعد.`)}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                  <th className="py-2.5 px-3">{t('Date & Time', 'التاريخ والوقت')}</th>
                  <th className="py-2.5 px-3">{t('Customer Name', 'اسم العميل')}</th>
                  <th className="py-2.5 px-3">{t('Phone', 'الجوال')}</th>
                  <th className="py-2.5 px-3">{t('Booking Type', 'نوع الحجز')}</th>
                  <th className="py-2.5 px-3">{t('Workshop / Event Title', 'عنوان الورشة / الفعالية')}</th>
                  <th className="py-2.5 px-3">{t('Guests', 'الضيوف')}</th>
                  <th className="py-2.5 px-3">{t('Payment', 'الدفع')}</th>
                  <th className="py-2.5 px-3">{t('Status', 'الحالة')}</th>
                  <th className="py-2.5 px-3 text-right">{t('Action', 'الإجراء')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30 font-medium">
                {tomorrowsPager.pageItems.map(b => (
                  <tr key={b.id} className="hover:bg-brand-sand/15 transition-colors">
                    <td className="py-3 px-3">
                      <p className="font-bold text-brand-charcoal">{b.date}</p>
                      <p className="font-mono text-[10px] text-brand-terracotta font-bold">{b.time}</p>
                    </td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{b.customerName}</td>
                    <td className="py-3 px-3 font-mono text-brand-charcoal/80">{b.customerPhone}</td>
                    <td className="py-3 px-3">
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
                        {searchText(b.workshopTitle).includes('birthday') ? t('Birthday Package', 'باقة عيد ميلاد') : t('Workshop', 'ورشة')}
                      </span>
                    </td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{b.workshopTitle}</td>
                    <td className="py-3 px-3 font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{b.participants} {t('guest(s)', 'ضيف/ضيوف')}</td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                        b.paymentStatus === 'Paid' || b.paymentStatus === 'Deposit Paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                        'bg-red-50 text-red-800 border-red-200'
                      }`}>
                        {enumLabel('payment', b.paymentStatus, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                        {enumLabel('bookingStatus', b.status, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => openBookingDetails(b)}
                        className="bg-brand-sand border border-brand-clay/60 text-brand-charcoal px-2.5 py-1 rounded-lg text-xs font-bold hover:bg-brand-clay/40 transition-all cursor-pointer"
                      >
                        {t('View Details', 'عرض التفاصيل')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager
            page={tomorrowsPager.page}
            totalPages={tomorrowsPager.totalPages}
            from={tomorrowsPager.from}
            to={tomorrowsPager.to}
            total={tomorrowsPager.total}
            onPage={tomorrowsPager.setPage}
            noun={t('bookings', 'حجوزات')}
          />
          </>
        )}
      </div>

      {/* =========================================================
          SECTION 3: BIRTHDAY BOOKINGS THIS MONTH
          ========================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-pink-50 text-pink-600 rounded-xl">
              <Cake className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg text-brand-charcoal">{t(`Birthday Package Reservations (${currentRiyadhMonth})`, `حجوزات باقات أعياد الميلاد (${currentRiyadhMonth})`)}</h2>
              <p className="text-xs text-brand-charcoal/60">
                {t('All confirmed birthday celebration bookings scheduled for this month.', 'جميع حجوزات احتفالات أعياد الميلاد المؤكدة لهذا الشهر.')}
              </p>
            </div>
          </div>

          <span className="text-xs font-bold text-pink-700 bg-pink-50 border border-pink-200 px-3 py-1 rounded-xl">
            {monthlyBirthdayBookings.length} {t('birthday events', 'حفلات أعياد ميلاد')}
          </span>
        </div>

        {monthlyBirthdayBookings.length === 0 ? (
          <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/30 rounded-2xl border border-dashed border-brand-clay">
            {t(`No birthday packages are booked for this month (${currentRiyadhMonth}).`, `لا توجد باقات أعياد ميلاد محجوزة لهذا الشهر (${currentRiyadhMonth}).`)}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                  <th className="py-2.5 px-3">{t('Session Date & Time', 'تاريخ ووقت الجلسة')}</th>
                  <th className="py-2.5 px-3">{t('Customer Name', 'اسم العميل')}</th>
                  <th className="py-2.5 px-3">{t('Contact Phone', 'جوال التواصل')}</th>
                  <th className="py-2.5 px-3">{t('Birthday Package Name', 'اسم باقة عيد الميلاد')}</th>
                  <th className="py-2.5 px-3">{t('Guests', 'الضيوف')}</th>
                  <th className="py-2.5 px-3">{t('Deposit / Price', 'العربون / السعر')}</th>
                  <th className="py-2.5 px-3">{t('Payment', 'الدفع')}</th>
                  <th className="py-2.5 px-3">{t('Status', 'الحالة')}</th>
                  <th className="py-2.5 px-3 text-right">{t('Action', 'الإجراء')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30 font-medium">
                {birthdayPager.pageItems.map(b => (
                  <tr key={b.id} className="hover:bg-brand-sand/15 transition-colors">
                    <td className="py-3 px-3">
                      <p className="font-bold text-brand-charcoal">{b.date}</p>
                      <p className="font-mono text-[10px] text-pink-600 font-bold">{b.time}</p>
                    </td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{b.customerName}</td>
                    <td className="py-3 px-3 font-mono text-brand-charcoal/80">{b.customerPhone}</td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal flex items-center gap-1.5">
                      <Cake className="h-3.5 w-3.5 text-pink-500 shrink-0" />
                      <span>{b.workshopTitle}</span>
                    </td>
                    <td className="py-3 px-3 font-mono">{b.participants} {t('guests', 'ضيوف')}</td>
                    <td className="py-3 px-3 font-bold text-emerald-800">{b.totalPrice} {t('SAR', 'ريال')}</td>
                    <td className="py-3 px-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                        b.paymentStatus === 'Paid' || b.paymentStatus === 'Deposit Paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                        'bg-red-50 text-red-800 border-red-200'
                      }`}>
                        {enumLabel('payment', b.paymentStatus, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-pink-50 text-pink-800 border border-pink-200">
                        {enumLabel('bookingStatus', b.status, lang)}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        onClick={() => openBookingDetails(b)}
                        className="bg-brand-sand border border-brand-clay/60 text-brand-charcoal px-2.5 py-1 rounded-lg text-xs font-bold hover:bg-brand-clay/40 transition-all cursor-pointer"
                      >
                        {t('View Details', 'عرض التفاصيل')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager
            page={birthdayPager.page}
            totalPages={birthdayPager.totalPages}
            from={birthdayPager.from}
            to={birthdayPager.to}
            total={birthdayPager.total}
            onPage={birthdayPager.setPage}
            noun={t('bookings', 'حجوزات')}
          />
          </>
        )}
      </div>

      {/* =========================================================
          SECTION 4: AWAITING PICKUP FOR 7+ DAYS
          ========================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-50 text-amber-700 rounded-xl">
              <Box className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-lg text-brand-charcoal">{t('Pottery Awaiting Pickup for 7+ Days', 'فخار بانتظار الاستلام منذ 7+ أيام')}</h2>
              <p className="text-xs text-brand-charcoal/60">
                {t('Pieces in "Ready for Pickup" status that have been waiting on storage shelves for 7 days or longer.', 'قطع بحالة «جاهزة للاستلام» ينتظر أصحابها على أرفف التخزين منذ 7 أيام أو أكثر.')}
              </p>
            </div>
          </div>

          <span className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1 rounded-xl">
            {overduePickupPieces.length} {t('items overdue', 'قطع متأخرة')}
          </span>
        </div>

        {overduePickupPieces.length === 0 ? (
          <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/30 rounded-2xl border border-dashed border-brand-clay">
            <CheckCircle2 className="inline h-4 w-4 me-1.5 align-[-3px] text-brand-sage" />
            {t('Excellent! No pottery pieces are currently overdue for collection (7+ days).', 'ممتاز! لا توجد قطع فخار متأخرة حاليًا عن الاستلام (7+ أيام).')}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                  <th className="py-2.5 px-3">{t('Piece Code', 'رمز القطعة')}</th>
                  <th className="py-2.5 px-3">{t('Pottery Item', 'القطعة الفخارية')}</th>
                  <th className="py-2.5 px-3">{t('Customer Name', 'اسم العميل')}</th>
                  <th className="py-2.5 px-3">{t('Contact Phone', 'جوال التواصل')}</th>
                  <th className="py-2.5 px-3">{t('Ready Date', 'تاريخ الجاهزية')}</th>
                  <th className="py-2.5 px-3">{t('Days Waiting', 'أيام الانتظار')}</th>
                  <th className="py-2.5 px-3">{t('Last Reminder', 'آخر تذكير')}</th>
                  <th className="py-2.5 px-3 text-right">{t('Actions', 'الإجراءات')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30 font-medium">
                {overduePager.pageItems.map(p => (
                  <tr key={p.id} className="hover:bg-brand-sand/15 transition-colors">
                    <td className="py-3 px-3 font-mono font-bold text-brand-terracotta">{p.pieceCode || p.id}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2.5">
                        <PieceImage
                          value={p.image}
                          alt={p.name}
                          className="h-9 w-9 rounded-lg object-cover border border-brand-clay shrink-0"
                          fallback={
                            <div className="h-9 w-9 rounded-lg bg-brand-terracotta/10 border border-brand-terracotta/20 flex items-center justify-center text-brand-terracotta shrink-0">
                              <Box className="h-4 w-4" />
                            </div>
                          }
                        />
                        <div>
                          <p className="font-bold text-brand-charcoal">{p.name}</p>
                          <p className="text-[10px] text-brand-charcoal/50">{p.workshopName}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-bold text-brand-charcoal">{p.customerName}</td>
                    <td className="py-3 px-3 font-mono text-brand-charcoal/80">{p.customerPhone}</td>
                    <td className="py-3 px-3 font-mono text-brand-charcoal/70">
                      {p.expectedReadyDate || p.actualReadyDate || p.readyDate || p.dateCreated || todayDateStr}
                    </td>
                    <td className="py-3 px-3">
                      <span className="inline-flex px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                        {p.daysWaiting} {t('days waiting', 'أيام انتظار')}
                      </span>
                    </td>
                    <td className="py-3 px-3 font-mono text-[10px] text-brand-charcoal/60">
                      {p.lastNotificationDate || t('No reminder sent', 'لم يُرسل تذكير')}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleSendReminder(p)}
                          className="bg-brand-sand border border-brand-clay/70 text-brand-charcoal hover:bg-brand-clay/30 px-2.5 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
                        >
                          <Bell className="h-3 w-3 text-amber-600" />
                          <span>{t('Send Reminder', 'إرسال تذكير')}</span>
                        </button>

                        <button
                          onClick={() => handleMarkCollected(p)}
                          className="bg-emerald-600 text-white hover:bg-emerald-700 px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer shadow-2xs"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          <span>{t('Mark Collected', 'تسجيل كمُستلمة')}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager
            page={overduePager.page}
            totalPages={overduePager.totalPages}
            from={overduePager.from}
            to={overduePager.to}
            total={overduePager.total}
            onPage={overduePager.setPage}
            noun={t('pieces', 'قطع')}
          />
          </>
        )}
      </div>

    </div>
  );
};
