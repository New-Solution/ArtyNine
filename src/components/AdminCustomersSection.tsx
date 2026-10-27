/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { CustomerAccount, Booking, QueueItem, PotteryPiece, DEFAULT_PIPELINE_STAGES } from '../types';
import { stageOf } from '../utils/pipelineStages';
import { PieceImage } from '../lib/pieceImages';
import { 
  Users, UserPlus, Search, Filter, Phone, Mail, Calendar, Clock, 
  Edit, CheckCircle2, AlertCircle, ShoppingBag, CreditCard, Flame, ChevronRight, 
  Tag, Shield, History, Sparkles, X, Plus, AlertTriangle, UserCheck, Cake, ListOrdered, Palette
, Info } from 'lucide-react';
import { COUNTRIES, parsePhoneComponents, validatePhone, normalisePhone, normaliseSaudiPhone } from '../utils/phoneUtils';
import { PhoneInput } from './PhoneInput';
import { validateCustomerForm, canonicalPhone, canonicalEmail } from '../utils/validation';
import {
  ACTIVITY_CATEGORIES, ActivityCategory, getCustomerActivityCategories
} from '../utils/activityUtils';
import { hasWebsiteAccount, matchesAccountType, getAccountType } from '../utils/accountUtils';
import { matchesQuery, useDebouncedValue } from '../utils/search';
import { BackButton } from './ui/BackButton';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';

/** Badge colour per activity category. */
const categoryBadgeClass = (category: ActivityCategory) => {
  switch (category) {
    case 'Events/Birthdays':
      return 'bg-pink-50 text-pink-800 border-pink-200';
    case 'Self-Guided':
      return 'bg-purple-50 text-purple-800 border-purple-200';
    default:
      return 'bg-blue-50 text-blue-800 border-blue-200';
  }
};

/**
 * Display text for a queue visit's activity. It stays English in the data; only the
 * self-guided pattern the Live Queue writes is translated, and anything else is shown
 * exactly as stored.
 */
const SELF_GUIDED_ACTIVITY = /^Walk-in \(No Instructor - (.+) hrs\)$/;
function displayActivity(activity: string, t: (en: string, ar: string) => string) {
  const m = SELF_GUIDED_ACTIVITY.exec(activity);
  return m ? t(activity, `زيارة مباشرة (بدون مدرب - ${m[1]} ساعة)`) : activity;
}

export const AdminCustomersSection: React.FC = () => {
  const { 
    customers,
    bookings,
    queue,
    pieces,
    pipelineStages,
    workshops,
    addCustomer,
    updateCustomer, 
    todayDateStr,
    setAdminTab,
    setPendingBooking,
    setCustomerTab,
    viewCustomerSite
  } = useApp();
  const { lang, t } = useLanguage();

  /**
   * A piece's stage key: by stage id, falling back to its stored name. Until the
   * stage list has loaded, the default rows (same ids and names) stand in.
   */
  const pieceStageKey = (p: PotteryPiece) =>
    stageOf(p, pipelineStages.length > 0 ? pipelineStages : DEFAULT_PIPELINE_STAGES)?.systemKey;

  // Navigation state inside Customers section
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  /* Every row here is derived from bookings, queue entries and pieces, so the
     whole set is rebuilt on each keystroke. Debouncing the query is what keeps
     that from feeling like a freeze on a large customer list. */
  const debouncedSearch = useDebouncedValue(searchQuery);
  const [sourceFilter, setSourceFilter] = useState<string>('All');
  const [accountTypeFilter, setAccountTypeFilter] = useState<string>('All'); // All, Registered, Guest
  const [hasUpcomingFilter, setHasUpcomingFilter] = useState(false);
  const [hasUnpaidFilter, setHasUnpaidFilter] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const CUSTOMERS_PER_PAGE = 10;

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [customerToEdit, setCustomerToEdit] = useState<CustomerAccount | null>(null);

  // Create Form fields
  const [createName, setCreateName] = useState('');
  const [createCountryCode, setCreateCountryCode] = useState('+966');
  const [createNationalPhone, setCreateNationalPhone] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createSource, setCreateSource] = useState<CustomerAccount['source']>('Admin Created');
  const [createNotes, setCreateNotes] = useState('');
  const [createStatus, setCreateStatus] = useState<CustomerAccount['status']>('Active');
  
  // Duplicate warning state
  const [duplicateMatch, setDuplicateMatch] = useState<CustomerAccount | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // Field-keyed messages from the shared validation layer.
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const clearCreateFieldError = (key: string) =>
    setCreateFieldErrors(prev => (prev[key] ? { ...prev, [key]: '' } : prev));
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState<string | null>(null);

  // Profile view active sub-tab
  const [profileTab, setProfileTab] = useState<'overview' | 'visits' | 'bookings' | 'payments' | 'pieces'>('overview');
  const [bookingHistoryFilter, setBookingHistoryFilter] = useState<'all' | 'upcoming' | 'completed' | 'cancelled'>('all');

  // Helper to normalize any phone string for robust matching
  const getNormalizedPhone = (phoneStr: string) => {
    if (!phoneStr) return '';
    const { countryCode, nationalNumber } = parsePhoneComponents(phoneStr);
    return normalisePhone(countryCode, nationalNumber);
  };

  // Build comprehensive customer list (combining db.customers + derived customers from bookings/queue/pieces)
  const allDerivedCustomers = useMemo(() => {
    const listMap = new Map<string, CustomerAccount>();

    // Helper to sanitize fake placeholder emails
    const sanitizeEmail = (eStr?: string) => {
      if (!eStr) return '';
      const lower = eStr.toLowerCase();
      if (lower.includes('@guest.artycafe.sa') || lower.includes('@artycafe.temp') || lower.includes('walkin_') || lower.includes('@placeholder.com')) {
        return '';
      }
      return eStr;
    };

    // 1. Add explicitly stored db.customers
    (customers || []).forEach(c => {
      const normP = getNormalizedPhone(c.phone);
      const cleanE = sanitizeEmail(c.email);
      const key = normP || (cleanE ? cleanE.toLowerCase() : '') || c.id;
      listMap.set(key, {
        ...c,
        email: cleanE
      });
    });

    // 2. Scan bookings for any missing customer
    (bookings || []).forEach(b => {
      const normP = getNormalizedPhone(b.customerPhone);
      const cleanE = sanitizeEmail(b.customerEmail);
      const key = normP || (cleanE ? cleanE.toLowerCase() : '') || (b.customerName ? b.customerName.toLowerCase() : '');
      if (key && !listMap.has(key)) {
        // Derived from the key, so the id stays the same across re-renders.
        // A random id here made rows remount and broke row selection.
        const generatedId = `GUEST-${key}`;
        listMap.set(key, {
          id: generatedId,
          name: b.customerName || 'Guest',
          email: cleanE,
          phone: normP || b.customerPhone || '',
          source: b.source === 'Website' ? 'Website Booking' : 'Manual Admin Entry',
          createdAt: b.createdAt ? b.createdAt.split(' ')[0] : todayDateStr,
          hasAccount: false
        });
      }
    });

    // 3. Scan queue for missing customer
    (queue || []).forEach(q => {
      const normP = getNormalizedPhone(q.phone);
      const key = normP || (q.name ? q.name.toLowerCase() : '');
      if (key && !listMap.has(key)) {
        const generatedId = `GUEST-${key}`;
        listMap.set(key, {
          id: generatedId,
          name: q.name || 'Guest',
          email: '',
          phone: normP || q.phone || '',
          source: 'Live Queue',
          createdAt: q.date || todayDateStr,
          hasAccount: false
        });
      }
    });

    return Array.from(listMap.values());
  }, [customers, bookings, queue, todayDateStr]);

  // Derived metrics map for each customer
  // Activity categories per customer, derived from their real booking and queue
  // history. This is what the Source column and filter represent — it is not the
  // account type, and not a stored registration source.
  const customerCategoriesMap = useMemo(() => {
    const map = new Map<string, ActivityCategory[]>();
    allDerivedCustomers.forEach(c => {
      map.set(c.id, getCustomerActivityCategories(c, { bookings, queue, workshops }));
    });
    return map;
  }, [allDerivedCustomers, bookings, queue, workshops]);

  const customerMetricsMap = useMemo(() => {
    const map = new Map<string, {
      totalVisits: number;
      totalBookings: number;
      upcomingBookingsCount: number;
      completedBookingsCount: number;
      cancelledBookingsCount: number;
      totalSpent: number;
      totalPaid: number;
      totalRefunded: number;
      unpaidBalance: number;
      totalPieces: number;
      piecesReadyCount: number;
      lastVisitDate: string;
      visitsList: Array<{
        id: string;
        date: string;
        time: string;
        type: string;
        title: string;
        guests: number;
        staff?: string;
        completionTime?: string;
        bookingId?: string;
        paymentStatus: string;
      }>;
      customerBookings: Booking[];
      customerQueue: QueueItem[];
      customerPieces: PotteryPiece[];
    }>();

    allDerivedCustomers.forEach(c => {
      const cNormPhone = getNormalizedPhone(c.phone);
      const cNormEmail = c.email ? c.email.toLowerCase() : '';
      const cNameLower = (c.name || '').toLowerCase();

      // Filter bookings belonging to this customer
      const cBookings = (bookings || []).filter(b => {
        const bNormP = getNormalizedPhone(b.customerPhone);
        if (cNormPhone && bNormP && cNormPhone === bNormP) return true;
        if (cNormEmail && b.customerEmail && b.customerEmail.toLowerCase() === cNormEmail) return true;
        if (cNameLower && b.customerName && b.customerName.toLowerCase() === cNameLower) return true;
        return false;
      });

      // Filter queue entries belonging to this customer
      const cQueue = (queue || []).filter(q => {
        const qNormP = getNormalizedPhone(q.phone);
        if (cNormPhone && qNormP && cNormPhone === qNormP) return true;
        if (cNameLower && q.name && q.name.toLowerCase() === cNameLower) return true;
        return false;
      });

      // Filter pottery pieces belonging to this customer
      const cPieces = (pieces || []).filter(p => {
        if (p.customerId && p.customerId === c.id) return true;
        const pNormP = getNormalizedPhone(p.customerPhone);
        if (cNormPhone && pNormP && cNormPhone === pNormP) return true;
        if (cNameLower && p.customerName && p.customerName.toLowerCase() === cNameLower) return true;
        return false;
      });

      // Calculate visits strictly according to completed attendance
      // Completed live queue session, or completed/checked in workshop/event/birthday booking
      const visitsList: Array<{
        id: string;
        date: string;
        time: string;
        type: string;
        title: string;
        guests: number;
        staff?: string;
        completionTime?: string;
        bookingId?: string;
        paymentStatus: string;
      }> = [];

      cBookings.forEach(b => {
        if (b.status === 'Completed' || b.status === 'Checked In') {
          const wTitle = b.workshopTitle || '';
          visitsList.push({
            id: `v-b-${b.id}`,
            date: b.date,
            time: b.time,
            type: b.workshopId === 'birthday-party-event' || wTitle.toLowerCase().includes('birthday')
              ? 'Birthday Package' 
              : wTitle.toLowerCase().includes('event') ? 'Event' : 'Workshop',
            title: b.workshopTitle || 'Workshop',
            guests: b.participants,
            bookingId: b.id,
            paymentStatus: b.paymentStatus
          });
        }
      });

      cQueue.forEach(q => {
        if (q.status === 'Completed') {
          visitsList.push({
            id: `v-q-${q.id}`,
            date: q.date,
            time: q.checkInTime,
            type: 'Live Queue Walk-in',
            title: q.activity,
            guests: q.participants,
            staff: q.staffName,
            bookingId: q.bookingId,
            paymentStatus: 'Paid'
          });
        }
      });

      // Sort visits newest first
      visitsList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const lastVisitDate = visitsList.length > 0 ? visitsList[0].date : '-';

      // Booking breakdown
      const upcomingBookingsCount = cBookings.filter(b => b.date >= todayDateStr && b.status !== 'Cancelled').length;
      const completedBookingsCount = cBookings.filter(b => b.status === 'Completed').length;
      const cancelledBookingsCount = cBookings.filter(b => b.status === 'Cancelled').length;

      // Financials (totalSpent = net total paid minus refunds)
      let totalPaid = 0;
      let totalRefunded = 0;
      let unpaidBalance = 0;

      cBookings.forEach(b => {
        if (b.status !== 'Cancelled') {
          if (b.paymentStatus === 'Paid') {
            totalPaid += b.totalPrice;
          } else if (b.paymentStatus === 'Refunded') {
            totalRefunded += b.totalPrice;
          } else if (b.paymentStatus === 'Unpaid') {
            unpaidBalance += b.totalPrice;
          }
        }
      });

      const totalSpent = Math.max(0, totalPaid - totalRefunded);

      const piecesReadyCount = cPieces.filter(p => pieceStageKey(p) === 'ready').length;

      map.set(c.id, {
        totalVisits: visitsList.length,
        totalBookings: cBookings.length,
        upcomingBookingsCount,
        completedBookingsCount,
        cancelledBookingsCount,
        totalSpent,
        totalPaid,
        totalRefunded,
        unpaidBalance,
        totalPieces: cPieces.length,
        piecesReadyCount,
        lastVisitDate,
        visitsList,
        customerBookings: cBookings,
        customerQueue: cQueue,
        customerPieces: cPieces
      });
    });

    return map;
  }, [allDerivedCustomers, bookings, queue, pieces, pipelineStages, todayDateStr]);

  // Global Customer Summary Statistics
  const globalCustomerStats = useMemo(() => {
    const totalCustomers = allDerivedCustomers.length;
    const currentMonth = todayDateStr.slice(0, 7);

    let newThisMonth = 0;
    let returningCustomers = 0;
    let visitedThisMonth = 0;
    let unpaidCount = 0;

    allDerivedCustomers.forEach(c => {
      if (c.createdAt && c.createdAt.startsWith(currentMonth)) {
        newThisMonth++;
      }
      const metrics = customerMetricsMap.get(c.id);
      if (metrics) {
        if (metrics.totalVisits > 1) returningCustomers++;
        if (metrics.lastVisitDate !== '-' && metrics.lastVisitDate.startsWith(currentMonth)) visitedThisMonth++;
        if (metrics.unpaidBalance > 0) unpaidCount++;
      }
    });

    return {
      totalCustomers,
      newThisMonth,
      returningCustomers,
      visitedThisMonth,
      unpaidCount
    };
  }, [allDerivedCustomers, customerMetricsMap, todayDateStr]);

  // Filtered customers list
  const filteredCustomers = useMemo(() => {
    return allDerivedCustomers.filter(c => {
      const metrics = customerMetricsMap.get(c.id);

      // Search matching (Name, Phone normalized or raw, Email, ID)
      if (debouncedSearch.trim()) {
        const q = debouncedSearch.trim().toLowerCase();
        const normQ = getNormalizedPhone(debouncedSearch);
        const normPhone = getNormalizedPhone(c.phone);

        // `c.phone` is optional on a derived customer, so it is read through
        // the shared helper rather than directly.
        const matchText = matchesQuery([c.name, c.email, c.id, c.phone], q);
        const matchPhone = !!(normQ && normPhone && normPhone.includes(normQ));

        if (!matchText && !matchPhone) {
          return false;
        }
      }

      // Source Filter — derived activity categories, not a registration source
      if (sourceFilter !== 'All') {
        const categories = customerCategoriesMap.get(c.id) || [];
        if (!categories.includes(sourceFilter as ActivityCategory)) {
          return false;
        }
      }

      // Account Type Filter — decided purely by the authentication link.
      // Source text, email presence, bookings and payments play no part.
      if (!matchesAccountType(c, accountTypeFilter)) {
        return false;
      }

      // Upcoming bookings filter
      if (hasUpcomingFilter && (!metrics || metrics.upcomingBookingsCount === 0)) {
        return false;
      }

      // Unpaid balance filter
      if (hasUnpaidFilter && (!metrics || metrics.unpaidBalance === 0)) {
        return false;
      }

      return true;
    });
  }, [allDerivedCustomers, customerMetricsMap, customerCategoriesMap, debouncedSearch, sourceFilter, accountTypeFilter, hasUpcomingFilter, hasUnpaidFilter]);

  // Reset page to 1 whenever filters or search query changes
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, sourceFilter, accountTypeFilter, hasUpcomingFilter, hasUnpaidFilter]);

  const totalCustomerPages = Math.max(1, Math.ceil(filteredCustomers.length / CUSTOMERS_PER_PAGE));
  const paginatedCustomers = useMemo(() => {
    const start = (currentPage - 1) * CUSTOMERS_PER_PAGE;
    return filteredCustomers.slice(start, start + CUSTOMERS_PER_PAGE);
  }, [filteredCustomers, currentPage]);

  // Currently selected customer object
  const selectedCustomer = useMemo(() => {
    if (!selectedCustomerId) return null;
    return allDerivedCustomers.find(c => c.id === selectedCustomerId) || null;
  }, [selectedCustomerId, allDerivedCustomers]);

  const selectedCustomerMetrics = useMemo(() => {
    if (!selectedCustomer) return null;
    return customerMetricsMap.get(selectedCustomer.id) || null;
  }, [selectedCustomer, customerMetricsMap]);

  // Handle Manual Customer Creation
  const handleSaveNewCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    const rawPhone = `${createCountryCode}${createNationalPhone}`;

    // The shared layer owns the rules, including the duplicate checks against
    // the customers table.
    const fieldErrors = await validateCustomerForm(
      { name: createName, phone: rawPhone, email: createEmail },
      { requireEmail: false, lang }
    );
    setCreateFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      // Surface the existing record alongside the message.
      const clash = allDerivedCustomers.find(c => {
        const key = getNormalizedPhone(c.phone);
        if (key && key === getNormalizedPhone(rawPhone)) return true;
        return !!createEmail.trim() && canonicalEmail(c.email) === canonicalEmail(createEmail);
      });
      if (clash) setDuplicateMatch(clash);
      return;
    }

    const normPhone = canonicalPhone(rawPhone);
    const normEmail = canonicalEmail(createEmail);

    // Proceed with creation
    const newCustData: Omit<CustomerAccount, 'id' | 'createdAt'> = {
      name: createName.trim(),
      phone: normPhone,
      email: normEmail || '',
      source: createSource || 'Manual Admin Entry',
      status: 'Active',
      notes: createNotes.trim(),
      hasAccount: false
    };

    const res = await addCustomer(newCustData);
    if (res.success) {
      setIsCreateModalOpen(false);
      resetCreateForm();
      if (res.customerId) {
        setSelectedCustomerId(res.customerId);
      }
    } else {
      setCreateError(res.error || t('Failed to create customer record.', 'تعذّر إنشاء سجل العميل.'));
    }
  };

  const resetCreateForm = () => {
    setCreateName('');
    setCreateCountryCode('+966');
    setCreateNationalPhone('');
    setCreateEmail('');
    setCreateSource('Admin Created');
    setCreateNotes('');
    setCreateStatus('Active');
    setDuplicateMatch(null);
    setCreateError(null);
  };

  // Handle Customer Edit
  const handleSaveEditCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerToEdit) return;
    setEditError(null);

    // Same shared rules as every other customer-writing form. `excludeId`
    // stops the record being reported as a duplicate of itself.
    const fieldErrors = await validateCustomerForm(
      { name: customerToEdit.name, phone: customerToEdit.phone, email: customerToEdit.email },
      { excludeId: customerToEdit.id, requireEmail: false, lang }
    );
    setEditFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const normPhone = canonicalPhone(customerToEdit.phone);
    const normEmail = canonicalEmail(customerToEdit.email);

    const updates: Partial<CustomerAccount> = {
      name: customerToEdit.name.trim(),
      phone: normPhone,
      email: normEmail,
      source: customerToEdit.source,
      status: customerToEdit.status,
      notes: customerToEdit.notes,
      updatedAt: new Date().toISOString()
    };

    const res = await updateCustomer(customerToEdit.id, updates);
    if (res.success) {
      setIsEditModalOpen(false);
      setCustomerToEdit(null);
    } else {
      setEditError(res.error || t('Failed to update customer details.', 'تعذّر تحديث بيانات العميل.'));
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 text-left bg-brand-cream min-h-full animate-in fade-in duration-300">
      
      {/* =========================================================
          IF A SPECIFIC CUSTOMER IS SELECTED -> SHOW DETAILED PROFILE VIEW
          ========================================================= */}
      {selectedCustomer && selectedCustomerMetrics ? (
        <div className="space-y-6">
          
          {/* Top Bar with Back & Edit Buttons */}
          <div className="flex flex-wrap justify-between items-center gap-4 bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
            <BackButton onClick={() => setSelectedCustomerId(null)}>
              {t('Back to Customers Directory', 'العودة إلى دليل العملاء')}
            </BackButton>

            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setCustomerToEdit(selectedCustomer);
                  setIsEditModalOpen(true);
                }}
                className="inline-flex items-center gap-2 bg-brand-sand border border-brand-clay/80 px-4 py-2 rounded-xl text-xs font-bold text-brand-charcoal hover:bg-brand-clay/30 transition-all cursor-pointer"
              >
                <Edit className="h-4 w-4 text-brand-terracotta" />
                <span>{t('Edit Profile', 'تعديل الملف الشخصي')}</span>
              </button>
            </div>
          </div>

          {/* Customer Header Card */}
          <div className="bg-white border border-brand-clay/70 rounded-3xl p-6 shadow-2xs space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-brand-clay/50 pb-6">
              <div className="flex items-center gap-4">
                <div className="h-16 w-16 rounded-2xl bg-brand-terracotta/10 border border-brand-terracotta/30 flex items-center justify-center text-brand-terracotta font-display text-2xl font-bold shrink-0">
                  {selectedCustomer.name.charAt(0).toUpperCase()}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h1 className="font-display text-2xl font-bold text-brand-charcoal">{selectedCustomer.name}</h1>
                    <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-brand-sand text-brand-terracotta border border-brand-clay/60">
                      {selectedCustomer.id}
                    </span>
                    {(customerCategoriesMap.get(selectedCustomer.id) || []).map(cat => (
                      <span
                        key={cat}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${categoryBadgeClass(cat)}`}
                      >
                        {enumLabel('category', cat, lang)}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-brand-charcoal/70">
                    <span className="flex items-center gap-1.5">
                      <Phone className="h-3.5 w-3.5 text-brand-terracotta" />
                      {selectedCustomer.phone}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-brand-terracotta" />
                      {selectedCustomer.email || <span className="text-brand-charcoal/40 italic">{t('No email provided', 'لم يُدخل بريد إلكتروني')}</span>}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-6 text-xs text-brand-charcoal/70 bg-brand-cream/50 p-3.5 rounded-2xl border border-brand-clay/40">
                <div>
                  <p className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">{t('Customer Since', 'عميل منذ')}</p>
                  <p className="font-bold text-brand-charcoal mt-0.5">{selectedCustomer.createdAt ? selectedCustomer.createdAt.split('T')[0] : '2026-07-01'}</p>
                </div>
                <div className="h-8 w-px bg-brand-clay/50"></div>
                <div>
                  <p className="text-[10px] font-bold text-brand-sage uppercase tracking-wider">{t('Last Visit', 'آخر زيارة')}</p>
                  <p className="font-bold text-brand-charcoal mt-0.5">{selectedCustomerMetrics.lastVisitDate}</p>
                </div>
              </div>
            </div>

            {/* Quick Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2">
              <div className="bg-brand-sand/30 border border-brand-clay/50 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Completed Visits', 'الزيارات المكتملة')}</p>
                <p className="text-xl font-bold text-brand-terracotta mt-1">{selectedCustomerMetrics.totalVisits}</p>
              </div>
              <div className="bg-brand-sand/30 border border-brand-clay/50 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Total Bookings', 'إجمالي الحجوزات')}</p>
                <p className="text-xl font-bold text-brand-charcoal mt-1">{selectedCustomerMetrics.totalBookings}</p>
              </div>
              <div className="bg-brand-sand/30 border border-brand-clay/50 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Total Spent', 'إجمالي الإنفاق')}</p>
                <p className="text-xl font-bold text-emerald-700 mt-1">{selectedCustomerMetrics.totalSpent} {t('SAR', 'ريال')}</p>
              </div>
              <div className="bg-brand-sand/30 border border-brand-clay/50 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Unpaid Balance', 'الرصيد غير المدفوع')}</p>
                <p className={`text-xl font-bold mt-1 ${selectedCustomerMetrics.unpaidBalance > 0 ? 'text-red-600' : 'text-brand-charcoal/60'}`}>
                  {selectedCustomerMetrics.unpaidBalance} {t('SAR', 'ريال')}
                </p>
              </div>
              <div className="bg-brand-sand/30 border border-brand-clay/50 p-3 rounded-2xl">
                <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase">{t('Pottery Pieces', 'قطع الفخار')}</p>
                <p className="text-xl font-bold text-brand-charcoal mt-1">{selectedCustomerMetrics.totalPieces}</p>
              </div>
            </div>
          </div>

          {/* Detailed Tabs Header */}
          <div className="border-b border-brand-clay flex items-center gap-2 overflow-x-auto no-scrollbar">
            <button
              onClick={() => setProfileTab('overview')}
              className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
                profileTab === 'overview'
                  ? 'border-brand-terracotta text-brand-terracotta'
                  : 'border-transparent text-brand-charcoal/60 hover:text-brand-charcoal'
              }`}
            >
              <UserCheck className="h-4 w-4" />
              <span>{t('Overview & Notes', 'نظرة عامة وملاحظات')}</span>
            </button>

            <button
              onClick={() => setProfileTab('visits')}
              className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
                profileTab === 'visits'
                  ? 'border-brand-terracotta text-brand-terracotta'
                  : 'border-transparent text-brand-charcoal/60 hover:text-brand-charcoal'
              }`}
            >
              <History className="h-4 w-4" />
              <span>{t('Visits History', 'سجل الزيارات')} ({selectedCustomerMetrics.totalVisits})</span>
            </button>

            <button
              onClick={() => setProfileTab('bookings')}
              className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
                profileTab === 'bookings'
                  ? 'border-brand-terracotta text-brand-terracotta'
                  : 'border-transparent text-brand-charcoal/60 hover:text-brand-charcoal'
              }`}
            >
              <Calendar className="h-4 w-4" />
              <span>{t('Bookings', 'الحجوزات')} ({selectedCustomerMetrics.totalBookings})</span>
            </button>

            <button
              onClick={() => setProfileTab('payments')}
              className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
                profileTab === 'payments'
                  ? 'border-brand-terracotta text-brand-terracotta'
                  : 'border-transparent text-brand-charcoal/60 hover:text-brand-charcoal'
              }`}
            >
              <CreditCard className="h-4 w-4" />
              <span>{t('Payments', 'المدفوعات')} ({selectedCustomerMetrics.totalSpent} {t('SAR', 'ريال')})</span>
            </button>

            <button
              onClick={() => setProfileTab('pieces')}
              className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${
                profileTab === 'pieces'
                  ? 'border-brand-terracotta text-brand-terracotta'
                  : 'border-transparent text-brand-charcoal/60 hover:text-brand-charcoal'
              }`}
            >
              <Flame className="h-4 w-4" />
              <span>{t('Pottery Pieces', 'قطع الفخار')} ({selectedCustomerMetrics.totalPieces})</span>
            </button>
          </div>

          {/* TAB 1: OVERVIEW & NOTES */}
          {profileTab === 'overview' && (
            <div className="bg-white border border-brand-clay/70 rounded-2xl p-6 shadow-2xs space-y-4">
              <h3 className="font-display font-bold text-lg text-brand-charcoal flex items-center gap-2">
                <UserCheck className="h-5 w-5 text-brand-terracotta" />
                <span>{t('Internal Customer Notes & Preferences', 'ملاحظات وتفضيلات العميل الداخلية')}</span>
              </h3>
              <p className="text-xs text-brand-charcoal/60">
                {t('Notes are private to staff and never shared with the customer.', 'الملاحظات خاصة بالموظفين ولا تُشارك مع العميل أبدًا.')}
              </p>

              <textarea
                rows={4}
                value={selectedCustomer.notes || ''}
                onChange={async (e) => {
                  const newNotes = e.target.value;
                  await updateCustomer(selectedCustomer.id, { notes: newNotes });
                }}
                placeholder={t('Add optional notes, seating preferences, pottery interests, or birthday reminders...', 'أضف ملاحظات اختيارية أو تفضيلات الجلوس أو اهتمامات الفخار أو تذكيرات أعياد الميلاد...')}
                className="w-full bg-brand-cream/50 border border-brand-clay rounded-xl p-3 text-xs font-medium text-brand-charcoal resize-y focus:outline-none focus:border-brand-terracotta"
              />

              <div className="p-4 rounded-xl bg-brand-sand/30 border border-brand-clay/50 text-xs space-y-2">
                <p className="font-bold text-brand-charcoal">{t('Account Integration Status', 'حالة ربط الحساب')}</p>
                <p className="flex items-start gap-1.5 text-brand-charcoal/70">
                  {hasWebsiteAccount(selectedCustomer) ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-sage" />
                  ) : (
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-charcoal/45" />
                  )}
                  <span>
                    {hasWebsiteAccount(selectedCustomer)
                      ? t('Linked to an active website account (Customer can log in).', 'مرتبط بحساب نشط على الموقع (يمكن للعميل تسجيل الدخول).')
                      : t('Guest / Walk-in profile (No online login created yet). If this customer creates a website account later with matching phone/email, it will connect automatically.', 'ملف زائر / زيارة مباشرة (لم يُنشأ تسجيل دخول عبر الإنترنت بعد). إذا أنشأ العميل حسابًا على الموقع لاحقًا بنفس رقم الهاتف أو البريد الإلكتروني، فسيتم الربط تلقائيًا.')}
                  </span>
                </p>
              </div>
            </div>
          )}

          {/* TAB 2: VISITS HISTORY */}
          {profileTab === 'visits' && (
            <div className="bg-white border border-brand-clay/70 rounded-2xl p-6 shadow-2xs space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="font-display font-bold text-lg text-brand-charcoal">{t('Verified Completed Visits', 'الزيارات المكتملة الموثّقة')}</h3>
                  <p className="text-xs text-brand-charcoal/60">
                    {t('Includes completed Live Queue sessions and checked-in workshop or birthday package attendances. Unchecked-in drafts or cancelled bookings are excluded.', 'تشمل جلسات الطابور المباشر المكتملة وحضور الورش أو باقات أعياد الميلاد المسجَّل حضورها. لا تشمل المسودات غير المسجَّل حضورها أو الحجوزات الملغاة.')}
                  </p>
                </div>
                <span className="font-bold text-xs bg-brand-sand text-brand-terracotta border border-brand-clay/60 px-3 py-1 rounded-xl">
                  {t('Total Visits:', 'إجمالي الزيارات:')} {selectedCustomerMetrics.totalVisits}
                </span>
              </div>

              {selectedCustomerMetrics.visitsList.length === 0 ? (
                <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/40 rounded-xl border border-dashed border-brand-clay">
                  {t('No verified completed visits recorded yet for this customer.', 'لا توجد زيارات مكتملة موثّقة لهذا العميل حتى الآن.')}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-brand-clay/50 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                        <th className="py-2.5">{t('Visit Date', 'تاريخ الزيارة')}</th>
                        <th className="py-2.5">{t('Check-in Time', 'وقت تسجيل الحضور')}</th>
                        <th className="py-2.5">{t('Visit Type', 'نوع الزيارة')}</th>
                        <th className="py-2.5">{t('Activity / Title', 'النشاط / العنوان')}</th>
                        <th className="py-2.5">{t('Guests', 'الضيوف')}</th>
                        <th className="py-2.5">{t('Instructor / Staff', 'المدرب / الموظف')}</th>
                        <th className="py-2.5">{t('Booking Ref', 'مرجع الحجز')}</th>
                        <th className="py-2.5">{t('Payment Status', 'حالة الدفع')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-clay/30">
                      {selectedCustomerMetrics.visitsList.map(v => (
                        <tr key={v.id} className="hover:bg-brand-sand/15 font-medium">
                          <td className="py-3 font-bold text-brand-charcoal">{v.date}</td>
                          <td className="py-3 font-mono">{v.time}</td>
                          <td className="py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${
                              v.type === 'Birthday Package' ? 'bg-pink-50 text-pink-800 border-pink-200' :
                              v.type === 'Live Queue Walk-in' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                              'bg-blue-50 text-blue-800 border-blue-200'
                            }`}>
                              {enumLabel('visitType', v.type, lang)}
                            </span>
                          </td>
                          <td className="py-3 font-bold text-brand-charcoal">{displayActivity(v.title, t)}</td>
                          <td className="py-3 font-mono">{v.guests} {t('person(s)', 'شخص')}</td>
                          <td className="py-3 text-brand-charcoal/70">{v.staff || t('Studio Staff', 'طاقم الاستوديو')}</td>
                          <td className="py-3 font-mono text-brand-terracotta">{v.bookingId || '-'}</td>
                          <td className="py-3">
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                              {enumLabel('payment', v.paymentStatus, lang)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: BOOKINGS HISTORY */}
          {profileTab === 'bookings' && (
            <div className="bg-white border border-brand-clay/70 rounded-2xl p-6 shadow-2xs space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-4">
                <h3 className="font-display font-bold text-lg text-brand-charcoal">{t('Customer Bookings History', 'سجل حجوزات العميل')}</h3>
                <div className="flex items-center gap-2">
                  {(['all', 'upcoming', 'completed', 'cancelled'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setBookingHistoryFilter(f)}
                      className={`px-3 py-1 rounded-xl text-xs font-bold capitalize transition-all cursor-pointer ${
                        bookingHistoryFilter === f 
                          ? 'bg-brand-terracotta text-brand-cream shadow-2xs' 
                          : 'bg-brand-sand text-brand-charcoal/70 hover:bg-brand-clay/40'
                      }`}
                    >
                      {f === 'all' ? t('all', 'الكل') : f === 'upcoming' ? t('upcoming', 'القادمة') : enumLabel('bookingStatus', f === 'completed' ? 'Completed' : 'Cancelled', lang)}
                    </button>
                  ))}
                </div>
              </div>

              {selectedCustomerMetrics.customerBookings.length === 0 ? (
                <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/40 rounded-xl border border-dashed border-brand-clay">
                  {t('No bookings found for this customer.', 'لا توجد حجوزات لهذا العميل.')}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-brand-clay/50 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                        <th className="py-2.5">{t('Booking ID', 'رقم الحجز')}</th>
                        <th className="py-2.5">{t('Session Date & Time', 'تاريخ ووقت الجلسة')}</th>
                        <th className="py-2.5">{t('Workshop / Event', 'الورشة / الفعالية')}</th>
                        <th className="py-2.5">{t('Participants', 'المشاركون')}</th>
                        <th className="py-2.5">{t('Source', 'المصدر')}</th>
                        <th className="py-2.5">{t('Status', 'الحالة')}</th>
                        <th className="py-2.5">{t('Total Amount', 'المبلغ الإجمالي')}</th>
                        <th className="py-2.5">{t('Payment', 'الدفع')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-clay/30">
                      {selectedCustomerMetrics.customerBookings
                        .filter(b => {
                          if (bookingHistoryFilter === 'upcoming') return b.date >= todayDateStr && b.status !== 'Cancelled';
                          if (bookingHistoryFilter === 'completed') return b.status === 'Completed';
                          if (bookingHistoryFilter === 'cancelled') return b.status === 'Cancelled';
                          return true;
                        })
                        .map(b => (
                          <tr key={b.id} className="hover:bg-brand-sand/15 font-medium">
                            <td className="py-3 font-mono font-bold text-brand-terracotta">{b.id}</td>
                            <td className="py-3">
                              <p className="font-bold text-brand-charcoal">{b.date}</p>
                              <p className="text-[10px] text-brand-charcoal/50 font-mono">{b.time}</p>
                            </td>
                            <td className="py-3 font-bold text-brand-charcoal">{b.workshopTitle}</td>
                            <td className="py-3 font-mono">{b.participants} {t('guests', 'ضيوف')}</td>
                            <td className="py-3 text-brand-charcoal/70">{enumLabel('source', b.source, lang)}</td>
                            <td className="py-3">
                              <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                                b.status === 'Completed' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                                b.status === 'Cancelled' ? 'bg-red-50 text-red-800 border-red-200' :
                                'bg-amber-50 text-amber-800 border-amber-200'
                              }`}>
                                {enumLabel('bookingStatus', b.status, lang)}
                              </span>
                            </td>
                            <td className="py-3 font-bold text-brand-charcoal">{b.totalPrice} {t('SAR', 'ريال')}</td>
                            <td className="py-3">
                              <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                                b.paymentStatus === 'Paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                                b.paymentStatus === 'Refunded' ? 'bg-purple-50 text-purple-800 border-purple-200' :
                                'bg-red-50 text-red-800 border-red-200'
                              }`}>
                                {enumLabel('payment', b.paymentStatus, lang)}
                              </span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: PAYMENTS INFORMATION */}
          {profileTab === 'payments' && (
            <div className="bg-white border border-brand-clay/70 rounded-2xl p-6 shadow-2xs space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-3.5 rounded-2xl bg-emerald-50/60 border border-emerald-200">
                  <p className="text-[10px] font-bold text-emerald-900 uppercase">{t('Total Amount Spent', 'إجمالي المبلغ المنفق')}</p>
                  <p className="text-xl font-bold text-emerald-800 mt-1">{selectedCustomerMetrics.totalSpent} {t('SAR', 'ريال')}</p>
                </div>
                <div className="p-3.5 rounded-2xl bg-blue-50/60 border border-blue-200">
                  <p className="text-[10px] font-bold text-blue-900 uppercase">{t('Total Paid', 'إجمالي المدفوع')}</p>
                  <p className="text-xl font-bold text-blue-800 mt-1">{selectedCustomerMetrics.totalPaid} {t('SAR', 'ريال')}</p>
                </div>
                <div className="p-3.5 rounded-2xl bg-purple-50/60 border border-purple-200">
                  <p className="text-[10px] font-bold text-purple-900 uppercase">{t('Refunded Amount', 'المبلغ المُسترد')}</p>
                  <p className="text-xl font-bold text-purple-800 mt-1">{selectedCustomerMetrics.totalRefunded} {t('SAR', 'ريال')}</p>
                </div>
                <div className="p-3.5 rounded-2xl bg-red-50/60 border border-red-200">
                  <p className="text-[10px] font-bold text-red-900 uppercase">{t('Outstanding Balance', 'الرصيد المستحق')}</p>
                  <p className="text-xl font-bold text-red-700 mt-1">{selectedCustomerMetrics.unpaidBalance} {t('SAR', 'ريال')}</p>
                </div>
              </div>

              <div>
                <h4 className="font-bold text-sm text-brand-charcoal mb-3">{t('Payment History Table', 'جدول سجل المدفوعات')}</h4>
                {selectedCustomerMetrics.customerBookings.length === 0 ? (
                  <p className="text-xs text-brand-charcoal/50 italic py-4">{t('No payment transaction records found.', 'لا توجد سجلات معاملات دفع.')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-brand-clay/50 text-brand-charcoal/50 uppercase tracking-wider font-bold">
                          <th className="py-2.5">{t('Payment Ref', 'مرجع الدفع')}</th>
                          <th className="py-2.5">{t('Related Booking', 'الحجز المرتبط')}</th>
                          <th className="py-2.5">{t('Date', 'التاريخ')}</th>
                          <th className="py-2.5">{t('Amount', 'المبلغ')}</th>
                          <th className="py-2.5">{t('Method', 'الطريقة')}</th>
                          <th className="py-2.5">{t('Status', 'الحالة')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-clay/30">
                        {selectedCustomerMetrics.customerBookings.map(b => (
                          <tr key={`pay-${b.id}`} className="hover:bg-brand-sand/15 font-medium">
                            <td className="py-3 font-mono font-bold text-brand-terracotta">PAY-{b.id.replace('ART-', '')}</td>
                            <td className="py-3 font-bold text-brand-charcoal">{b.id} ({b.workshopTitle})</td>
                            <td className="py-3">{b.date}</td>
                            <td className="py-3 font-bold">{b.totalPrice} {t('SAR', 'ريال')}</td>
                            <td className="py-3 text-brand-charcoal/70">{b.source === 'Website' ? t('Online Mada/Card', 'مدى / بطاقة عبر الإنترنت') : t('Front Desk POS', 'نقطة البيع في الاستقبال')}</td>
                            <td className="py-3">
                              <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                                b.paymentStatus === 'Paid' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                                b.paymentStatus === 'Refunded' ? 'bg-purple-50 text-purple-800 border-purple-200' :
                                'bg-red-50 text-red-800 border-red-200'
                              }`}>
                                {enumLabel('payment', b.paymentStatus, lang)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: POTTERY PIECES */}
          {profileTab === 'pieces' && (
            <div className="bg-white border border-brand-clay/70 rounded-2xl p-6 shadow-2xs space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-display font-bold text-lg text-brand-charcoal">{t('Linked Pottery Pieces', 'قطع الفخار المرتبطة')}</h3>
                <span className="text-xs font-bold text-brand-terracotta">
                  {selectedCustomerMetrics.piecesReadyCount} {enumLabel('pieceStatus', 'Ready for Pickup', lang)}
                </span>
              </div>

              {selectedCustomerMetrics.customerPieces.length === 0 ? (
                <div className="p-8 text-center text-xs text-brand-charcoal/50 italic bg-brand-cream/40 rounded-xl border border-dashed border-brand-clay">
                  {t('No pottery pieces currently linked to this customer profile.', 'لا توجد قطع فخار مرتبطة بملف هذا العميل حاليًا.')}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {selectedCustomerMetrics.customerPieces.map(p => (
                    <div key={p.id} className="bg-brand-cream/40 border border-brand-clay/60 rounded-2xl p-4 space-y-3 flex items-start gap-3">
                      <PieceImage
                        value={p.image}
                        alt={p.name}
                        className="h-16 w-16 rounded-xl object-cover border border-brand-clay shrink-0"
                        fallback={
                          <div className="h-16 w-16 rounded-xl bg-brand-terracotta/10 border border-brand-terracotta/20 flex items-center justify-center text-brand-terracotta shrink-0">
                            <Flame className="h-6 w-6" />
                          </div>
                        }
                      />
                      <div className="flex-1 space-y-1 text-left">
                        <div className="flex justify-between items-start">
                          <span className="font-mono font-bold text-xs text-brand-terracotta">{p.pieceCode || p.id}</span>
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold border ${
                            pieceStageKey(p) === 'ready' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                            pieceStageKey(p) === 'collected' ? 'bg-gray-100 text-gray-700 border-gray-300' :
                            'bg-amber-50 text-amber-800 border-amber-200'
                          }`}>
                            {enumLabel('pieceStatus', p.status, lang)}
                          </span>
                        </div>
                        <p className="font-bold text-xs text-brand-charcoal">{p.name}</p>
                        <p className="text-[10px] text-brand-charcoal/60 line-clamp-1">{p.workshopName}</p>
                        <p className="text-[10px] font-mono text-brand-sage">{t('Ready Date:', 'تاريخ الجاهزية:')} {p.expectedReadyDate || p.expectedCompletion || t('TBD', 'لم يُحدد بعد')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </div>
      ) : (
        /* =========================================================
           DIRECTORY LISTING VIEW (ALL CUSTOMERS)
           ========================================================= */
        <div className="space-y-6">
          
          {/* Header Title & Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl font-bold text-brand-charcoal">{t('Customer Directory', 'دليل العملاء')}</h1>
              <p className="text-xs text-brand-charcoal/60 mt-0.5">
                {t('Centralized registry of workshop participants, walk-in guests, and online members.', 'سجل مركزي لمشاركي الورش والزوار المباشرين وأعضاء الموقع.')}
              </p>
            </div>

            <button
              onClick={() => {
                resetCreateForm();
                setIsCreateModalOpen(true);
              }}
              className="bg-brand-terracotta text-brand-cream px-4 py-2.5 rounded-xl text-xs font-bold hover:bg-brand-terracotta-hover transition-all flex items-center gap-2 shadow-2xs cursor-pointer self-start sm:self-auto"
            >
              <UserPlus className="h-4 w-4" />
              <span>{t('Create Customer', 'إنشاء عميل')}</span>
            </button>
          </div>

          {/* Top 5 Key Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
            <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
              <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase tracking-wider">{t('Total Customers', 'إجمالي العملاء')}</p>
              <p className="text-2xl font-bold text-brand-charcoal mt-1">{globalCustomerStats.totalCustomers}</p>
            </div>
            <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
              <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase tracking-wider">{t('New This Month', 'جدد هذا الشهر')}</p>
              <p className="text-2xl font-bold text-brand-terracotta mt-1">+{globalCustomerStats.newThisMonth}</p>
            </div>
            <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
              <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase tracking-wider">{t('Returning Customers', 'العملاء العائدون')}</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">{globalCustomerStats.returningCustomers}</p>
            </div>
            <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
              <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase tracking-wider">{t('Visited This Month', 'زاروا هذا الشهر')}</p>
              <p className="text-2xl font-bold text-blue-700 mt-1">{globalCustomerStats.visitedThisMonth}</p>
            </div>
            <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs">
              <p className="text-[10px] font-bold text-brand-charcoal/60 uppercase tracking-wider">{t('Unpaid Balances', 'أرصدة غير مدفوعة')}</p>
              <p className={`text-2xl font-bold mt-1 ${globalCustomerStats.unpaidCount > 0 ? 'text-red-600' : 'text-brand-charcoal/60'}`}>
                {globalCustomerStats.unpaidCount}
              </p>
            </div>
          </div>

          {/* Search & Comprehensive Filters Toolbar */}
          <div className="bg-white border border-brand-clay/70 p-4 rounded-2xl shadow-2xs space-y-4">
            <div className="flex flex-col md:flex-row gap-3">
              {/* Search Bar */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-brand-charcoal/40" />
                <input
                  type="text"
                  placeholder={t('Search by name, phone (+966, 050...), email, or Customer ID...', 'ابحث بالاسم أو الهاتف (+966، 050...) أو البريد الإلكتروني أو رقم العميل...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-brand-cream/50 border border-brand-clay/70 rounded-xl pl-9 pr-4 py-2 text-xs font-semibold text-brand-charcoal placeholder-brand-charcoal/40 focus:outline-none focus:border-brand-terracotta"
                />
              </div>

              {/* Source Filter */}
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="bg-brand-cream/50 border border-brand-clay/70 rounded-xl px-3 py-2 text-xs font-bold text-brand-charcoal"
              >
                <option value="All">{t('All Sources', 'كل المصادر')}</option>
                {ACTIVITY_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{enumLabel('category', cat, lang)}</option>
                ))}
              </select>

              {/* Account Type Filter */}
              <select
                value={accountTypeFilter}
                onChange={(e) => setAccountTypeFilter(e.target.value)}
                className="bg-brand-cream/50 border border-brand-clay/70 rounded-xl px-3 py-2 text-xs font-bold text-brand-charcoal"
              >
                <option value="All">{t('All Account Types', 'كل أنواع الحسابات')}</option>
                <option value="Registered">{t('Registered', 'مسجّل')}</option>
                <option value="Guest">{t('Walk-In / Guest', 'زيارة مباشرة / زائر')}</option>
              </select>
            </div>

            {/* Quick Filter Toggles */}
            <div className="flex flex-wrap items-center gap-4 pt-1 border-t border-brand-clay/30 text-xs font-semibold text-brand-charcoal/80">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasUpcomingFilter}
                  onChange={(e) => setHasUpcomingFilter(e.target.checked)}
                  className="rounded text-brand-terracotta focus:ring-brand-terracotta"
                />
                <span>{t('Upcoming Bookings Only', 'الحجوزات القادمة فقط')}</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasUnpaidFilter}
                  onChange={(e) => setHasUnpaidFilter(e.target.checked)}
                  className="rounded text-brand-terracotta focus:ring-brand-terracotta"
                />
                <span className="text-red-700 font-bold">{t('Unpaid Balances Only', 'الأرصدة غير المدفوعة فقط')}</span>
              </label>
            </div>
          </div>

          {/* Customers Table */}
          <div className="bg-white border border-brand-clay/70 rounded-2xl shadow-2xs overflow-hidden">
            {filteredCustomers.length === 0 ? (
              <div className="p-12 text-center space-y-3">
                <Users className="h-10 w-10 text-brand-charcoal/30 mx-auto" />
                <p className="text-sm font-bold text-brand-charcoal">{t('No customer records match your filters.', 'لا توجد سجلات عملاء تطابق عوامل التصفية.')}</p>
                <p className="text-xs text-brand-charcoal/50">{t('Try resetting your search query or selecting a different source filter.', 'جرّب إعادة ضبط البحث أو اختيار مصدر مختلف.')}</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="bg-brand-sand/30 border-b border-brand-clay/60 text-brand-charcoal/60 uppercase tracking-wider font-bold">
                        <th className="py-3 px-4">{t('Customer ID', 'رقم العميل')}</th>
                        <th className="py-3 px-4">{t('Full Name', 'الاسم الكامل')}</th>
                        <th className="py-3 px-4">{t('Phone Number', 'رقم الهاتف')}</th>
                        <th className="py-3 px-4">{t('Email Address', 'البريد الإلكتروني')}</th>
                        <th className="py-3 px-4">{t('Source', 'المصدر')}</th>
                        <th className="py-3 px-4">{t('Account Type', 'نوع الحساب')}</th>
                        <th className="py-3 px-4">{t('Visits', 'الزيارات')}</th>
                        <th className="py-3 px-4">{t('Bookings', 'الحجوزات')}</th>
                        <th className="py-3 px-4">{t('Total Spent', 'إجمالي الإنفاق')}</th>
                        <th className="py-3 px-4">{t('Unpaid Balance', 'الرصيد غير المدفوع')}</th>
                        <th className="py-3 px-4">{t('Last Visit', 'آخر زيارة')}</th>
                        <th className="py-3 px-4 text-right">{t('Actions', 'الإجراءات')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-clay/30">
                      {paginatedCustomers.map(c => {
                        const metrics = customerMetricsMap.get(c.id);
                        return (
                          <tr key={c.id} className="hover:bg-brand-sand/20 transition-colors font-medium">
                            <td className="py-3 px-4 font-mono font-bold text-brand-terracotta">{c.id}</td>
                            <td className="py-3 px-4 font-bold text-brand-charcoal">{c.name}</td>
                            <td className="py-3 px-4 font-mono text-brand-charcoal/90">{c.phone}</td>
                            <td className="py-3 px-4 text-brand-charcoal/70">
                              {c.email || <span className="text-brand-charcoal/40 italic">—</span>}
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap gap-1">
                                {(customerCategoriesMap.get(c.id) || []).length === 0 ? (
                                  <span className="text-brand-charcoal/40 italic text-[10px]">{t('No activity yet', 'لا يوجد نشاط بعد')}</span>
                                ) : (
                                  (customerCategoriesMap.get(c.id) || []).map(cat => (
                                    <span
                                      key={cat}
                                      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${categoryBadgeClass(cat)}`}
                                    >
                                      {enumLabel('category', cat, lang)}
                                    </span>
                                  ))
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              {/* Reflects the authentication link only */}
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${
                                hasWebsiteAccount(c)
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-gray-100 text-gray-700 border-gray-200'
                              }`}>
                                {getAccountType(c) === 'Registered' ? t('Registered', 'مسجّل') : t('Walk-In / Guest', 'زيارة مباشرة / زائر')}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-bold text-center">{metrics ? metrics.totalVisits : 0}</td>
                            <td className="py-3 px-4 font-mono text-center">{metrics ? metrics.totalBookings : 0}</td>
                            <td className="py-3 px-4 font-bold text-emerald-800">{metrics ? `${metrics.totalSpent} ${t('SAR', 'ريال')}` : `0 ${t('SAR', 'ريال')}`}</td>
                            <td className="py-3 px-4 font-bold">
                              {metrics && metrics.unpaidBalance > 0 ? (
                                <span className="text-red-600 font-bold">{metrics.unpaidBalance} {t('SAR', 'ريال')}</span>
                              ) : (
                                <span className="text-brand-charcoal/40">0 {t('SAR', 'ريال')}</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-brand-charcoal/70">{metrics ? metrics.lastVisitDate : '-'}</td>
                            <td className="py-3 px-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => setSelectedCustomerId(c.id)}
                                  className="bg-brand-terracotta/10 text-brand-terracotta hover:bg-brand-terracotta hover:text-brand-cream px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer"
                                >
                                  {t('View Details', 'عرض التفاصيل')}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* PAGINATION FOOTER (10 customers per page) */}
                <div className="p-4 border-t border-brand-clay/40 bg-brand-sand/10 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <p className="text-xs font-semibold text-brand-charcoal/60">
                    {lang === 'ar'
                      ? <>عرض <span className="font-bold text-brand-charcoal">{(currentPage - 1) * CUSTOMERS_PER_PAGE + 1}</span>–<span className="font-bold text-brand-charcoal">{Math.min(currentPage * CUSTOMERS_PER_PAGE, filteredCustomers.length)}</span> من <span className="font-bold text-brand-charcoal">{filteredCustomers.length}</span> عميل</>
                      : <>Showing <span className="font-bold text-brand-charcoal">{(currentPage - 1) * CUSTOMERS_PER_PAGE + 1}</span>–<span className="font-bold text-brand-charcoal">{Math.min(currentPage * CUSTOMERS_PER_PAGE, filteredCustomers.length)}</span> of <span className="font-bold text-brand-charcoal">{filteredCustomers.length}</span> customers</>}
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
                      {t('Page', 'الصفحة')} {currentPage} {t('of', 'من')} {totalCustomerPages}
                    </span>
                    <button
                      type="button"
                      disabled={currentPage >= totalCustomerPages}
                      onClick={() => setCurrentPage(prev => Math.min(totalCustomerPages, prev + 1))}
                      className="px-3 py-1.5 bg-white border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-sand transition-colors cursor-pointer"
                    >
                      {t('Next', 'التالي')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

        </div>
      )}

      {/* =========================================================
          MODAL: CREATE CUSTOMER FORM & DUPLICATE WARNING
          ========================================================= */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-brand-clay rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200 text-left">
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <h2 className="font-display font-bold text-lg text-brand-charcoal flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-brand-terracotta" />
                <span>{t('Create New Customer Record', 'إنشاء سجل عميل جديد')}</span>
              </h2>
              <button onClick={() => setIsCreateModalOpen(false)} aria-label={t('Close', 'إغلاق')} className="text-brand-charcoal/40 hover:text-brand-charcoal cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* If Duplicate match detected, display warning banner */}
            {duplicateMatch ? (
              <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-xs text-amber-900">
                    <p className="font-bold text-sm">{t('Potential Duplicate Customer Found!', 'تم العثور على عميل مكرر محتمل!')}</p>
                    <p>{t('A customer record with matching phone or email already exists in the system:', 'يوجد بالفعل سجل عميل بنفس رقم الهاتف أو البريد الإلكتروني في النظام:')}</p>
                    <div className="p-3 bg-white/80 rounded-xl border border-amber-200 space-y-1 font-medium mt-2">
                      <p><span className="font-bold">{t('Name:', 'الاسم:')}</span> {duplicateMatch.name}</p>
                      <p><span className="font-bold">{t('ID:', 'الرقم:')}</span> {duplicateMatch.id}</p>
                      <p><span className="font-bold">{t('Phone:', 'الهاتف:')}</span> {duplicateMatch.phone}</p>
                      <p><span className="font-bold">{t('Email:', 'البريد الإلكتروني:')}</span> {duplicateMatch.email}</p>
                      <p><span className="font-bold">{t('Source:', 'المصدر:')}</span> {enumLabel('customerSource', duplicateMatch.source ?? '', lang)}</p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateModalOpen(false);
                      setSelectedCustomerId(duplicateMatch.id);
                      setDuplicateMatch(null);
                    }}
                    className="flex-1 bg-brand-terracotta text-brand-cream py-2 rounded-xl text-xs font-bold hover:bg-brand-terracotta-hover transition-colors cursor-pointer"
                  >
                    {t('Open Existing Customer Profile', 'فتح ملف العميل الحالي')}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      // Goes through the same shared rules as the form, so this
                      // button can no longer create the duplicate the panel is
                      // warning about.
                      const rawPhone = `${createCountryCode}${createNationalPhone}`;
                      const fieldErrors = await validateCustomerForm(
                        { name: createName, phone: rawPhone, email: createEmail },
                        { requireEmail: false, lang }
                      );
                      if (Object.keys(fieldErrors).length > 0) {
                        setCreateFieldErrors(fieldErrors);
                        setCreateError(Object.values(fieldErrors)[0]);
                        setDuplicateMatch(null);
                        return;
                      }
                      const res = await addCustomer({
                        name: createName.trim(),
                        phone: canonicalPhone(rawPhone),
                        email: canonicalEmail(createEmail) || `cust-${Math.floor(1000 + Math.random() * 9000)}@guest.artycafe.sa`,
                        source: createSource || 'Admin Created',
                        status: createStatus || 'Active',
                        notes: createNotes.trim(),
                        hasAccount: false
                      });
                      if (res.success) {
                        setIsCreateModalOpen(false);
                        resetCreateForm();
                        if (res.customerId) setSelectedCustomerId(res.customerId);
                      }
                    }}
                    className="bg-brand-sand text-brand-charcoal border border-brand-clay py-2 px-3 rounded-xl text-xs font-bold hover:bg-brand-clay/30 transition-colors cursor-pointer"
                  >
                    {t('Create Separate Record Anyway', 'إنشاء سجل منفصل على أي حال')}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSaveNewCustomer} className="space-y-4 text-xs">
                {createError && (
                  <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-semibold">
                    {createError}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal block">{t('Full Name *', 'الاسم الكامل *')}</label>
                  <input
                    type="text"
                    required
                    placeholder={t('E.g. Noura Al-Amri', 'مثال: نورة العمري')}
                    value={createName}
                    onChange={(e) => { setCreateName(e.target.value); clearCreateFieldError('name'); }}
                    className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal"
                  />
                  {createFieldErrors.name && (
                    <p className="text-[11px] text-red-500 font-bold">{createFieldErrors.name}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal block">{t('Phone Number * (+966 default)', 'رقم الهاتف * (الافتراضي +966)')}</label>
                  <PhoneInput
                    value={normalisePhone(createCountryCode, createNationalPhone)}
                    error={createFieldErrors.phone}
                    onChange={(full) => {
                      // PhoneInput reports one already-normalised number; split it
                      // back into the two pieces this form keeps.
                      const parts = parsePhoneComponents(full);
                      setCreateCountryCode(parts.countryCode);
                      setCreateNationalPhone(parts.nationalNumber);
                      clearCreateFieldError('phone');
                    }}
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal block">{t('Email Address (Optional for walk-in)', 'البريد الإلكتروني (اختياري للزيارة المباشرة)')}</label>
                  <input
                    type="email"
                    placeholder="e.g. noura@example.sa"
                    value={createEmail}
                    onChange={(e) => { setCreateEmail(e.target.value); clearCreateFieldError('email'); }}
                    className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                  />
                  {createFieldErrors.email && (
                    <p className="text-[11px] text-red-500 font-bold">{createFieldErrors.email}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal block">{t('Source (Activity)', 'المصدر (النشاط)')}</label>
                    <p className="text-[11px] font-semibold text-brand-charcoal/60 bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5">
                      {t("Set automatically from the customer's bookings and queue visits (Workshops, Events/Birthdays, Self-Guided).", 'يُحدَّد تلقائيًا من حجوزات العميل وزياراته عبر الطابور (الورش، الفعاليات وأعياد الميلاد، ذاتي التوجيه).')}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal block">{t('Account Status', 'حالة الحساب')}</label>
                    <select
                      value={createStatus}
                      onChange={(e) => setCreateStatus(e.target.value as any)}
                      className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                    >
                      <option value="Active">{enumLabel('customerStatus', 'Active', lang)}</option>
                      <option value="VIP">{enumLabel('customerStatus', 'VIP', lang)}</option>
                      <option value="Inactive">{enumLabel('customerStatus', 'Inactive', lang)}</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal block">{t('Internal Notes', 'ملاحظات داخلية')}</label>
                  <textarea
                    rows={2}
                    placeholder={t('Add optional notes about the customer...', 'أضف ملاحظات اختيارية عن العميل...')}
                    value={createNotes}
                    onChange={(e) => setCreateNotes(e.target.value)}
                    className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold text-brand-charcoal text-xs resize-y"
                  />
                </div>

                <div className="flex items-start gap-1.5 p-3 bg-brand-sand/30 rounded-xl text-[11px] text-brand-charcoal/70">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-charcoal/45" />
                  <span>{t('Manual creation saves a customer profile without establishing an online password account unless explicitly registered.', 'يحفظ الإنشاء اليدوي ملف عميل دون إنشاء حساب بكلمة مرور على الإنترنت ما لم يُسجَّل صراحةً.')}</span>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-4 py-2 border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal/70 hover:bg-brand-sand/50 transition-colors cursor-pointer"
                  >
                    {t('Cancel', 'إلغاء')}
                  </button>
                  <button
                    type="submit"
                    className="bg-brand-terracotta text-brand-cream px-5 py-2 rounded-xl text-xs font-bold hover:bg-brand-terracotta-hover transition-colors cursor-pointer"
                  >
                    {t('Save Customer Record', 'حفظ سجل العميل')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* =========================================================
          MODAL: EDIT CUSTOMER FORM
          ========================================================= */}
      {isEditModalOpen && customerToEdit && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-brand-clay rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 text-left">
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <h2 className="font-display font-bold text-lg text-brand-charcoal flex items-center gap-2">
                <Edit className="h-5 w-5 text-brand-terracotta" />
                <span>{t('Edit Customer Profile', 'تعديل ملف العميل')} ({customerToEdit.id})</span>
              </h2>
              <button onClick={() => setIsEditModalOpen(false)} aria-label={t('Close', 'إغلاق')} className="text-brand-charcoal/40 hover:text-brand-charcoal cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditCustomer} className="space-y-4 text-xs">
              {editError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-semibold">
                  {editError}
                </div>
              )}

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal block">{t('Full Name *', 'الاسم الكامل *')}</label>
                <input
                  type="text"
                  required
                  value={customerToEdit.name}
                  onChange={(e) => setCustomerToEdit({ ...customerToEdit, name: e.target.value })}
                  className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal"
                />
                {editFieldErrors.name && (
                  <p className="text-[11px] text-red-500 font-bold">{editFieldErrors.name}</p>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal block">{t('Phone Number *', 'رقم الهاتف *')}</label>
                <PhoneInput
                  value={customerToEdit.phone}
                  error={editFieldErrors.phone}
                  onChange={(full) => {
                    setCustomerToEdit({ ...customerToEdit, phone: full });
                    setEditFieldErrors(prev => (prev.phone ? { ...prev, phone: '' } : prev));
                  }}
                />
              </div>

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal block">{t('Email Address', 'البريد الإلكتروني')}</label>
                <input
                  type="email"
                  value={customerToEdit.email}
                  onChange={(e) => setCustomerToEdit({ ...customerToEdit, email: e.target.value })}
                  className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                />
                {editFieldErrors.email && (
                  <p className="text-[11px] text-red-500 font-bold">{editFieldErrors.email}</p>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal block">{t('Source (Activity)', 'المصدر (النشاط)')}</label>
                <div className="flex flex-wrap gap-1.5 bg-brand-cream/40 border border-brand-clay rounded-xl p-2.5">
                  {(customerCategoriesMap.get(customerToEdit.id) || []).length === 0 ? (
                    <span className="text-[11px] font-semibold text-brand-charcoal/50 italic">{t('No activity yet', 'لا يوجد نشاط بعد')}</span>
                  ) : (
                    (customerCategoriesMap.get(customerToEdit.id) || []).map(cat => (
                      <span key={cat} className={`px-2 py-0.5 rounded text-[10px] font-bold border ${categoryBadgeClass(cat)}`}>
                        {enumLabel('category', cat, lang)}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal block">{t('Internal Notes', 'ملاحظات داخلية')}</label>
                <textarea
                  rows={3}
                  value={customerToEdit.notes || ''}
                  onChange={(e) => setCustomerToEdit({ ...customerToEdit, notes: e.target.value })}
                  className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold text-brand-charcoal text-xs resize-y"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="px-4 py-2 border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal/70 hover:bg-brand-sand/50 transition-colors cursor-pointer"
                >
                  {t('Cancel', 'إلغاء')}
                </button>
                <button
                  type="submit"
                  className="bg-brand-terracotta text-brand-cream px-5 py-2 rounded-xl text-xs font-bold hover:bg-brand-terracotta-hover transition-colors cursor-pointer"
                >
                  {t('Save Changes', 'حفظ التغييرات')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
