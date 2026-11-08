import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { checkStaffMemberAvailability } from '../utils/staffAvailabilityUtils';
import { BirthdayPackage, DEFAULT_CAKE_SIZES } from '../types';
import { formatDateTime } from '../utils/calendarConfig';
import {
  Sparkles, Search, Filter, CheckCircle2, Package, Users, Phone, X, ShieldAlert, Plus,
  Trash2, Download
} from 'lucide-react';
import { matchesQuery } from '../utils/search';
import { AdminBirthdayPackageEditor } from './AdminBirthdayPackageEditor';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';
import { paymentTone } from '../utils/onlinePayments';
import { OnlineRefundNote } from './OnlineRefundNote';
import { PaymentAmountsCell, PaymentAmountsDetails } from './PaymentAmounts';
import { paymentBreakdown } from '../utils/onlinePayments';

/** One label/value line. Optional answers are shown as "Not provided", never dropped. */
const DetailRow: React.FC<{ label: string; value?: string; mono?: boolean }> = ({ label, value, mono }) => {
  const { t } = useLanguage();
  return (
    <div className="flex justify-between gap-3 border-b border-brand-clay/25 last:border-b-0 py-1">
      <span className="text-brand-charcoal/60 font-semibold">{label}</span>
      <span className={`font-bold text-brand-charcoal text-right ${mono ? 'font-mono' : ''}`}>
        {value ? value : <span className="text-brand-charcoal/30 italic font-normal">{t('Not provided', 'غير مُقدَّم')}</span>}
      </span>
    </div>
  );
};

export const AdminEventsSection: React.FC = () => {
  const {
    cancelBooking,
    selectedEventBookingId,
    setSelectedEventBookingId,
    birthdayPackages,
    addBirthdayPackage,
    updateBirthdayPackage,
    deleteBirthdayPackage,
    assignBookingStaff,
    staff,
    workshopSessions,
    workshops,
    events,
    queue,
    // Already provided by the shared data layer.
    bookings: liveBookings
  } = useApp();
  const { lang, t } = useLanguage();

  // Toast message state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  /**
   * Which package is open in the editor, if any.
   *
   * The draft used to live here as a map keyed by package id, kept in step with
   * the records by an effect. That is what tied editing to the list: reordering
   * or adding a package re-ran the sync while a half-finished draft — including
   * a freshly uploaded photo that had not been saved yet — was still in it. The
   * editor owns its own draft now, so the two cannot interfere.
   */
  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);
  const editingPackage = useMemo(
    () => (editingPackageId ? birthdayPackages.find(p => p.id === editingPackageId) || null : null),
    [editingPackageId, birthdayPackages]
  );

  /** Writes to the one shared record the customer site reads from. */
  const handleSavePackage = async (id: string, updates: Partial<BirthdayPackage>) => {
    await updateBirthdayPackage(id, updates);
    showToast(t(`"${updates.name || 'Package'}" saved. The customer site now shows these details.`, `تم حفظ "${updates.name || 'الباقة'}". يعرض موقع العملاء هذه التفاصيل الآن.`));
    setEditingPackageId(null);
  };

  const handleAddPackage = async () => {
    await addBirthdayPackage({
      name: 'New Birthday Package',
      image: '',
      shortDescription: '',
      fullDescription: '',
      price: 0,
      // Defaults for a newly created package. Existing packages keep whatever
      // is stored on them and are edited in the package editor.
      pricingType: 'Per person',
      pricingLabel: 'Per person',
      duration: '2 Hours',
      minGuests: 1,
      maxGuests: 20,
      ageInformation: '',
      includedItems: [],
      activityChoices: [],
      additionalInfo: [],
      cakeDescription: '',
      cakeSizes: DEFAULT_CAKE_SIZES.map(size => ({ ...size })),
      trainerInfo: '',
      deliveryInfo: '',
      availableDays: [],
      availableTimes: [],
      terms: '',
      customerNotes: '',
      depositAmount: 500,
      // New packages start hidden until staff publish them.
      status: 'Draft',
      displayOrder: birthdayPackages.length
    });
    showToast(t('Package created as Draft. Publish it when the details are ready.', 'تم إنشاء الباقة كمسودة. انشرها عندما تصبح التفاصيل جاهزة.'));
  };

  const handleDeletePackage = async (id: string, name: string) => {
    if (!window.confirm(t(`Delete "${name}"? This removes it from the customer site.`, `حذف "${name}"؟ سيؤدي ذلك إلى إزالتها من موقع العملاء.`))) return;
    await deleteBirthdayPackage(id);
    showToast(t(`"${name}" deleted.`, `تم حذف "${name}".`));
  };

  // Table Filters & Search & Pagination
  const [tableSearch, setTableSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // Filter event bookings
  const eventBookings = useMemo(() => {
    return liveBookings.filter(b => {
      const wTitle = (b.workshopTitle || '').toLowerCase();
      // Check if this booking is for Package 01, Package 02, or any Birthday/Event
      const isEventBooking = 
        b.workshopId === 'birthday-party-event' ||
        wTitle.includes('package') ||
        wTitle.includes('option') ||
        wTitle.includes('birthday') ||
        wTitle.includes('party') ||
        wTitle.includes('event') ||
        wTitle.includes('social');

      if (!isEventBooking) return false;

      const matchesSearch = matchesQuery(
        [b.id, b.customerName, b.customerPhone, b.customerEmail, b.workshopTitle, b.status],
        tableSearch
      );

      const matchesStatus = statusFilter === 'all' || b.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [liveBookings, tableSearch, statusFilter]);

  // Reset page to 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [tableSearch, statusFilter]);

  const totalEventPages = Math.max(1, Math.ceil(eventBookings.length / ITEMS_PER_PAGE));
  const paginatedEventBookings = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return eventBookings.slice(start, start + ITEMS_PER_PAGE);
  }, [eventBookings, currentPage]);

  // The booking opened from the Dashboard or from a table row — the same shared record.
  const selectedEventBooking = useMemo(
    () => (selectedEventBookingId ? liveBookings.find(b => b.id === selectedEventBookingId) || null : null),
    [selectedEventBookingId, liveBookings]
  );
  /** Everything an availability check needs, including other hosted bookings. */
  const eventAssignmentSources = useMemo(
    () => ({ staff, workshopSessions, workshops, events, bookings: liveBookings, birthdayPackages, queue }),
    [staff, workshopSessions, workshops, events, liveBookings, birthdayPackages, queue]
  );

  const eventDetails = selectedEventBooking?.birthdayDetails;

  /** The package this booking was made against, resolved from its stable id. */
  const selectedEventPackage = useMemo(
    () => (eventDetails?.packageId
      ? birthdayPackages.find(p => p.id === eventDetails.packageId) || null
      : null),
    [eventDetails, birthdayPackages]
  );

  // Enlarged view of a submitted image
  const [previewImage, setPreviewImage] = useState<{ url: string; label: string } | null>(null);

  // Handle Cancel Booking from Table
  const [cancellingBookingId, setCancellingBookingId] = useState<string | null>(null);
  // Events & Socials do not follow the workshop 24h refund window (confirmed
  // policy difference) — staff choose the outcome explicitly instead, same
  // as the Bookings Ledger's cancel modal.
  const [refundOption, setRefundOption] = useState<'Refunded' | 'NotRefunded'>('Refunded');

  const confirmCancel = async (id: string) => {
    const paymentStatusUpdate = refundOption === 'Refunded' ? 'Refunded' : undefined;
    await cancelBooking(id, 'Staff', paymentStatusUpdate);
    setCancellingBookingId(null);
    showToast(t(`Booking ${id} has been cancelled.`, `تم إلغاء الحجز ${id}.`));
  };

  // The editor takes over the page, so the management view stays an overview.
  if (editingPackage) {
    return (
      <AdminBirthdayPackageEditor
        pkg={editingPackage}
        onBack={() => setEditingPackageId(null)}
        onSave={updates => handleSavePackage(editingPackage.id, updates)}
        onNotify={showToast}
      />
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-8 text-left pb-12 animate-in fade-in duration-300">
      
      {/* Toast Banner */}
      {toastMessage && (
        <div className="fixed top-20 right-6 z-50 bg-emerald-700 text-white text-xs font-bold px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Page heading — plain on the page, like every other console section. */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-brand-terracotta" />
          <span className="text-xs font-bold uppercase tracking-wider text-brand-terracotta">{t('Events & Socials Console', 'لوحة الفعاليات والمناسبات الاجتماعية')}</span>
        </div>
        <h1 className="font-display text-2xl font-bold text-brand-charcoal">{t('Birthday Package Management', 'إدارة باقات أعياد الميلاد')}</h1>
        <p className="text-xs text-brand-charcoal/60 mt-0.5">{t('Edit the package details customers see, and view all package reservations.', 'عدّل تفاصيل الباقات التي يراها العملاء، واطّلع على جميع حجوزات الباقات.')}</p>
      </div>

      {/* ========================================================== */}
      {/* ========= SECTION 1: SHARED PACKAGE RECORD EDITOR ========= */}
      {/* ========================================================== */}
      <div className="bg-white border-2 border-brand-clay rounded-3xl p-6 shadow-xs space-y-5">

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-brand-clay/60">
          <div>
            <h2 className="font-display text-lg font-bold text-brand-charcoal flex items-center gap-2">
              <Package className="h-5 w-5 text-brand-terracotta" />
              <span>{t('Birthday Package Details', 'تفاصيل باقات أعياد الميلاد')}</span>
            </h2>
            <p className="text-xs text-brand-charcoal/60 mt-0.5">
              {t('These records are what the customer site shows. Booking-form fields are configured in Settings → Events & Birthday.', 'هذه السجلات هي ما يعرضه موقع العملاء. تُضبط حقول نموذج الحجز من الإعدادات ← الفعاليات وأعياد الميلاد.')}
            </p>
          </div>

          <button
            type="button"
            onClick={handleAddPackage}
            className="cursor-pointer px-4 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold flex items-center gap-2 shadow-xs shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>{t('Add Package', 'إضافة باقة')}</span>
          </button>
        </div>

        {birthdayPackages.length === 0 ? (
          <p className="text-xs text-brand-charcoal/50 italic py-4">{t('No birthday packages yet. Add one to publish it on the customer site.', 'لا توجد باقات أعياد ميلاد بعد. أضف باقة لنشرها على موقع العملاء.')}</p>
        ) : (
          <div className="space-y-4">
            {birthdayPackages.map(pkg => {
              return (
                <div key={pkg.id} className="border border-brand-clay/70 rounded-2xl overflow-hidden">

                  {/* Package row header */}
                  <div className="flex items-center justify-between gap-3 p-4 bg-brand-cream/40">
                    <button
                      type="button"
                      onClick={() => setEditingPackageId(pkg.id)}
                      className="flex items-center gap-3 text-left cursor-pointer flex-1 min-w-0"
                    >
                      {pkg.image && (
                        <img src={pkg.image} alt={pkg.name} className="h-10 w-10 rounded-lg object-cover border border-brand-clay/50 shrink-0" referrerPolicy="no-referrer" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-brand-charcoal truncate">{pkg.name}</p>
                        <p className="text-[11px] font-semibold text-brand-charcoal/60">
                          {pkg.price} {t('SAR', 'ريال')} · {enumLabel('pricingType', pkg.pricingType, lang)} · {pkg.duration}
                        </p>
                      </div>
                      <span className="ms-auto hidden shrink-0 text-[11px] font-bold text-brand-terracotta sm:block">
                        {t('Edit package', 'تعديل الباقة')}
                      </span>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                        pkg.status === 'Published' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {enumLabel('workshopStatus', pkg.status, lang)}
                      </span>

                      <button
                        type="button"
                        title={t('Delete package', 'حذف الباقة')}
                        onClick={() => handleDeletePackage(pkg.id, pkg.name)}
                        className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* The editor is its own view now — see
                      AdminBirthdayPackageEditor. */}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ========================================================== */}
      {/* ================= SECTION 2: BOOKED CUSTOMERS TABLE ====== */}
      {/* ========================================================== */}
      <div className="bg-white border-2 border-brand-clay rounded-3xl p-6 shadow-xs space-y-5">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-brand-clay/60">
          <div>
            <h2 className="font-display text-lg font-bold text-brand-charcoal flex items-center gap-2">
              <Users className="h-5 w-5 text-brand-terracotta" />
              <span>{t('Customer Event & Package Bookings', 'حجوزات العملاء للفعاليات والباقات')}</span>
            </h2>
            <p className="text-xs text-brand-charcoal/60 mt-0.5">{t('List of all customers who reserved a birthday package or private event.', 'قائمة بجميع العملاء الذين حجزوا باقة عيد ميلاد أو فعالية خاصة.')}</p>
          </div>

          <div className="flex items-center gap-2">
            <span className="bg-brand-sand px-3 py-1 rounded-full text-xs font-bold text-brand-charcoal">
              {lang === 'ar' ? `إجمالي الحجوزات: ${eventBookings.length}` : `${eventBookings.length} Total Reservations`}
            </span>
          </div>
        </div>

        {/* Table Search & Filter Bar */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-3 h-4 w-4 text-brand-charcoal/40" />
            <input
              type="text"
              placeholder={t('Search by customer name, phone, email, or booking ref...', 'ابحث باسم العميل أو الهاتف أو البريد الإلكتروني أو مرجع الحجز...')}
              value={tableSearch}
              onChange={e => setTableSearch(e.target.value)}
              className="w-full bg-brand-sand/20 border border-brand-clay/80 rounded-xl pl-10 pr-4 py-2.5 text-xs text-brand-charcoal focus:outline-none focus:border-brand-terracotta"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-brand-charcoal/50" />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-brand-sand/20 border border-brand-clay/80 rounded-xl px-3 py-2.5 text-xs font-bold text-brand-charcoal focus:outline-none focus:border-brand-terracotta"
            >
              <option value="all">{t('All Statuses', 'كل الحالات')}</option>
              <option value="Pending">{enumLabel('bookingStatus', 'Pending', lang)}</option>
              <option value="Checked In">{enumLabel('bookingStatus', 'Checked In', lang)}</option>
              <option value="Completed">{enumLabel('bookingStatus', 'Completed', lang)}</option>
              <option value="Cancelled">{enumLabel('bookingStatus', 'Cancelled', lang)}</option>
            </select>
          </div>
        </div>

        {/* Customer Table */}
        <div className="overflow-x-auto rounded-2xl border border-brand-clay/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-brand-sand/40 border-b border-brand-clay/60 font-bold uppercase text-brand-charcoal/70 tracking-wider">
              <tr>
                <th className="p-3.5">{t('Booking Ref', 'مرجع الحجز')}</th>
                <th className="p-3.5">{t('Customer Details', 'بيانات العميل')}</th>
                <th className="p-3.5">{t('Event / Package', 'الفعالية / الباقة')}</th>
                <th className="p-3.5">{t('Date & Time', 'التاريخ والوقت')}</th>
                <th className="p-3.5">{t('Guests', 'الضيوف')}</th>
                <th className="p-3.5">{t('Price & Payment', 'السعر والدفع')}</th>
                <th className="p-3.5">{t('Booking Status', 'حالة الحجز')}</th>
                <th className="p-3.5 text-right">{t('Actions', 'الإجراءات')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-clay/30 font-medium text-brand-charcoal">
              {eventBookings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-brand-charcoal/50 bg-brand-cream/30">
                    {t('No customer event bookings found.', 'لا توجد حجوزات فعاليات للعملاء.')}
                  </td>
                </tr>
              ) : (
                paginatedEventBookings.map(b => (
                  <tr
                    key={b.id}
                    onClick={() => setSelectedEventBookingId(b.id)}
                    className={`hover:bg-brand-sand/20 transition-colors cursor-pointer ${
                      selectedEventBookingId === b.id ? 'bg-brand-sand/40' : ''
                    }`}
                  >
                    {/* Booking Ref */}
                    <td className="p-3.5 font-mono font-bold text-brand-terracotta">
                      {b.id}
                    </td>

                    {/* Customer Info */}
                    <td className="p-3.5">
                      <div className="font-bold text-brand-charcoal">{b.customerName}</div>
                      <div className="text-[10px] text-brand-charcoal/60 font-mono flex items-center gap-1 mt-0.5">
                        <Phone className="h-3 w-3" />
                        <span>{b.customerPhone}</span>
                      </div>
                      {b.customerEmail && (
                        <div className="text-[10px] text-brand-charcoal/50 font-mono truncate max-w-[150px]">
                          {b.customerEmail}
                        </div>
                      )}
                    </td>

                    {/* Booked Package / Event — resolved from the stored package id */}
                    <td className="p-3.5">
                      <span className="font-bold text-brand-charcoal block">
                        {(b.birthdayDetails?.packageId
                          && birthdayPackages.find(p => p.id === b.birthdayDetails!.packageId)?.name)
                          || b.workshopTitle}
                      </span>
                      <span className="text-[10px] text-brand-charcoal/50 uppercase font-bold">
                        {t('Source:', 'المصدر:')} {enumLabel('source', b.source || 'Website', lang)}
                      </span>
                    </td>

                    {/* Date & Time */}
                    <td className="p-3.5">
                      <div className="font-bold">{b.date}</div>
                      <div className="text-[10px] text-brand-charcoal/60 font-mono">{b.time}</div>
                    </td>

                    {/* Guests */}
                    <td className="p-3.5 font-bold">
                      {b.participants} {t('Guests', 'ضيوف')}
                    </td>

                    {/* Price & Payment Status */}
                    <td className="p-3.5">
                      <div className="font-mono font-bold text-brand-charcoal"><PaymentAmountsCell booking={b} /></div>
                      <span className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-bold mt-1 ${
                        {
                          paid: 'bg-emerald-100 text-emerald-800',
                          refunded: 'bg-purple-100 text-purple-800',
                          waiting: 'bg-amber-100 text-amber-800',
                          closed: 'bg-gray-100 text-gray-500',
                          attention: 'bg-red-100 text-red-800',
                          unpaid: 'bg-amber-100 text-amber-800'
                        }[paymentTone(b.paymentStatus)]
                      }`}>
                        {enumLabel('payment', b.paymentStatus, lang)}
                      </span>
                    </td>

                    {/* Status Badge */}
                    <td className="p-3.5">
                      <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-bold ${
                        b.status === 'Completed'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          : b.status === 'Checked In'
                          ? 'bg-blue-100 text-blue-800 border border-blue-200'
                          : b.status === 'Cancelled'
                          ? 'bg-red-100 text-red-800 border border-red-200'
                          : 'bg-amber-100 text-amber-800 border border-amber-200'
                      }`}>
                        {enumLabel('bookingStatus', b.status, lang)}
                      </span>
                    </td>

                    {/* Action */}
                    <td className="p-3.5 text-right">
                      {b.status !== 'Cancelled' ? (
                        <button
                          type="button"
                          onClick={() => { setCancellingBookingId(b.id); setRefundOption('Refunded'); }}
                          className="cursor-pointer px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-[10px] font-bold rounded-lg transition-colors"
                        >
                          {t('Cancel Booking', 'إلغاء الحجز')}
                        </button>
                      ) : (
                        <span className="text-[10px] text-brand-charcoal/40 font-bold">{enumLabel('bookingStatus', 'Cancelled', lang)}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {eventBookings.length > 0 && (
          <div className="p-4 border-t border-brand-clay/40 bg-brand-sand/10 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs font-semibold text-brand-charcoal/60">
              {lang === 'ar'
                ? <>عرض <span className="font-bold text-brand-charcoal">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span>–<span className="font-bold text-brand-charcoal">{Math.min(currentPage * ITEMS_PER_PAGE, eventBookings.length)}</span> من <span className="font-bold text-brand-charcoal">{eventBookings.length}</span> حجز فعالية</>
                : <>Showing <span className="font-bold text-brand-charcoal">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span>–<span className="font-bold text-brand-charcoal">{Math.min(currentPage * ITEMS_PER_PAGE, eventBookings.length)}</span> of <span className="font-bold text-brand-charcoal">{eventBookings.length}</span> event bookings</>}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                className="px-3 py-1.5 bg-white border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-sand transition-colors cursor-pointer"
              >
                {t('Previous', 'السابق')}
              </button>
              <span className="text-xs font-bold text-brand-charcoal px-2">
                {t('Page', 'الصفحة')} {currentPage} {t('of', 'من')} {totalEventPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalEventPages}
                onClick={() => setCurrentPage(prev => Math.min(totalEventPages, prev + 1))}
                className="px-3 py-1.5 bg-white border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-sand transition-colors cursor-pointer"
              >
                {t('Next', 'التالي')}
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Cancel Confirmation Modal */}

      {/* ========================================================== */}
      {/* ========= FULL BIRTHDAY / EVENT BOOKING DETAILS ========== */}
      {/* Same interaction pattern as the Customer Details page:      */}
      {/* one shared booking record, every submitted field shown.     */}
      {/* ========================================================== */}
      {selectedEventBooking && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-brand-cream border border-brand-clay rounded-3xl max-w-3xl w-full my-8 shadow-2xl text-left animate-in zoom-in-95 duration-150">

            <div className="flex items-start justify-between gap-4 p-6 border-b border-brand-clay/60">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-brand-terracotta block">
                  {t('Birthday / Event Reservation', 'حجز عيد ميلاد / فعالية')}
                </span>
                <h2 className="font-display text-2xl font-bold text-brand-charcoal">
                  {selectedEventBooking.workshopTitle}
                </h2>
                <p className="font-mono text-xs font-bold text-brand-charcoal/60 mt-1">
                  {selectedEventBooking.id}
                </p>
              </div>

              <button
                onClick={() => setSelectedEventBookingId(null)}
                aria-label={t('Close', 'إغلاق')}
                className="p-1.5 rounded-lg hover:bg-brand-sand text-brand-charcoal/60 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-6 space-y-5 text-xs">

              {/* Status row */}
              <div className="flex flex-wrap gap-2">
                <span className="px-2.5 py-1 rounded-lg font-bold bg-white border border-brand-clay/60 text-brand-charcoal">
                  {t('Booking status:', 'حالة الحجز:')} {enumLabel('bookingStatus', selectedEventBooking.status, lang)}
                </span>
                <span className="px-2.5 py-1 rounded-lg font-bold bg-white border border-brand-clay/60 text-brand-charcoal">
                  {t('Payment:', 'الدفع:')} {enumLabel('payment', selectedEventBooking.paymentStatus, lang)}
                </span>
                <span className="px-2.5 py-1 rounded-lg font-bold bg-white border border-brand-clay/60 text-brand-charcoal">
                  {t('Source:', 'المصدر:')} {enumLabel('source', selectedEventBooking.source, lang)}
                </span>

                {/* Assigned staff. Sized and styled as the pills beside it so
                    the row stays one consistent line. Availability is checked
                    against THIS booking's own date and time. */}
                <label className="px-2.5 py-1 rounded-lg font-bold bg-white border border-brand-clay/60 text-brand-charcoal inline-flex items-center gap-1.5">
                  <span>{t('Staff:', 'الموظف:')}</span>
                  <select
                    value={selectedEventBooking.staffId || ''}
                    onChange={e => assignBookingStaff(selectedEventBooking.id, e.target.value || null)}
                    className="bg-transparent font-bold text-brand-charcoal cursor-pointer focus:outline-none max-w-[180px]"
                  >
                    <option value="">{t('Unassigned', 'غير معيّن')}</option>
                    {staff
                      .filter(m => m.status === 'Active' || m.id === selectedEventBooking.staffId)
                      .map(member => {
                        const avail = (selectedEventBooking.date && selectedEventBooking.time)
                          ? checkStaffMemberAvailability({
                              staff: member,
                              date: selectedEventBooking.date,
                              startTime: selectedEventBooking.time,
                              duration: selectedEventPackage?.duration,
                              sources: eventAssignmentSources,
                              // This booking's own slot must not count against itself.
                              exclude: { bookingIds: [selectedEventBooking.id] }
                            })
                          : null;
                        const unavailable = avail ? !avail.isAvailable : false;
                        return (
                          <option key={member.id} value={member.id} disabled={unavailable}>
                            {avail ? `${member.name} — ${enumLabel('staffAvailability', avail.status, lang)}` : member.name}
                          </option>
                        );
                      })}
                  </select>
                </label>
              </div>

              {/* Customer */}
              <section className="bg-white border border-brand-clay/60 rounded-2xl p-4 space-y-2">
                <h3 className="font-bold text-brand-charcoal uppercase tracking-wider text-[10px]">{t('Customer', 'العميل')}</h3>
                <DetailRow label={t('Name', 'الاسم')} value={selectedEventBooking.customerName} />
                <DetailRow label={t('Phone', 'الهاتف')} value={selectedEventBooking.customerPhone} mono />
                <DetailRow label={t('Email', 'البريد الإلكتروني')} value={selectedEventBooking.customerEmail} />
              </section>

              {/* Reservation */}
              <section className="bg-white border border-brand-clay/60 rounded-2xl p-4 space-y-2">
                <h3 className="font-bold text-brand-charcoal uppercase tracking-wider text-[10px]">{t('Reservation', 'الحجز')}</h3>
                <DetailRow
                  label={t('Package selected', 'الباقة المختارة')}
                  value={selectedEventPackage?.name || eventDetails?.packageName || selectedEventBooking.workshopTitle}
                />
                <DetailRow label={t('Event date', 'تاريخ الفعالية')} value={eventDetails?.eventDate || selectedEventBooking.date} mono />
                <DetailRow label={t('Event time', 'وقت الفعالية')} value={eventDetails?.eventTime || selectedEventBooking.time} mono />
                <DetailRow label={t('Number of guests', 'عدد الضيوف')} value={String(eventDetails?.guestCount ?? selectedEventBooking.participants)} />
                <DetailRow label={t('Submitted', 'تاريخ التقديم')} value={eventDetails?.submittedAt ? formatDateTime(eventDetails.submittedAt) : formatDateTime(selectedEventBooking.createdAt)} />
              </section>

              {/* The Celebration Details card was removed — All Submitted Form
                  Answers below is the single, complete record of what the
                  customer submitted, so nothing is duplicated. */}

              {/* Every submitted answer, by stable key */}
              {eventDetails?.fieldValues && eventDetails.fieldValues.length > 0 && (
                <section className="bg-white border border-brand-clay/60 rounded-2xl p-4 space-y-2">
                  <h3 className="font-bold text-brand-charcoal uppercase tracking-wider text-[10px]">
                    {t('All Submitted Form Answers', 'جميع إجابات النموذج المقدَّمة')}
                  </h3>
                  <p className="text-[10px] text-brand-charcoal/50">
                    {t('Everything the customer filled in on the reservation form.', 'كل ما أدخله العميل في نموذج الحجز.')}
                  </p>
                  {eventDetails.fieldValues.map(field => {
                    const isImageField = !!field.imageUrl || /photo|image/i.test(field.key);

                    if (isImageField) {
                      return (
                        <div key={field.key} className="border-b border-brand-clay/25 last:border-b-0 py-2 space-y-1.5">
                          <span className="text-brand-charcoal/60 font-semibold block">
                            {field.label}
                          </span>

                          {field.imageUrl ? (
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => setPreviewImage({ url: field.imageUrl!, label: field.label })}
                                title={t('Click to enlarge', 'انقر للتكبير')}
                                className="h-20 w-20 rounded-xl overflow-hidden border border-brand-clay/60 shrink-0 cursor-zoom-in hover:border-brand-terracotta transition-colors"
                              >
                                <img src={field.imageUrl} alt={field.label} className="h-full w-full object-cover" />
                              </button>

                              <div className="flex flex-col gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setPreviewImage({ url: field.imageUrl!, label: field.label })}
                                  className="text-[11px] font-bold text-brand-terracotta hover:underline text-left cursor-pointer"
                                >
                                  {t('View larger', 'عرض أكبر')}
                                </button>
                                <a
                                  href={field.imageUrl}
                                  download={`${field.key}-${selectedEventBooking.id}.png`}
                                  className="text-[11px] font-bold text-brand-charcoal/70 hover:text-brand-charcoal hover:underline flex items-center gap-1"
                                >
                                  <Download className="h-3 w-3" />
                                  <span>{t('Save Image', 'حفظ الصورة')}</span>
                                </a>
                              </div>
                            </div>
                          ) : (
                            <p className="text-brand-charcoal/40 italic">{t('No image was submitted for this field.', 'لم تُرسَل صورة لهذا الحقل.')}</p>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div key={field.key} className="flex justify-between gap-3 border-b border-brand-clay/25 last:border-b-0 py-1">
                        <span className="text-brand-charcoal/60 font-semibold">
                          {field.label}
                        </span>
                        <span className="font-bold text-brand-charcoal text-right">
                          {field.value || <span className="text-brand-charcoal/30 italic">{t('Not provided', 'غير مُقدَّم')}</span>}
                        </span>
                      </div>
                    );
                  })}
                </section>
              )}

              {/* Money */}
              <section className="bg-white border border-brand-clay/60 rounded-2xl p-4 space-y-2">
                <h3 className="font-bold text-brand-charcoal uppercase tracking-wider text-[10px]">{t('Payment', 'الدفع')}</h3>
                {paymentBreakdown(selectedEventBooking).online ? (
                  // Paid online (0046): the booking row's own figures — the
                  // database's total and what Moyasar took — not the amounts
                  // the form estimated when the customer submitted it.
                  <PaymentAmountsDetails
                    booking={selectedEventBooking}
                    totalLabel={t('Total amount', 'المبلغ الإجمالي')}
                    labelClassName="text-brand-charcoal/60 font-semibold"
                    valueClassName="font-bold text-emerald-700"
                  />
                ) : (
                  <>
                    <DetailRow label={t('Total amount', 'المبلغ الإجمالي')} value={eventDetails?.totalAmount !== undefined ? `${eventDetails.totalAmount} ${t('SAR', 'ريال')}` : ''} />
                    <DetailRow
                      label={t('Deposit amount', 'مبلغ العربون')}
                      value={`${eventDetails?.depositAmount ?? selectedEventBooking.totalPrice} ${t('SAR', 'ريال')}`}
                    />
                  </>
                )}
                <DetailRow label={t('Payment status', 'حالة الدفع')} value={enumLabel('payment', selectedEventBooking.paymentStatus, lang)} />
              </section>

              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setSelectedEventBookingId(null)}
                  className="px-5 py-2.5 bg-brand-charcoal text-brand-cream rounded-xl text-xs font-bold cursor-pointer"
                >
                  {t('Close', 'إغلاق')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* ================= SUBMITTED IMAGE PREVIEW ================= */}
      {previewImage && (
        <div
          className="fixed inset-0 bg-brand-charcoal/80 backdrop-blur-sm z-[70] flex items-center justify-center p-6"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="bg-white border border-brand-clay rounded-3xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 p-4 border-b border-brand-clay/60">
              <h3 className="font-display text-sm font-bold text-brand-charcoal">{previewImage.label}</h3>

              <div className="flex items-center gap-2">
                <a
                  href={previewImage.url}
                  download={`${previewImage.label.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.png`}
                  className="px-3 py-1.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>{t('Save Image', 'حفظ الصورة')}</span>
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewImage(null)}
                  title={t('Close preview', 'إغلاق المعاينة')}
                  className="p-1.5 rounded-lg hover:bg-brand-sand text-brand-charcoal/60 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Rendered at full stored resolution, not a resized copy */}
            <div className="p-4 overflow-auto bg-brand-cream/40 flex items-center justify-center">
              <img
                src={previewImage.url}
                alt={previewImage.label}
                className="max-w-full max-h-[70vh] object-contain rounded-xl"
              />
            </div>
          </div>
        </div>
      )}

      {cancellingBookingId && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-brand-cream border border-brand-clay rounded-3xl p-6 max-w-sm w-full text-left space-y-4 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 text-red-600">
              <ShieldAlert className="h-6 w-6" />
              <h3 className="font-display text-base font-bold text-brand-charcoal">{t('Cancel Event Booking?', 'إلغاء حجز الفعالية؟')}</h3>
            </div>
            <p className="text-xs text-brand-charcoal/70 leading-relaxed">
              {lang === 'ar' ? (
                <>
                  هل أنت متأكد من إلغاء الحجز <strong className="font-mono text-brand-charcoal">{cancellingBookingId}</strong>؟ سيؤدي هذا إلى تحرير المقاعد المحجوزة ووضع علامة «ملغى» على الحجز
                  {refundOption === 'Refunded'
                    ? '، وسيتم وضع علامة «مُسترد» على الدفعة.'
                    : '، ولن يُسترد المبلغ وسيبقى الدفع كما هو مسجَّل.'}
                </>
              ) : (
                <>
                  Are you sure you want to cancel booking <strong className="font-mono text-brand-charcoal">{cancellingBookingId}</strong>? This will release reserved seats and mark the reservation as cancelled
                  {refundOption === 'Refunded'
                    ? ', and the payment will be marked as refunded.'
                    : ' — the payment will not be refunded and stays as recorded.'}
                </>
              )}
            </p>

            {/* Refund Action Selector — same pattern as the Bookings Ledger's
                cancel modal. Events don't follow the workshop 24h window, so
                there is no eligibility hint here, only the explicit choice. */}
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
                  <span>{t('Mark as Refunded', 'تحديد كمُسترد')}</span>
                  <span className="text-[9px] font-normal opacity-85">{t('Reverts payment as Refunded', 'يُسجَّل الدفع كمُسترد')}</span>
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
                  <span>{t('Mark as Not Refunded', 'تحديد كغير مُسترد')}</span>
                  <span className="text-[9px] font-normal opacity-85">{t('No refund issued — payment stays as recorded', 'لا يُصدر استرداد — يبقى الدفع كما هو مسجَّل')}</span>
                </button>
              </div>
            </div>

            <OnlineRefundNote booking={liveBookings.find(b => b.id === cancellingBookingId)} />

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={() => setCancellingBookingId(null)}
                className="cursor-pointer py-2.5 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl"
              >
                {t('Keep Booking', 'إبقاء الحجز')}
              </button>
              <button
                onClick={() => confirmCancel(cancellingBookingId)}
                className="cursor-pointer py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl shadow-xs"
              >
                {t('Confirm Cancellation', 'تأكيد الإلغاء')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
