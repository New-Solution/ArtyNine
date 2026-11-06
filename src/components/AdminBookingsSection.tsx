/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useApp, getRiyadhNow, parseBookingDateTimeToRiyadhDate, getRiyadhDateString } from '../context/AppContext';
import { 
  Search, Filter, RefreshCw, X, Download, User, Calendar, 
  MapPin, Clock, Edit2, ShieldAlert, Receipt, CheckCircle, ChevronRight, Bell, AlertTriangle
, Phone, Mail } from 'lucide-react';
import { Booking, Workshop } from '../types';
import { resolveBookingInstructor } from '../utils/queueUtils';
import { DateInput } from './DateInput';
import { matchesQuery } from '../utils/search';
import { normalizeDateString } from '../utils/timeUtils';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';
import { PAYMENT_STATUSES, paymentTone } from '../utils/onlinePayments';
import { OnlineRefundNote } from './OnlineRefundNote';

/**
 * The title given to queue walk-ins that have no instructor. It stays English in the
 * data (categorizeBooking, search and the CSV export all read it) and is translated
 * only where it is displayed — see displayTitle.
 */
const WALKIN_NO_INSTRUCTOR_TITLE = 'Walk-in — No Instructor';

export const AdminBookingsSection: React.FC = () => {
  const { 
    bookings, workshops, cancelBooking, updateBookingStatus, queue, updateQueueStatus,
    staff, workshopSessions
  } = useApp();
  const { lang, t } = useLanguage();

  // Search/Filters State
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [paymentFilter, setPaymentFilter] = useState<string>('All');

  // Booking History by Day Filter State
  const [dateFilterMode, setDateFilterMode] = useState<'Today' | 'Yesterday' | 'This Week' | 'All' | 'Custom'>('Today');
  const [customDate, setCustomDate] = useState<string>('');

  // Local state for Notification popover and Cancellation modal
  const [showNotifications, setShowNotifications] = useState(false);
  const [cancellingBookingId, setCancellingBookingId] = useState<string | null>(null);
  const [refundOption, setRefundOption] = useState<'Refunded' | 'NotRefunded'>('Refunded');

  // Local state for CSV Toast
  const [csvToast, setCsvToast] = useState({ show: false, message: '' });

  // 1. Filter out queue walk-ins that do not have matching bookings to avoid duplication
  const processedQueueWalkins = useMemo(() => {
    return queue
      .filter(q => q.source === 'Walk-in')
      .filter(q => !bookings.some(b => b.source === 'Walk-in' && b.customerPhone === q.phone && b.date === q.date));
  }, [queue, bookings]);

  // 2. Map QueueItem to Booking structure
  const mappedQueueWalkins = useMemo(() => {
    return processedQueueWalkins.map((q): Booking => {
      let status: Booking['status'] = 'Pending';
      if (q.status === 'In Progress') {
        status = 'Checked In';
      } else if (q.status === 'Completed') {
        status = 'Completed';
      } else if (q.status === 'Cancelled') {
        status = 'Cancelled';
      }

      return {
        id: q.id,
        customerName: q.name,
        customerEmail: '-',
        customerPhone: q.phone,
        workshopId: q.workshopId || '',
        sessionId: q.sessionId,
        workshopTitle: q.type === 'Without Instructor' ? WALKIN_NO_INSTRUCTOR_TITLE : q.activity,
        date: q.date,
        time: q.checkInTime,
        participants: q.participants,
        totalPrice: 0,
        source: 'Walk-in',
        status,
        paymentStatus: 'Paid',
        createdAt: q.history[0]?.timestamp || new Date().toISOString(),
        timeline: q.history.map(h => ({
          time: new Date(h.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          action: `Checked-in to live queue as ${h.status}`
        }))
      };
    });
  }, [processedQueueWalkins]);

  // 3. Unify them
  const unifiedBookings = useMemo(() => {
    return [...bookings, ...mappedQueueWalkins];
  }, [bookings, mappedQueueWalkins]);

  // Ids of rows synthesized from Live Queue walk-ins rather than real
  // booking rows. Migration 0030 moved queue.id from "Q-XXX" strings to
  // uuids, so a queue-originated row can no longer be told apart from a
  // real booking by its id's shape (id.startsWith('Q-') is now always
  // false) — membership in mappedQueueWalkins is exact regardless of id
  // format.
  const queueWalkinIds = useMemo(
    () => new Set(mappedQueueWalkins.map(m => m.id)),
    [mappedQueueWalkins]
  );

  /**
   * Display text for a booking's title. Only the walk-in title this page synthesizes
   * is translated; every other title is data and is shown exactly as stored.
   */
  const displayTitle = (b: Booking) =>
    queueWalkinIds.has(b.id) && b.workshopTitle === WALKIN_NO_INSTRUCTOR_TITLE
      ? t('Walk-in — No Instructor', 'زيارة مباشرة — بدون مدرب')
      : b.workshopTitle;

  /**
   * Display text for a timeline entry. Only the entries this page synthesizes for queue
   * walk-ins are translated; a stored booking's timeline is shown exactly as recorded.
   */
  const displayTimelineAction = (b: Booking, action: string) => {
    if (!queueWalkinIds.has(b.id)) return action;
    const match = /^Checked-in to live queue as (.+)$/.exec(action);
    return match
      ? `${t('Checked-in to live queue as', 'تم تسجيل الدخول إلى قائمة الانتظار بحالة')} ${enumLabel('bookingStatus', match[1], lang)}`
      : action;
  };

  // Selected booking state (for detail drawer)
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

  // Set default selected booking once list is populated
  useEffect(() => {
    if (!selectedBookingId && unifiedBookings.length > 0) {
      setSelectedBookingId(unifiedBookings[0].id);
    }
  }, [unifiedBookings, selectedBookingId]);

  // Sorting
  const [sortField, setSortField] = useState<'id' | 'customerName' | 'totalPrice'>('id');
  const [sortAsc, setSortAsc] = useState(false);

  // Force local component update every second for live countdown timer
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Helper: check if a booking is actively pending/lapsed (check-in time has begun/passed, and still 'Pending' status)
  const isActivelyPending = (b: Booking) => {
    if (b.status !== 'Pending') return false;
    try {
      const scheduled = parseBookingDateTimeToRiyadhDate(b.date, b.time);
      const nowRiyadh = getRiyadhNow();
      return nowRiyadh >= scheduled;
    } catch (e) {
      return false;
    }
  };

  // List of overdue bookings for notification badge & dropdown
  const overdueBookings = useMemo(() => {
    return bookings.filter(isActivelyPending);
  }, [bookings, tick]);

  // Compute date values
  const todayStr = getRiyadhDateString();
  const yesterdayStr = useMemo(() => {
    const yesterday = new Date(getRiyadhNow().getTime() - 24 * 60 * 60 * 1000);
    return getRiyadhDateString(yesterday);
  }, [tick]);

  // Check if date is in the current calendar week (Sunday - Saturday)
  const isDateInCurrentWeek = (bookingDateStr: string) => {
    try {
      const bDate = parseBookingDateTimeToRiyadhDate(bookingDateStr, '00:00');
      const nowRiyadh = getRiyadhNow();
      
      const currentDay = nowRiyadh.getDay(); // 0 is Sunday, 1 is Monday...
      const startOfWeek = new Date(nowRiyadh);
      startOfWeek.setDate(nowRiyadh.getDate() - currentDay);
      startOfWeek.setHours(0, 0, 0, 0);
      
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);
      
      return bDate >= startOfWeek && bDate <= endOfWeek;
    } catch (e) {
      return false;
    }
  };

  // Active filter count (excluding date filters)
  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (sourceFilter !== 'All') count++;
    if (statusFilter !== 'All') count++;
    if (paymentFilter !== 'All') count++;
    return count;
  }, [sourceFilter, statusFilter, paymentFilter]);

  const clearAllFilters = () => {
    setSearch('');
    setSourceFilter('All');
    setStatusFilter('All');
    setPaymentFilter('All');
    setDateFilterMode('Today');
    setCustomDate('');
  };

  // Filter & Sort Logic
  const processedBookings = useMemo(() => {
    let result = [...unifiedBookings];

    // Search query matches customer name, ID, or workshop title
    if (search.trim()) {
      result = result.filter(b =>
        matchesQuery(
          [b.customerName, b.id, b.workshopTitle, b.customerPhone, b.customerEmail, b.status],
          search
        )
      );
    }

    // Source Filter
    if (sourceFilter !== 'All') {
      result = result.filter(b => b.source === sourceFilter);
    }

    // Status Filter
    if (statusFilter !== 'All') {
      result = result.filter(b => b.status === statusFilter);
    }

    // Payment Filter
    if (paymentFilter !== 'All') {
      result = result.filter(b => b.paymentStatus === paymentFilter);
    }

    // Date History Filters. Booking dates are normalised before comparing:
    // the picker always emits a padded "2026-08-04", while an older record can
    // hold "2026-8-4", and a raw string compare would miss it.
    if (dateFilterMode === 'Today') {
      result = result.filter(b => normalizeDateString(b.date) === normalizeDateString(todayStr));
    } else if (dateFilterMode === 'Yesterday') {
      result = result.filter(b => normalizeDateString(b.date) === normalizeDateString(yesterdayStr));
    } else if (dateFilterMode === 'This Week') {
      result = result.filter(b => isDateInCurrentWeek(b.date));
    } else if (dateFilterMode === 'Custom' && customDate) {
      result = result.filter(b => normalizeDateString(b.date) === normalizeDateString(customDate));
    }

    // Sort order
    result.sort((a, b) => {
      let aVal: any = a[sortField];
      let bVal: any = b[sortField];

      if (sortField === 'totalPrice') {
        return sortAsc ? aVal - bVal : bVal - aVal;
      }
      
      return sortAsc 
        ? String(aVal).localeCompare(String(bVal)) 
        : String(bVal).localeCompare(String(aVal));
    });

    return result;
  }, [unifiedBookings, search, sourceFilter, statusFilter, paymentFilter, dateFilterMode, customDate, sortField, sortAsc, tick]);

  // ---- Pagination over the FILTERED list ----
  const BOOKINGS_PER_PAGE = 10;
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(processedBookings.length / BOOKINGS_PER_PAGE));

  // Any change to search, filters or sorting starts again at page one.
  useEffect(() => {
    setCurrentPage(1);
  }, [search, sourceFilter, statusFilter, paymentFilter, dateFilterMode, customDate, sortField, sortAsc]);

  // Stay in range when the result set shrinks (e.g. a filter removes rows).
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  /** Only this page's rows are rendered — the rest are never mounted. */
  const paginatedBookings = useMemo(() => {
    const start = (currentPage - 1) * BOOKINGS_PER_PAGE;
    return processedBookings.slice(start, start + BOOKINGS_PER_PAGE);
  }, [processedBookings, currentPage]);

  const rangeStart = processedBookings.length === 0 ? 0 : (currentPage - 1) * BOOKINGS_PER_PAGE + 1;
  const rangeEnd = Math.min(currentPage * BOOKINGS_PER_PAGE, processedBookings.length);

  const activeBookingDetail = useMemo(() => {
    return unifiedBookings.find(b => b.id === selectedBookingId) || unifiedBookings[0] || null;
  }, [unifiedBookings, selectedBookingId]);

  // Find booking being cancelled
  const targetCancellingBooking = useMemo(() => {
    return unifiedBookings.find(b => b.id === cancellingBookingId) || null;
  }, [unifiedBookings, cancellingBookingId]);

  // Calculate cancellation eligibility dynamically
  const cancellationRefundDetails = useMemo(() => {
    if (!targetCancellingBooking) return { eligible: false, hoursLeft: 0 };
    if (queueWalkinIds.has(targetCancellingBooking.id)) return { eligible: false, hoursLeft: 0 };
    try {
      const scheduled = parseBookingDateTimeToRiyadhDate(targetCancellingBooking.date, targetCancellingBooking.time);
      const nowRiyadh = getRiyadhNow();
      const diffMs = scheduled.getTime() - nowRiyadh.getTime();
      const hoursLeft = diffMs / (1000 * 60 * 60);
      return {
        eligible: hoursLeft > 24,
        hoursLeft
      };
    } catch (e) {
      return { eligible: false, hoursLeft: 0 };
    }
  }, [targetCancellingBooking, tick, queueWalkinIds]);

  // Handle Cancellation submission from Custom modal
  const handleConfirmCancellation = () => {
    if (!cancellingBookingId) return;
    if (queueWalkinIds.has(cancellingBookingId)) {
      updateQueueStatus(cancellingBookingId, 'Cancelled');
    } else {
      const paymentStatusUpdate = refundOption === 'Refunded' ? 'Refunded' : undefined;
      cancelBooking(cancellingBookingId, 'Staff', paymentStatusUpdate);
    }
    setCancellingBookingId(null);
  };

  // Colors for labels
  const getStatusBadgeStyles = (status: Booking['status']) => {
    switch (status) {
      case 'Pending':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'Checked In':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'Completed':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      case 'Cancelled':
        return 'bg-red-100 text-red-800 border-red-200';
      default:
        return 'bg-amber-100 text-amber-800 border-amber-200';
    }
  };

  const getSourceBadgeStyles = (source: Booking['source']) => {
    switch (source) {
      case 'Website':
        return 'bg-blue-50 text-blue-700 border-blue-100';
      case 'Walk-in':
        return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      default:
        return 'bg-purple-50 text-purple-700 border-purple-100';
    }
  };

  const handleExportCSV = () => {
    if (processedBookings.length === 0) {
      return;
    }

    const headers = [
      "Reference",
      "Customer Name",
      "Phone",
      "Email",
      "Source",
      "Type",
      "Workshop/Event",
      "Date",
      "Time",
      "Participants/Guests",
      "Total (SAR)",
      "Payment Status",
      "Booking Status",
      "Created At"
    ];

    // Helper to escape CSV cell value
    const escapeCSV = (val: any) => {
      if (val === undefined || val === null) return "";
      let str = String(val);
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvRows = [];
    csvRows.push(headers.join(","));

    (processedBookings || []).forEach(b => {
      const typeStr = b.id.startsWith('Q-') ? "Walk-in Queue" : "Reservation";
      const row = [
        b.id,
        b.customerName,
        b.customerPhone,
        b.customerEmail || "-",
        b.source,
        typeStr,
        b.workshopTitle,
        b.date,
        b.id.startsWith('Q-') ? `Check-in: ${b.time}` : b.time,
        b.participants,
        b.id.startsWith('Q-') ? "-" : b.totalPrice,
        b.id.startsWith('Q-') ? "-" : b.paymentStatus,
        b.status,
        b.createdAt ? b.createdAt : "-"
      ];
      csvRows.push(row.map(escapeCSV).join(","));
    });

    const csvContent = csvRows.join("\n");
    
    let dateRange = 'all-history';
    if (dateFilterMode === 'Today') {
      dateRange = todayStr;
    } else if (dateFilterMode === 'Yesterday') {
      dateRange = yesterdayStr;
    } else if (dateFilterMode === 'This Week') {
      dateRange = 'this-week';
    } else if (dateFilterMode === 'Custom' && customDate) {
      dateRange = customDate;
    }
    const filename = `arty-cafe-bookings-${dateRange}.csv`;

    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setCsvToast({ show: true, message: t(`Successfully exported ${processedBookings.length} rows to ${filename}`, `تم تصدير ${processedBookings.length} صفًا إلى ${filename}`) });
    setTimeout(() => setCsvToast({ show: false, message: '' }), 4000);
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 text-left bg-brand-cream min-h-full relative overflow-hidden">
      
      {/* Header and top triggers */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-brand-clay/30 pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-brand-charcoal flex items-center gap-3">
            <span>{t('Bookings Ledger', 'سجل الحجوزات')}</span>
            {/* Notification Bell for Overdue Bookings */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowNotifications(!showNotifications)}
                className={`p-2 rounded-xl border transition-all relative cursor-pointer ${
                  overdueBookings.length > 0 
                    ? 'bg-amber-50 border-amber-300 text-amber-600 hover:bg-amber-100 animate-bounce-subtle' 
                    : 'bg-white border-brand-clay/60 text-brand-charcoal/50 hover:bg-brand-sand/50'
                }`}
                title={t('Guest No-Show Staff Alerts', 'تنبيهات الموظفين لغياب الضيوف')}
              >
                <Bell className="h-4.5 w-4.5" />
                {overdueBookings.length > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 bg-red-600 text-[9px] text-white font-bold rounded-full flex items-center justify-center animate-pulse">
                    {overdueBookings.length}
                  </span>
                )}
              </button>

              {/* Notification Dropdown Popover */}
              {showNotifications && (
                <div className="absolute left-0 mt-2 w-80 bg-white border border-brand-clay rounded-2xl shadow-2xl z-40 p-4 space-y-3 text-brand-charcoal animate-in fade-in duration-150">
                  <div className="flex justify-between items-center border-b border-brand-clay/40 pb-2">
                    <span className="text-xs font-extrabold text-brand-charcoal flex items-center gap-1.5">
                      <ShieldAlert className="h-4 w-4 text-amber-500" />
                      {t('No-Show Alert Queue', 'قائمة تنبيهات الغياب')}
                    </span>
                    <button 
                      onClick={() => setShowNotifications(false)}
                      className="p-1 hover:bg-brand-sand rounded-lg text-brand-charcoal/40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {overdueBookings.length === 0 ? (
                    <p className="text-xs text-brand-charcoal/50 py-3 text-center">{t('No overdue bookings. All guests checked in or on time.', 'لا توجد حجوزات متأخرة. جميع الضيوف سجّلوا حضورهم أو وصلوا في الوقت.')}</p>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {overdueBookings.map(b => {
                        const bTime = parseBookingDateTimeToRiyadhDate(b.date, b.time);
                        const remMs = (15 * 60 * 1000) - (getRiyadhNow().getTime() - bTime.getTime());
                        return (
                          <div
                            key={b.id}
                            className="p-2.5 rounded-xl border border-amber-200 bg-amber-50/40 hover:bg-amber-50 text-left space-y-1.5 transition-colors"
                          >
                            <div
                              onClick={() => {
                                setSelectedBookingId(b.id);
                                setShowNotifications(false);
                              }}
                              className="cursor-pointer space-y-1"
                            >
                              <div className="flex justify-between font-mono font-bold text-[10px] text-brand-terracotta">
                                <span>{b.id}</span>
                                {remMs > 0 ? (
                                  <span className="text-red-600 animate-pulse">
                                    {t('Auto-cancel', 'إلغاء تلقائي')}: {String(Math.floor(remMs / 60000)).padStart(2, '0')}:{String(Math.floor((remMs % 60000) / 1000)).padStart(2, '0')}
                                  </span>
                                ) : (
                                  <span className="text-red-600 animate-pulse">{t('Cancelling...', 'جارٍ الإلغاء...')}</span>
                                )}
                              </div>
                              <p className="text-xs font-bold text-brand-charcoal">{b.customerName}</p>
                              <p className="text-[10px] text-brand-charcoal/60">{t('Scheduled', 'الموعد')}: {b.time} ({displayTitle(b)})</p>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCancellingBookingId(b.id);
                                if (queueWalkinIds.has(b.id)) {
                                  setRefundOption('NotRefunded');
                                } else {
                                  setRefundOption(cancellationRefundDetails.eligible ? 'Refunded' : 'NotRefunded');
                                }
                                setShowNotifications(false);
                              }}
                              className="cursor-pointer w-full bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 text-[10px] font-bold py-1.5 rounded-lg transition-colors text-center"
                            >
                              {t('Cancel Booking', 'إلغاء الحجز')}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </h1>
          <p className="text-xs text-brand-charcoal/60 mt-1">{t('Audit guest reservations, take POS payments, and manage check-in status updates.', 'راجع حجوزات الضيوف، واستلم المدفوعات، وأدِر تحديثات تسجيل الحضور.')}</p>
        </div>
      </div>

      {/* Persistent Staff Warning for overdue bookings */}
      {overdueBookings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 text-brand-charcoal animate-in fade-in slide-in-from-top-4 duration-300">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5 animate-pulse" />
          <div className="space-y-1">
            <h4 className="text-xs font-extrabold text-amber-800">{t(`Action Required: ${overdueBookings.length} Overdue Booking No-Shows`, `مطلوب إجراء: ${overdueBookings.length} حجوزات متأخرة لم يحضر أصحابها`)}</h4>
            <p className="text-xs text-amber-700/85">
              {t('These customers have missed their scheduled check-in window. Staff can manually cancel them or check them in now. Unresolved bookings automatically cancel 15 minutes past check-in time.', 'فات هؤلاء العملاء موعد تسجيل الحضور. يمكن للموظفين إلغاء الحجز يدويًا أو تسجيل حضورهم الآن. تُلغى الحجوزات غير المعالجة تلقائيًا بعد 15 دقيقة من موعد الحضور.')}
            </p>
          </div>
        </div>
      )}

      {/* Filter Row Card */}
      <div className="bg-white border border-brand-clay/70 rounded-2xl p-4 shadow-2xs space-y-3">
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          
          {/* Quick search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/40" />
            <input
              type="text"
              placeholder={t('Search reference, guest name...', 'ابحث بالمرجع أو اسم الضيف...')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-brand-cream/40 border border-brand-clay/60 rounded-xl py-2 pl-9 pr-3 text-xs font-semibold text-brand-charcoal placeholder-brand-charcoal/45 focus:outline-none focus:border-brand-terracotta"
            />
          </div>

          {/* Source Dropdown - only Website and Walk-in remain */}
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            className="bg-brand-cream/40 border border-brand-clay/60 rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal cursor-pointer focus:outline-none focus:border-brand-terracotta"
          >
            <option value="All">{t('All Booking Sources', 'كل مصادر الحجز')}</option>
            <option value="Website">{enumLabel('source', 'Website', lang)}</option>
            <option value="Walk-in">{enumLabel('source', 'Walk-in', lang)}</option>
          </select>

          {/* Status Dropdown - remaining 4 statuses */}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="bg-brand-cream/40 border border-brand-clay/60 rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal cursor-pointer focus:outline-none focus:border-brand-terracotta"
          >
            <option value="All">{t('All Seating Statuses', 'كل حالات الحضور')}</option>
            <option value="Pending">{enumLabel('bookingStatus', 'Pending', lang)}</option>
            <option value="Checked In">{enumLabel('bookingStatus', 'Checked In', lang)}</option>
            <option value="Completed">{enumLabel('bookingStatus', 'Completed', lang)}</option>
            <option value="Cancelled">{enumLabel('bookingStatus', 'Cancelled', lang)}</option>
          </select>

          {/* Payment Status Dropdown - including Refunded */}
          <select
            value={paymentFilter}
            onChange={e => setPaymentFilter(e.target.value)}
            className="bg-brand-cream/40 border border-brand-clay/60 rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal cursor-pointer focus:outline-none focus:border-brand-terracotta"
          >
            <option value="All">{t('All Payment Statuses', 'كل حالات الدفع')}</option>
            {PAYMENT_STATUSES.map(status => (
              <option key={status} value={status}>{enumLabel('payment', status, lang)}</option>
            ))}
          </select>

        </div>

        {/* Clear active filters chip bar */}
        {activeFiltersCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-brand-clay/40 text-xs font-semibold text-brand-charcoal">
            <span className="text-brand-charcoal/60">{t('Active Filters:', 'عوامل التصفية النشطة:')}</span>
            {sourceFilter !== 'All' && (
              <span className="inline-flex items-center gap-1 bg-brand-sand px-2.5 py-1 rounded-lg border border-brand-clay">
                <span>{t('Source', 'المصدر')}: {enumLabel('source', sourceFilter, lang)}</span>
                <X className="h-3 w-3 hover:text-brand-terracotta cursor-pointer" onClick={() => setSourceFilter('All')} />
              </span>
            )}
            {statusFilter !== 'All' && (
              <span className="inline-flex items-center gap-1 bg-brand-sand px-2.5 py-1 rounded-lg border border-brand-clay">
                <span>{t('Status', 'الحالة')}: {enumLabel('bookingStatus', statusFilter, lang)}</span>
                <X className="h-3 w-3 hover:text-brand-terracotta cursor-pointer" onClick={() => setStatusFilter('All')} />
              </span>
            )}
            {paymentFilter !== 'All' && (
              <span className="inline-flex items-center gap-1 bg-brand-sand px-2.5 py-1 rounded-lg border border-brand-clay">
                <span>{t('Payment', 'الدفع')}: {enumLabel('payment', paymentFilter, lang)}</span>
                <X className="h-3 w-3 hover:text-brand-terracotta cursor-pointer" onClick={() => setPaymentFilter('All')} />
              </span>
            )}
            <button
              onClick={clearAllFilters}
              className="text-xs font-bold text-brand-terracotta hover:underline ml-1 cursor-pointer flex items-center gap-1"
            >
              <RefreshCw className="h-3 w-3" />
              <span>{t('Clear all', 'مسح الكل')}</span>
            </button>
          </div>
        )}

      </div>

      {/* Main Area: Split between bookings table and detail drawer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* DATA TABLE COLUMN */}
        <div className="lg:col-span-8 bg-white border border-brand-clay/70 rounded-2xl shadow-2xs overflow-hidden">
          
          {/* Day Scoping & History Picker shortcuts */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 p-4 bg-brand-cream/30 border-b border-brand-clay/60">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-extrabold text-brand-charcoal/60 uppercase tracking-widest mr-1.5">{t('Day Scope:', 'نطاق اليوم:')}</span>
              {(['Today', 'Yesterday', 'This Week', 'All'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setDateFilterMode(mode);
                    setCustomDate('');
                  }}
                  className={`cursor-pointer px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                    dateFilterMode === mode && !customDate
                      ? 'bg-brand-terracotta text-brand-cream shadow-xs'
                      : 'bg-white border border-brand-clay/50 text-brand-charcoal hover:bg-brand-sand'
                  }`}
                >
                  {mode === 'All' ? t('All History', 'كل السجل') : enumLabel('dateScope', mode, lang)}
                </button>
              ))}
            </div>
            
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-extrabold text-brand-charcoal/60 uppercase tracking-widest">{t('Picker:', 'اختيار:')}</span>
              <DateInput
                value={customDate}
                onChange={e => {
                setCustomDate(e.target.value);
                setDateFilterMode('Custom');
                }}
                className="bg-white border border-brand-clay/60 rounded-xl py-1.5 px-3 text-xs font-semibold text-brand-charcoal cursor-pointer focus:outline-none focus:border-brand-terracotta"
              />
            </div>
          </div>

          <div className="p-4 border-b border-brand-clay/60 flex justify-between items-center bg-brand-cream/10">
            <span className="text-xs font-bold text-brand-charcoal">
              {t(`Showing ${processedBookings.length} of ${unifiedBookings.length} entries`, `عرض ${processedBookings.length} من ${unifiedBookings.length} سجل`)}
            </span>
            <button
              disabled={processedBookings.length === 0}
              onClick={handleExportCSV}
              className={`inline-flex items-center gap-1 border text-xs font-bold px-3 py-1.5 rounded-xl transition-all ${
                processedBookings.length === 0
                  ? 'bg-brand-sand/30 text-brand-charcoal/30 border-brand-clay/35 cursor-not-allowed'
                  : 'bg-brand-cream border-brand-clay hover:bg-brand-sand text-brand-charcoal cursor-pointer'
              }`}
              title={processedBookings.length === 0 ? t('No records to export', 'لا توجد سجلات للتصدير') : t('Export current visible entries to CSV', 'تصدير السجلات المعروضة حاليًا إلى CSV')}
            >
              <Download className="h-3.5 w-3.5" />
              <span>{processedBookings.length === 0 ? t('No Rows to Export', 'لا توجد صفوف للتصدير') : t('Export CSV', 'تصدير CSV')}</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-brand-cream/40 border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-semibold">
                  <th className="p-4 cursor-pointer hover:text-brand-terracotta" onClick={() => { setSortField('id'); setSortAsc(!sortAsc); }}>
                    {t('Reference', 'المرجع')} {sortField === 'id' && (sortAsc ? '▲' : '▼')}
                  </th>
                  <th className="p-4 cursor-pointer hover:text-brand-terracotta" onClick={() => { setSortField('customerName'); setSortAsc(!sortAsc); }}>
                    {t('Guest', 'الضيف')} {sortField === 'customerName' && (sortAsc ? '▲' : '▼')}
                  </th>
                  <th className="p-4">{t('Workshop', 'الورشة')}</th>
                  <th className="p-4">{t('Date & Time', 'التاريخ والوقت')}</th>
                  <th className="p-4 text-center">{t('Artists', 'الفنانون')}</th>
                  <th className="p-4 text-right cursor-pointer hover:text-brand-terracotta" onClick={() => { setSortField('totalPrice'); setSortAsc(!sortAsc); }}>
                    {t('Total', 'الإجمالي')} {sortField === 'totalPrice' && (sortAsc ? '▲' : '▼')}
                  </th>
                  <th className="p-4">{t('Status', 'الحالة')}</th>
                  <th className="p-4">{t('Payment', 'الدفع')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30">
                {processedBookings.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-10 text-center text-xs text-brand-charcoal/50 font-bold bg-white">
                      {t('No bookings found for the selected scope/filters.', 'لا توجد حجوزات ضمن النطاق أو عوامل التصفية المحددة.')}
                    </td>
                  </tr>
                ) : (
                  paginatedBookings.map((b) => {
                    const isSelected = selectedBookingId === b.id;
                    // Never true for a mapped queue walk-in: its "time" is a
                    // check-in timestamp, not a scheduled workshop start, so
                    // isActivelyPending would misread "just checked in" as
                    // overdue within seconds — no real auto-cancel applies to
                    // a queue-only row, so this must never fire for one.
                    const isLate = !queueWalkinIds.has(b.id) && isActivelyPending(b);
                    return (
                      <tr
                        key={b.id}
                        onClick={() => setSelectedBookingId(b.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected 
                            ? 'bg-brand-sand/50 border-l-4 border-brand-terracotta' 
                            : isLate 
                              ? 'bg-amber-50/70 hover:bg-amber-100/70 border-l-4 border-amber-500 animate-pulse-subtle'
                              : 'hover:bg-brand-sand/15'
                        }`}
                      >
                        <td className="p-4 font-mono font-bold text-brand-terracotta">
                          <div className="flex items-center gap-1.5">
                            {isLate && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 animate-pulse shrink-0" />}
                            <span>{b.id}</span>
                          </div>
                        </td>
                        <td className="p-4 text-left font-bold text-brand-charcoal">
                          <div>{b.customerName}</div>
                          <div className="text-[10px] text-brand-charcoal/40 mt-0.5">{b.customerPhone}</div>
                        </td>
                        <td className="p-4 font-semibold line-clamp-1 max-w-[140px] mt-2 block border-none">{displayTitle(b)}</td>
                        <td className="p-4 font-semibold">
                          <div>{b.date}</div> 
                          <span className="text-[10px] text-brand-charcoal/50 block font-normal">
                            {b.id.startsWith('Q-') ? `${t('Check-in', 'تسجيل الحضور')}: ${b.time}` : b.time}
                          </span>
                        </td>
                        <td className="p-4 text-center font-bold">{b.participants}</td>
                        <td className="p-4 text-right font-bold text-brand-charcoal">
                          {b.id.startsWith('Q-') ? '-' : `${b.totalPrice} ${t('SAR', 'ريال')}`}
                        </td>
                        <td className="p-4">
                          <div className="space-y-1">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border ${getStatusBadgeStyles(b.status)}`}>
                              {enumLabel('bookingStatus', b.status, lang)}
                            </span>
                            
                            {/* Render live countdown timers for actively pending bookings */}
                            {isLate && (() => {
                              try {
                                const bTime = parseBookingDateTimeToRiyadhDate(b.date, b.time);
                                const remMs = (15 * 60 * 1000) - (getRiyadhNow().getTime() - bTime.getTime());
                                if (remMs > 0) {
                                  const m = Math.floor(remMs / 60000);
                                  const s = Math.floor((remMs % 60000) / 1000);
                                  return (
                                    <div className="text-[9px] text-red-600 font-extrabold animate-pulse flex items-center gap-0.5 whitespace-nowrap">
                                      <Clock className="h-2.5 w-2.5 shrink-0" />
                                      {t('Auto-cancel', 'إلغاء تلقائي')}: {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
                                    </div>
                                  );
                                }
                                return <div className="text-[9px] text-red-600 font-extrabold animate-pulse">{t('Cancelling...', 'جارٍ الإلغاء...')}</div>;
                              } catch (e) {
                                return null;
                              }
                            })()}
                          </div>
                        </td>
                        <td className="p-4">
                          {b.id.startsWith('Q-') ? (
                            <span className="inline-flex px-2.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-500 border border-gray-200">
                              -
                            </span>
                          ) : (
                            <span className={`inline-flex px-2.5 py-0.5 rounded text-[10px] font-bold ${
                              {
                                paid: 'bg-green-100 text-green-800',
                                refunded: 'bg-blue-100 text-blue-800 border border-blue-200',
                                waiting: 'bg-amber-100 text-amber-800 border border-amber-200',
                                closed: 'bg-gray-100 text-gray-500 border border-gray-200',
                                attention: 'bg-red-100 text-red-800 animate-pulse',
                                unpaid: 'bg-red-100 text-red-800 animate-pulse'
                              }[paymentTone(b.paymentStatus)]
                            }`}>
                              {enumLabel('payment', b.paymentStatus, lang)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer — driven by the filtered result set */}
          <div className="p-4 border-t border-brand-clay/60 flex flex-col sm:flex-row justify-between items-center gap-3 bg-brand-cream/10">
            <span className="text-xs text-brand-charcoal/60 font-semibold">
              {processedBookings.length === 0
                ? t('No entries', 'لا توجد سجلات')
                : t(`Showing ${rangeStart}\u2013${rangeEnd} of ${processedBookings.length}`, `عرض ${rangeStart}\u2013${rangeEnd} من ${processedBookings.length}`)}
            </span>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                  currentPage <= 1
                    ? 'bg-brand-sand/50 text-brand-charcoal/35 border-brand-clay/40 cursor-not-allowed'
                    : 'bg-white text-brand-charcoal border-brand-clay hover:bg-brand-sand cursor-pointer'
                }`}
              >
                {t('Previous', 'السابق')}
              </button>

              <span className="text-xs font-bold text-brand-charcoal/70">
                {t(`Page ${currentPage} of ${totalPages}`, `صفحة ${currentPage} من ${totalPages}`)}
              </span>

              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                  currentPage >= totalPages
                    ? 'bg-brand-sand/50 text-brand-charcoal/35 border-brand-clay/40 cursor-not-allowed'
                    : 'bg-white text-brand-charcoal border-brand-clay hover:bg-brand-sand cursor-pointer'
                }`}
              >
                {t('Next', 'التالي')}
              </button>
            </div>
          </div>

        </div>

        {/* DETAILS DRAWER COLUMN - RIGHT COLUMN */}
        <div className="lg:col-span-4 bg-white border border-brand-clay/70 rounded-2xl p-5 shadow-2xs text-left space-y-6">
          {activeBookingDetail ? (
            <div className="space-y-6 animate-in fade-in duration-300">
              
              {/* Header Title block */}
              <div className="flex justify-between items-start border-b border-brand-clay/50 pb-4">
                <div>
                  <span className="text-[10px] font-bold text-brand-sage uppercase tracking-wider block">{t('RESERVATION DETAILS', 'تفاصيل الحجز')}</span>
                  <h3 className="font-display text-xl font-bold text-brand-charcoal font-mono tracking-wide">{activeBookingDetail.id}</h3>
                </div>
                <span className={`inline-flex rounded-lg px-2 py-1 text-xs font-bold border ${getSourceBadgeStyles(activeBookingDetail.source)}`}>
                  {enumLabel('source', activeBookingDetail.source, lang)}
                </span>
              </div>

              {/* Guest Profile card */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-brand-charcoal uppercase tracking-widest text-brand-sage">{t('Customer Info', 'بيانات العميل')}</h4>
                <div className="p-3 bg-brand-sand/30 rounded-xl border border-brand-clay/40 space-y-2">
                  <p className="text-sm font-bold text-brand-charcoal">{activeBookingDetail.customerName}</p>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-brand-charcoal/70">
                    <Phone className="h-3.5 w-3.5 text-brand-charcoal/45" />
                    <span>{activeBookingDetail.customerPhone}</span>
                  </p>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-brand-charcoal/70">
                    <Mail className="h-3.5 w-3.5 text-brand-charcoal/45" />
                    <span>{activeBookingDetail.customerEmail}</span>
                  </p>
                </div>
              </div>

              {/* Booking metadata facts */}
              <div className="space-y-2 text-xs text-brand-charcoal/80">
                <div className="flex justify-between">
                  <span className="font-semibold text-brand-charcoal/50">{t('Workshop Type', 'نوع الورشة')}</span>
                  <span className="font-bold">{displayTitle(activeBookingDetail)}</span>
                </div>
                {/* Tutor resolved through the booked session, so it matches the
                    Live Queue, the workshop session and the staff calendar. */}
                <div className="flex justify-between">
                  <span className="font-semibold text-brand-charcoal/50">{t('Tutor', 'المدرّب')}</span>
                  <span className="font-bold">
                    {resolveBookingInstructor(activeBookingDetail as Booking, { staff, workshopSessions }).name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-brand-charcoal/50">{t('Scheduled Slot', 'الموعد المحدد')}</span>
                  <span className="font-bold">
                    {activeBookingDetail.id.startsWith('Q-') ? `${activeBookingDetail.date} (${t('Walk-in', 'زيارة مباشرة')})` : `${activeBookingDetail.date} ${t('at', 'الساعة')} ${activeBookingDetail.time}`}
                  </span>
                </div>
                {activeBookingDetail.id.startsWith('Q-') && (
                  <div className="flex justify-between">
                    <span className="font-semibold text-brand-charcoal/50">{t('Check-In Time', 'وقت تسجيل الحضور')}</span>
                    <span className="font-bold">{activeBookingDetail.time}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="font-semibold text-brand-charcoal/50">{t('Attendees', 'الحضور')}</span>
                  <span className="font-bold">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{activeBookingDetail.participants} {t('Artists', 'فنانين')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-semibold text-brand-charcoal/50">{t('Total Payment', 'إجمالي المدفوع')}</span>
                  <span className="font-bold text-brand-terracotta">
                    {activeBookingDetail.id.startsWith('Q-') ? '-' : `${activeBookingDetail.totalPrice} ${t('SAR', 'ريال')}`}
                  </span>
                </div>
              </div>

              {/* Interactive Status Actions */}
              <div className="pt-4 border-t border-brand-clay/50 space-y-3">
                <h4 className="text-xs font-bold text-brand-charcoal uppercase tracking-widest text-brand-sage">{t('Modify Booking', 'تعديل الحجز')}</h4>

                {/* Cancel Booking button - opens Custom Cancellation Modal */}
                <button
                  disabled={activeBookingDetail.status === 'Cancelled'}
                  onClick={() => {
                    setCancellingBookingId(activeBookingDetail.id);
                    if (queueWalkinIds.has(activeBookingDetail.id)) {
                      setRefundOption('NotRefunded');
                    } else {
                      setRefundOption(cancellationRefundDetails.eligible ? 'Refunded' : 'NotRefunded');
                    }
                  }}
                  className="cursor-pointer w-full bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold py-2.5 rounded-xl transition-colors text-center block"
                >
                  {t('Cancel Booking', 'إلغاء الحجز')}
                </button>
              </div>

              {/* Status History Timeline */}
              <div className="pt-4 border-t border-brand-clay/50 space-y-3">
                <h4 className="text-xs font-bold text-brand-charcoal uppercase tracking-widest text-brand-sage">{t('Status History Timeline', 'سجل تغيّر الحالة')}</h4>
                <div className="space-y-3 relative pl-4 border-l border-brand-clay">
                  {activeBookingDetail.timeline.map((log, idx) => (
                    <div key={idx} className="relative text-xs">
                      {/* Node circle */}
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-brand-terracotta border border-brand-cream"></span>
                      <p className="font-bold text-brand-charcoal">{displayTimelineAction(activeBookingDetail, log.action)}</p>
                      <p className="text-[10px] text-brand-charcoal/40 font-semibold">{log.time}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Internal Notes area */}
              <div className="pt-4 border-t border-brand-clay/50 space-y-2">
                <label className="text-xs font-bold text-brand-charcoal/60 uppercase block">{t('Internal Staff Notes', 'ملاحظات الموظفين الداخلية')}</label>
                <textarea
                  placeholder={t('Add secret instructions or pottery wheel seating requests...', 'أضف تعليمات خاصة أو طلبات الجلوس على عجلة الفخار...')}
                  defaultValue={activeBookingDetail.notes || ''}
                  className="w-full bg-brand-sand/30 border border-brand-clay rounded-xl p-2.5 text-xs text-brand-charcoal placeholder-brand-charcoal/40 focus:outline-none focus:border-brand-terracotta"
                  rows={3}
                />
              </div>

            </div>
          ) : (
            <p className="text-xs text-brand-charcoal/50 text-center py-10 font-bold">{t('Select a row to see details drawer', 'اختر صفًا لعرض التفاصيل')}</p>
          )}
        </div>

      </div>

      {/* CUSTOM CONFIRMATION CANCELLATION MODAL */}
      {cancellingBookingId && targetCancellingBooking && (
        <div className="fixed inset-0 bg-brand-charcoal/65 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-brand-cream border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-md w-full text-left space-y-6 animate-in zoom-in-95 duration-200 text-brand-charcoal">
            
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <h3 className="font-display text-lg font-extrabold text-brand-charcoal flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-600" />
                <span>{t('Confirm Cancel Booking', 'تأكيد إلغاء الحجز')}</span>
              </h3>
              <button 
                onClick={() => setCancellingBookingId(null)}
                className="p-1 rounded-lg text-brand-charcoal hover:bg-brand-sand cursor-pointer focus:outline-none"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="bg-brand-sand/30 border border-brand-clay/40 rounded-xl p-3 text-xs space-y-1.5">
                <p><strong>{t('Booking Reference', 'مرجع الحجز')}:</strong> {targetCancellingBooking.id}</p>
                <p><strong>{t('Guest', 'الضيف')}:</strong> {targetCancellingBooking.customerName}</p>
                <p><strong>{t('Workshop', 'الورشة')}:</strong> {displayTitle(targetCancellingBooking)}</p>
                <p><strong>{t('Scheduled Slot', 'الموعد المحدد')}:</strong> {targetCancellingBooking.date} {t('at', 'الساعة')} {targetCancellingBooking.time}</p>
              </div>

              {/* Refund Rules Display */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-brand-charcoal/60 uppercase">{t('Refund Eligibility Rules', 'قواعد أهلية الاسترداد')}</label>
                {cancellationRefundDetails.eligible ? (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2 text-emerald-800">
                    <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="text-xs">
                      <p className="font-bold">{t('Full Refund Due (On-Time Cancel)', 'استرداد كامل مستحق (إلغاء في الوقت)')}</p>
                      <p className="text-[10px] mt-0.5">{t(`Cancellation is made ${cancellationRefundDetails.hoursLeft.toFixed(1)} hours in advance (more than 24-hour threshold).`, `يتم الإلغاء قبل ${cancellationRefundDetails.hoursLeft.toFixed(1)} ساعة من الموعد (أكثر من حد 24 ساعة).`)}</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2 text-red-800">
                    <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                    <div className="text-xs">
                      <p className="font-bold">{t('No Refund Applicable (Late Cancel)', 'لا ينطبق استرداد (إلغاء متأخر)')}</p>
                      <p className="text-[10px] mt-0.5">{cancellationRefundDetails.hoursLeft > 0
                        ? t(`Cancellation is within ${cancellationRefundDetails.hoursLeft.toFixed(1)} hours of scheduled start time (less than 24-hour threshold).`, `الإلغاء خلال ${cancellationRefundDetails.hoursLeft.toFixed(1)} ساعة من موعد البدء (أقل من حد 24 ساعة).`)
                        : t('Cancellation is within after scheduled start time (less than 24-hour threshold).', 'الإلغاء بعد موعد البدء (أقل من حد 24 ساعة).')}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Refund Action Selector */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-brand-charcoal/70 block">{t('Select Payment Action outcome:', 'اختر نتيجة إجراء الدفع:')}</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRefundOption('Refunded')}
                    className={`cursor-pointer p-3 rounded-xl border text-xs font-bold transition-all text-center flex flex-col items-center justify-center gap-1 ${
                      refundOption === 'Refunded'
                        ? 'bg-blue-50 border-blue-400 text-blue-700 ring-2 ring-blue-300'
                        : 'bg-white border-brand-clay/60 hover:bg-brand-sand/50'
                    }`}
                  >
                    <span>{t('Mark as Refunded', 'تسجيل كمسترد')}</span>
                    <span className="text-[9px] font-normal opacity-85">{t('Reverts payment as Refunded', 'يعيد حالة الدفع إلى مسترد')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRefundOption('NotRefunded')}
                    className={`cursor-pointer p-3 rounded-xl border text-xs font-bold transition-all text-center flex flex-col items-center justify-center gap-1 ${
                      refundOption === 'NotRefunded'
                        ? 'bg-amber-50 border-amber-400 text-amber-800 ring-2 ring-amber-300'
                        : 'bg-white border-brand-clay/60 hover:bg-brand-sand/50'
                    }`}
                  >
                    <span>{t('Mark as Not Refunded', 'تسجيل كغير مسترد')}</span>
                    <span className="text-[9px] font-normal opacity-85">{t('No refund issued — payment stays as recorded', 'لم يتم إصدار استرداد — يبقى الدفع كما هو مسجل')}</span>
                  </button>
                </div>
              </div>

              <OnlineRefundNote booking={bookings.find(b => b.id === cancellingBookingId)} />

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCancellingBookingId(null)}
                  className="cursor-pointer flex-1 bg-white border border-brand-clay hover:bg-brand-sand py-3 text-xs font-bold rounded-xl transition-colors text-center"
                >
                  {t('Keep Booking (Go Back)', 'إبقاء الحجز (رجوع)')}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmCancellation}
                  className="cursor-pointer flex-1 bg-red-600 text-white hover:bg-red-700 py-3 text-xs font-bold rounded-xl transition-colors text-center shadow-md"
                >
                  {t('Cancel Booking', 'إلغاء الحجز')}
                </button>
              </div>

            </div>

          </div>
        </div>
      )}

      {/* CSV Success Toast */}
      {csvToast.show && (
        <div className="fixed bottom-6 right-6 bg-brand-charcoal text-brand-cream px-4 py-3 rounded-xl shadow-xl z-50 flex items-center gap-2 border border-brand-clay animate-in slide-in-from-bottom-2 fade-in duration-300">
          <CheckCircle className="h-4.5 w-4.5 text-emerald-400" />
          <span className="text-xs font-bold">{csvToast.message}</span>
        </div>
      )}

    </div>
  );
};
