/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useRef } from 'react';
import { useApp, getRiyadhDateString } from '../context/AppContext';
import { 
  Flame, LayoutGrid, List, Search, Filter, AlertCircle, X, Check, 
  MapPin, User, Calendar, RefreshCw, ClipboardList, Clock, Sparkles,
  Camera, Hash, Upload
} from 'lucide-react';
import { PotteryPiece, isStageEnabled, PIECE_END_STATES } from '../types';
import { PieceImage, PiecePhotoError, compressPiecePhoto, uploadPiecePhoto } from '../lib/pieceImages';

/**
 * A suggested code that is not already on the board.
 *
 * Only a suggestion — staff can type their own, and `addPiece` is the actual
 * guard. It exists so the field does not open pre-filled with a code that is
 * already taken, which is how duplicates were being typed in.
 */
const suggestPieceCode = (existing: PotteryPiece[]): string => {
  const taken = new Set(
    existing.flatMap(p => [p.pieceCode, p.id].filter(Boolean).map(v => String(v).trim().toUpperCase()))
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `AC-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `AC-${Date.now().toString(36).toUpperCase()}`;
};
import { PhoneInput } from './PhoneInput';
import { DateInput } from './DateInput';
import { formatDateTime } from '../utils/calendarConfig';
import { hasWebsiteAccount } from '../utils/accountUtils';
import { matchesQuery, useDebouncedValue } from '../utils/search';
import { usePagination, TablePager } from './ui/TablePager';
import { ConsoleModal } from './ui/ConsoleModal';
import { useLanguage } from '../context/LanguageContext';
import type { Lang } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';
import { localizedText } from '../utils/localizedText';

/**
 * Reached by their own buttons underneath the dropdown, so they are left out of
 * it — two controls for one transition is how a piece ends up marked collected
 * by someone who meant to advance it a stage.
 */
const DEDICATED_BUTTON_STATUSES: string[] = ['Ready for Pickup', ...PIECE_END_STATES];

type Translate = (en: string, ar: string) => string;

/**
 * Display text for a stored piece-history reason. The reasons stay English in the data
 * (history, notifications); only the two defaults and the "Resolved: …" format this page
 * writes are translated, and anything staff typed is shown exactly as entered.
 */
const RESOLVED_REASON = /^Resolved: (Replaced|Refunded|Other)(?: — (.+))?$/;
function displayReason(reason: string, t: Translate, lang: Lang) {
  if (reason === 'Piece reported broken') return t(reason, 'تم الإبلاغ عن كسر القطعة');
  if (reason === 'Stage corrected backward') return t(reason, 'تم تصحيح المرحلة بالرجوع');
  const m = RESOLVED_REASON.exec(reason);
  if (m) return t(reason, `تمت التسوية: ${enumLabel('resolutionType', m[1], lang)}${m[2] ? ` — ${m[2]}` : ''}`);
  return reason;
}

/**
 * Display text for the derived customer "origin" badge. The origin is built in a memo and
 * never stored, so it is translated here at render rather than where it is built.
 */
const BOOKING_ORIGIN = /^(.+) booking$/;
function displayOrigin(origin: string, t: Translate, lang: Lang) {
  switch (origin) {
    case 'Website account': return t(origin, 'حساب على الموقع');
    case 'Studio customer': return t(origin, 'عميل الاستوديو');
    case 'Website booking': return t(origin, 'حجز عبر الموقع');
    case 'Live Queue walk-in': return t(origin, 'عميل زيارة مباشرة من الطابور');
  }
  const m = BOOKING_ORIGIN.exec(origin);
  return m ? t(origin, `حجز ${enumLabel('source', m[1], lang)}`) : origin;
}

export const AdminPiecesTrackingSection: React.FC = () => {
  const {
    pieces, updatePieceStatus, addPiece, updatePiece, workshops, bookings,
    // Shared records — no local copies of customers or staff.
    customers, queue, staff, resolveCustomer, pipelineStages
  } = useApp();
  const { lang, t } = useLanguage();

  // Display labels for the date shortcuts; applyDateShortcut still compares the English keys.
  const shortcutLabels: Record<string, string> = {
    'Today': enumLabel('dateScope', 'Today', lang),
    'Last 7 Days': t('Last 7 Days', 'آخر 7 أيام'),
    'Last 30 Days': t('Last 30 Days', 'آخر 30 يومًا'),
    'This Month': t('This Month', 'هذا الشهر'),
    'All Time': t('All Time', 'كل الأوقات')
  };

  // Views and Filters state
  const [viewMode, setViewMode] = useState<'Board' | 'Table'>('Board');
  const [search, setSearch] = useState('');
  /* The board re-derives every column from the full piece list; debouncing the
     filter keeps typing responsive once the studio has a few thousand pieces.
     The input itself is unaffected — only the filtering waits. */
  const debouncedSearch = useDebouncedValue(search);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [awaitingCollectionOnly, setAwaitingCollectionOnly] = useState(false);

  // Date Filters state
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [dateField, setDateField] = useState<'dateCreated' | 'expectedCompletion' | 'readyDate' | 'collectionDate'>('dateCreated');

  // Modal State
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);

  // Editing Piece State (within Detail Modal)
  const [isEditingPiece, setIsEditingPiece] = useState(false);
  const [editExpectedReadyDate, setEditExpectedReadyDate] = useState('');
  const [editStorageLocation, setEditStorageLocation] = useState('');
  const [editPieceCode, setEditPieceCode] = useState('');
  const [editGlazingNotes, setEditGlazingNotes] = useState('');

  // On-screen staff toasts state
  const [toasts, setToasts] = useState<{ id: string; title: string; message: string; highlighted?: boolean }[]>([]);

  // Manual Log Form Modal State
  const [showManualLogModal, setShowManualLogModal] = useState(false);
  const [custSearch, setCustSearch] = useState('');
  const [selectedCust, setSelectedCust] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [manualPhone, setManualPhone] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualName, setManualName] = useState('');
  const [isNewCust, setIsNewCust] = useState(false);

  const [relatedWorkshopId, setRelatedWorkshopId] = useState('');
  const [pieceType, setPieceType] = useState('Mug');
  const [pieceCodeInput, setPieceCodeInput] = useState(() => suggestPieceCode(pieces));
  const [pieceNameInput, setPieceNameInput] = useState('Custom Clay Vessel');
  // customPhotoUrl is the local preview only; customPhotoRef is the uploaded
  // photo's storage reference, which is what the piece record stores.
  const [customPhotoUrl, setCustomPhotoUrl] = useState('');
  const [customPhotoRef, setCustomPhotoRef] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState('');
  // Picking a second photo while the first is still uploading must not let the
  // first one's result land last.
  const photoAttemptRef = useRef(0);
  const [dateCreatedInput, setDateCreatedInput] = useState(() => new Date().toISOString().split('T')[0]);
  const [assignedStaffInput, setAssignedStaffInput] = useState('');
  const [initialStatus, setInitialStatus] = useState<PotteryPiece['status']>('Created');
  const [storageLocationInput, setStorageLocationInput] = useState('Shelf A-1');
  const [expectedCompletionInput, setExpectedCompletionInput] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split('T')[0];
  });
  const [expectedReadyDateInput, setExpectedReadyDateInput] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return d.toISOString().split('T')[0];
  });
  const [manualNotes, setManualNotes] = useState('');

  // Mark-as-Broken Modal State
  const [brokenTargetId, setBrokenTargetId] = useState<string | null>(null);
  const [brokenPerformer, setBrokenPerformer] = useState('');
  const [brokenReason, setBrokenReason] = useState('');
  const [brokenError, setBrokenError] = useState('');

  // Resolve-Broken-Piece Modal State
  const [resolveTargetId, setResolveTargetId] = useState<string | null>(null);
  const [resolveType, setResolveType] = useState<'Replaced' | 'Refunded' | 'Other' | null>(null);
  const [resolvePerformer, setResolvePerformer] = useState('');
  const [resolveNote, setResolveNote] = useState('');
  const [resolveError, setResolveError] = useState('');

  // Backward Move Confirmation Modal State
  const [backwardMoveTarget, setBackwardMoveTarget] = useState<{ pieceId: string; currentStatus: PotteryPiece['status']; targetStatus: PotteryPiece['status'] } | null>(null);
  const [backwardPerformer, setBackwardPerformer] = useState('');
  const [backwardReason, setBackwardReason] = useState('');

  // Helper to trigger animated on-screen toasts for staff
  const triggerToast = (title: string, message: string, highlighted?: boolean) => {
    const id = String(Date.now() + Math.random());
    setToasts(prev => [...prev, { id, title, message, highlighted }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id));
    }, 5000);
  };

  /**
   * National digits for a phone number, so "0501234567", "501234567" and
   * "+966 50 123 4567" all reduce to the same comparable key.
   */
  const phoneKey = (phone?: string) => {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('966')) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);
    return digits;
  };

  /**
   * True when the query looks like a phone number. Without this, a query such as
   * "CUST-2" would digit-match every stored phone containing a "2".
   */
  const isPhoneQuery = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    if (!/^[+\d\s()\-.]+$/.test(trimmed)) return false;
    return phoneKey(trimmed).length >= 3;
  };

  /**
   * Every customer the studio knows about — the shared customers table plus
   * anyone who appears only on a booking or a queue visit. A website account is
   * never required to link a piece to a customer.
   */
  const uniqueCustomers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; phone: string; email: string; origin: string; hasAccount: boolean }>();

    const keyFor = (phone?: string, email?: string, name?: string) =>
      phoneKey(phone) || String(email || '').trim().toLowerCase() || String(name || '').trim().toLowerCase();

    // 1. Stored customer records (website accounts, admin-created, imported).
    (customers || []).forEach(c => {
      const key = keyFor(c.phone, c.email, c.name);
      if (!key) return;
      map.set(key, {
        id: c.id,
        name: c.name || 'Guest',
        phone: c.phone || '',
        email: c.email || '',
        origin: hasWebsiteAccount(c) ? 'Website account' : 'Studio customer',
        hasAccount: hasWebsiteAccount(c)
      });
    });

    // 2. Anyone who only exists on a booking.
    (bookings || []).forEach(b => {
      const key = keyFor(b.customerPhone, b.customerEmail, b.customerName);
      if (!key || map.has(key)) return;
      map.set(key, {
        id: b.id,
        name: b.customerName || 'Guest',
        phone: b.customerPhone || '',
        email: b.customerEmail && b.customerEmail !== '-' ? b.customerEmail : '',
        origin: b.source === 'Website' ? 'Website booking' : `${b.source} booking`,
        hasAccount: false
      });
    });

    // 3. Walk-ins that only exist in the Live Queue.
    (queue || []).forEach(q => {
      const key = keyFor(q.phone, undefined, q.name);
      if (!key || map.has(key)) return;
      map.set(key, {
        id: q.id,
        name: q.name || 'Guest',
        phone: q.phone || '',
        email: '',
        origin: 'Live Queue walk-in',
        hasAccount: false
      });
    });

    return Array.from(map.values());
  }, [customers, bookings, queue]);

  // Customer match filtering for typing autocomplete — name, phone, id or email.
  const filteredCustResults = useMemo(() => {
    const raw = custSearch.trim();
    if (!raw) return [];
    const q = raw.toLowerCase();
    const phoneSearch = isPhoneQuery(raw);
    const digits = phoneKey(raw);

    return uniqueCustomers.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.id || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (phoneSearch && phoneKey(c.phone).includes(digits))
    ).slice(0, 25);
  }, [uniqueCustomers, custSearch]);

  /**
   * Active staff for new assignments, plus the staff already on the piece being
   * edited so historical assignments are never lost from the record.
   */
  const assignableStaff = useMemo(
    () => (staff || []).filter(s => s.status === 'Active'),
    [staff]
  );

  // Kanban Columns definitions
  /**
   * Stages come from Settings → Piece Pipeline Stages. Renaming, reordering or
   * disabling a stage there is reflected here immediately — there is no local
   * status list.
   */
  const orderedStages = useMemo(
    () => [...pipelineStages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [pipelineStages]
  );

  /**
   * Board columns follow the configured order, minus the two end-states.
   *
   * Collected and Broken are outcomes, not queues — a piece leaves the board
   * through them. They stay selectable below (so "mark as collected" and the
   * broken flow are unchanged) and those pieces remain listed in the Table
   * view, which is not column-driven.
   */
  const COLUMNS = useMemo(
    () => orderedStages
      .filter(stage => !PIECE_END_STATES.includes(stage.name as any))
      .map(stage => stage.name as PotteryPiece['status']),
    [orderedStages]
  );

  /** Every configured stage name, board column or end-state. */
  const allStageNames = useMemo(
    () => orderedStages.map(stage => stage.name as PotteryPiece['status']),
    [orderedStages]
  );

  /**
   * Statuses selectable for a NEW update. Disabled stages are excluded, but a
   * piece already sitting in one keeps it — history is never rewritten.
   */
  const selectableStatuses = useMemo(
    () => orderedStages.filter(isStageEnabled).map(stage => stage.name as PotteryPiece['status']),
    [orderedStages]
  );

  const stageColor = (name: string) =>
    orderedStages.find(stage => stage.name === name)?.color;

  const clearCustomPhoto = () => {
    photoAttemptRef.current++;
    if (customPhotoUrl.startsWith('blob:')) URL.revokeObjectURL(customPhotoUrl);
    setCustomPhotoUrl('');
    setCustomPhotoRef('');
    setPhotoUploading(false);
    setPhotoError('');
  };

  /**
   * Compresses the photo and uploads it to Storage straight away, so the piece
   * record only ever carries a short reference. This used to read the file
   * into a base64 data URL and store that in pieces.image — thirty of those
   * made the pieces table too heavy to read at all.
   */
  const handleCameraCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;

    clearCustomPhoto();
    const attempt = photoAttemptRef.current;
    setPhotoUploading(true);
    let previewUrl = '';

    try {
      const photo = await compressPiecePhoto(file);
      if (attempt !== photoAttemptRef.current) return;
      previewUrl = URL.createObjectURL(photo);
      setCustomPhotoUrl(previewUrl);

      const reference = await uploadPiecePhoto(photo);
      if (attempt !== photoAttemptRef.current) return;
      setCustomPhotoRef(reference);
    } catch (err) {
      if (attempt !== photoAttemptRef.current) return;
      const code = err instanceof PiecePhotoError ? err.code : 'upload-failed';
      setPhotoError(
        code === 'undecodable'
          ? t('This photo format cannot be read here (HEIC photos often cannot be read on a computer). Use the phone camera, or upload a JPEG or PNG.', 'لا يمكن قراءة صيغة هذه الصورة هنا (غالبًا لا يمكن قراءة صور HEIC على الكمبيوتر). استخدم كاميرا الهاتف أو ارفع صورة JPEG أو PNG.')
          : code === 'too-large'
            ? t('This photo is too large even after compression (5MB limit).', 'هذه الصورة كبيرة جدًا حتى بعد الضغط (الحد 5 ميجابايت).')
            : t('The photo could not be uploaded. Check your connection and try again.', 'تعذّر رفع الصورة. تحقق من الاتصال وحاول مرة أخرى.')
      );
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setCustomPhotoUrl('');
      setCustomPhotoRef('');
    } finally {
      if (attempt === photoAttemptRef.current) setPhotoUploading(false);
    }
  };

  // Helper wrapper to handle piece status updates & trigger toast notices
  const handleUpdatePieceStatus = async (pieceId: string, status: PotteryPiece['status'], user: string, reason?: string) => {
    const piece = pieces.find(p => p.id === pieceId);
    if (!piece) return;

    await updatePieceStatus(pieceId, status, user, reason);

    const isReady = status === 'Ready for Pickup';
    triggerToast(
      isReady ? t('Ready for Pickup!', 'جاهزة للاستلام!') : t('Status Shipped Successfully', 'تم تحديث الحالة بنجاح'),
      t(
        `Piece ${piece.pieceCode || pieceId} (${piece.customerName}) has been updated to "${status}" by ${user}.${reason ? ` Reason: ${reason}` : ''}`,
        `تم تحديث القطعة ${piece.pieceCode || pieceId} (${piece.customerName}) إلى "${enumLabel('pieceStatus', status, lang)}" بواسطة ${user === 'Staff' ? 'الموظف' : user}.${reason ? ` السبب: ${displayReason(reason, t, lang)}` : ''}`
      ),
      isReady
    );
  };

  // Route any status changes (Kanban drag-drop or details dropdown) to validate backward moves
  const onAttemptStatusChange = (pieceId: string, targetStatus: PotteryPiece['status']) => {
    const piece = pieces.find(p => p.id === pieceId);
    if (!piece) return;

    const oldStatus = piece.status;
    if (oldStatus === targetStatus) return;

    // Broken is not a lifecycle step — it needs a staff member and a damage note.
    if (targetStatus === 'Broken') {
      setBrokenTargetId(pieceId);
      setBrokenPerformer('');
      setBrokenReason('');
      return;
    }

    // Progression order comes from the configured pipeline, so a reordered or
    // renamed stage is still classified correctly. 'Broken' is handled above and
    // is deliberately excluded from the linear progression.
    const stages = orderedStages
      .map(stage => stage.name)
      .filter(name => name !== 'Broken');
    const oldIdx = stages.indexOf(oldStatus);
    const newIdx = stages.indexOf(targetStatus);

    if (newIdx < oldIdx) {
      setBackwardMoveTarget({
        pieceId,
        currentStatus: oldStatus,
        targetStatus
      });
      setBackwardPerformer('');
      setBackwardReason('');
    } else {
      handleUpdatePieceStatus(pieceId, targetStatus, 'Staff');
    }
  };

  const getColumnColorClass = (col: PotteryPiece['status']) => {
    switch (col) {
      case 'Created': return 'text-blue-600 border-blue-500 bg-blue-50';
      case 'First Burn and Colored': return 'text-orange-600 border-orange-500 bg-orange-50';
      case 'Ready for Pickup': return 'text-emerald-700 border-emerald-500 bg-emerald-50';
      case 'Collected': return 'text-gray-600 border-gray-400 bg-gray-50';
      case 'Broken': return 'text-red-700 border-red-500 bg-red-50';
      default: return 'text-brand-charcoal border-brand-clay bg-brand-sand';
    }
  };

  const getPieceDateValue = (p: PotteryPiece, field: typeof dateField): string => {
    switch (field) {
      case 'dateCreated': return p.dateCreated;
      case 'expectedCompletion': return p.expectedCompletion || '';
      case 'readyDate':
        return p.history?.find(h => h.status === 'Ready for Pickup')?.timestamp.split('T')[0] || '';
      case 'collectionDate':
        return p.history?.find(h => h.status === 'Collected')?.timestamp.split('T')[0] || '';
      default: return p.dateCreated;
    }
  };

  const applyDateShortcut = (shortcut: 'Today' | 'Last 7 Days' | 'Last 30 Days' | 'This Month' | 'All Time') => {
    const today = new Date();
    const rToday = getRiyadhDateString(today);
    if (shortcut === 'Today') {
      setStartDate(rToday);
      setEndDate(rToday);
    } else if (shortcut === 'Last 7 Days') {
      const past = new Date();
      past.setDate(today.getDate() - 6);
      setStartDate(getRiyadhDateString(past));
      setEndDate(rToday);
    } else if (shortcut === 'Last 30 Days') {
      const past = new Date();
      past.setDate(today.getDate() - 29);
      setStartDate(getRiyadhDateString(past));
      setEndDate(rToday);
    } else if (shortcut === 'This Month') {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDate(getRiyadhDateString(startOfMonth));
      setEndDate(rToday);
    } else if (shortcut === 'All Time') {
      setStartDate('');
      setEndDate('');
    }
  };

  // Filter Pieces
  const processedPieces = useMemo(() => {
    let result = [...pieces];

    // Search the shared piece records: trimmed, case-insensitive, and matching
    // phone numbers regardless of formatting. Runs alongside the other filters.
    const rawSearch = debouncedSearch.trim();
    if (rawSearch) {
      const q = rawSearch.toLowerCase();
      const phoneSearch = isPhoneQuery(rawSearch);
      const digits = phoneKey(rawSearch);

      result = result.filter(p => {
        const fields = [
          p.id,
          p.pieceCode,
          p.name,
          p.customerName,
          p.customerId,
          p.assignedStaff,
          p.workshopName,
          p.bookingId,
          p.status,
          p.storageLocation
        ];

        if (fields.some(f => f && String(f).toLowerCase().includes(q))) return true;

        // Phone match on national digits, so "0501234567" finds "+966 50 123 4567".
        if (phoneSearch && phoneKey(p.customerPhone).includes(digits)) return true;

        return false;
      });
    }

    if (overdueOnly) {
      result = result.filter(p => p.status !== 'Collected' && p.daysElapsed >= 10);
    }

    if (awaitingCollectionOnly) {
      result = result.filter(p => p.status === 'Ready for Pickup');
    }

    if (startDate || endDate) {
      result = result.filter(p => {
        const val = getPieceDateValue(p, dateField);
        if (!val) return false;
        if (startDate && val < startDate) return false;
        if (endDate && val > endDate) return false;
        return true;
      });
    }

    return result;
  }, [pieces, debouncedSearch, overdueOnly, awaitingCollectionOnly, startDate, endDate, dateField]);

  /* Ten rows a page in the table. The board is unaffected — its columns are
     already bounded by their own scroll. */
  const tablePager = usePagination(processedPieces, 10);

  const selectedPiece = useMemo(() => {
    return pieces.find(p => p.id === selectedPieceId) || null;
  }, [pieces, selectedPieceId]);

  // Shown for a piece with no photo, while its signed URL is pending, and when
  // the photo cannot be loaded — never a broken image.
  const photoPlaceholder = (
    <div className="flex h-full w-full items-center justify-center text-brand-charcoal/30">
      <Camera className="h-6 w-6" />
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 text-left bg-brand-cream min-h-full">
      
      {/* Header with Title and Mode Switcher */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-brand-clay/60 pb-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-brand-charcoal flex items-center gap-2">
            <Flame className="h-6 w-6 text-brand-terracotta shrink-0" />
            <span>{t('Ceramics Kiln & Shelf Tracker', 'متتبع فرن السيراميك والرفوف')}</span>
          </h1>
          <p className="text-xs text-brand-charcoal/60 mt-1">
            {t('Supervise drying stages, kiln firing schedules, glaze dip stations, and pickup shelves.', 'الإشراف على مراحل التجفيف وجداول حرق الفرن ومحطات غمس التزجيج ورفوف الاستلام.')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
          {/* Log Piece Manually Button */}
          <button
            onClick={() => {
              setPieceCodeInput(suggestPieceCode(pieces));
              setShowManualLogModal(true);
            }}
            className="cursor-pointer px-4 py-2 bg-brand-terracotta hover:bg-brand-terracotta/95 text-brand-cream rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all duration-200"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{t('+ Log Piece Manually', '+ تسجيل قطعة يدويًا')}</span>
          </button>

          {/* Board vs List Table Switcher */}
          <div className="bg-white border border-brand-clay/70 p-1.5 rounded-xl flex items-center gap-2">
            <button
              onClick={() => setViewMode('Board')}
              className={`cursor-pointer px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
                viewMode === 'Board' ? 'bg-brand-terracotta text-brand-cream shadow-sm' : 'text-brand-charcoal/60 hover:text-brand-terracotta'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span>{t('Kanban Board', 'لوحة المراحل')}</span>
            </button>
            <button
              onClick={() => setViewMode('Table')}
              className={`cursor-pointer px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors ${
                viewMode === 'Table' ? 'bg-brand-terracotta text-brand-cream shadow-sm' : 'text-brand-charcoal/60 hover:text-brand-terracotta'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              <span>{t('Table List', 'عرض الجدول')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white border border-brand-clay/70 rounded-2xl p-4 shadow-2xs flex flex-col xl:flex-row flex-wrap gap-4 justify-between items-stretch xl:items-center">

        {/* Search and Toggles */}
        <div className="flex flex-col md:flex-row flex-wrap gap-4 items-stretch md:items-center flex-1">
          {/* Search by piece, customer, phone, code */}
          <div className="relative max-w-sm min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/40" />
            <input
              type="text"
              placeholder={t('Search code, customer, phone, ID, staff, workshop, status...', 'ابحث بالرمز أو العميل أو الهاتف أو الرقم أو الموظف أو الورشة أو الحالة...')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-brand-cream/40 border border-brand-clay/60 rounded-xl py-2 pl-9 pr-8 text-xs font-semibold text-brand-charcoal"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                title={t('Clear search', 'مسح البحث')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-brand-charcoal/40 hover:text-brand-terracotta cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setOverdueOnly(!overdueOnly)}
              className={`cursor-pointer px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-colors flex items-center gap-1.5 ${
                overdueOnly 
                  ? 'bg-red-50 text-red-700 border-red-300' 
                  : 'bg-brand-cream/35 border-brand-clay text-brand-charcoal/70 hover:bg-brand-sand'
              }`}
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{t('Overdue Only (>=10 days)', 'المتأخرة فقط (10 أيام أو أكثر)')}</span>
            </button>

            <button
              onClick={() => setAwaitingCollectionOnly(!awaitingCollectionOnly)}
              className={`cursor-pointer px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-colors flex items-center gap-1.5 ${
                awaitingCollectionOnly 
                  ? 'bg-green-50 text-green-700 border-green-300' 
                  : 'bg-brand-cream/35 border-brand-clay text-brand-charcoal/70 hover:bg-brand-sand'
              }`}
            >
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span>{t('Ready for Pickup Only', 'الجاهزة للاستلام فقط')}</span>
            </button>
          </div>
        </div>

        {/* Date Filter Dropdown and Date Inputs */}
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 bg-brand-cream/20 p-2.5 rounded-xl border border-brand-clay/40 shrink-0">
          <div className="flex items-center gap-1 bg-white px-2 py-1 border border-brand-clay/40 rounded-lg">
            <Calendar className="h-3.5 w-3.5 text-brand-charcoal/50 shrink-0" />
            <select
              value={dateField}
              onChange={e => setDateField(e.target.value as any)}
              className="bg-transparent border-none text-[11px] font-bold text-brand-charcoal focus:ring-0 cursor-pointer pr-8 py-0.5"
            >
              <option value="dateCreated">{t('Date Created', 'تاريخ الإنشاء')}</option>
              <option value="expectedCompletion">{t('Expected Completion Date', 'تاريخ الإنجاز المتوقع')}</option>
              <option value="readyDate">{t('Ready Date', 'تاريخ الجاهزية')}</option>
              <option value="collectionDate">{t('Collection Date', 'تاريخ الاستلام')}</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 justify-center">
            <DateInput
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="bg-white border border-brand-clay/60 rounded-lg px-2 py-1 text-[11px] font-semibold text-brand-charcoal focus:outline-none focus:border-brand-terracotta"
            />
            <span className="text-[11px] font-bold text-brand-charcoal/50">{t('to', 'إلى')}</span>
            <DateInput
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="bg-white border border-brand-clay/60 rounded-lg px-2 py-1 text-[11px] font-semibold text-brand-charcoal focus:outline-none focus:border-brand-terracotta"
            />
          </div>

          {/* Quick Shortcuts */}
          <div className="flex items-center justify-center gap-1.5 border-t sm:border-t-0 sm:border-l border-brand-clay/30 pt-2 sm:pt-0 sm:pl-3">
            {(['Today', 'Last 7 Days', 'Last 30 Days', 'This Month', 'All Time'] as const).map(shortcut => {
              const rToday = getRiyadhDateString();
              const isToday = shortcut === 'Today' && startDate === rToday && endDate === rToday;
              const isAllTime = shortcut === 'All Time' && !startDate && !endDate;

              return (
                <button
                  key={shortcut}
                  onClick={() => applyDateShortcut(shortcut)}
                  className={`text-[10px] font-bold px-2 py-1 rounded-md transition-colors cursor-pointer ${
                    isToday || isAllTime
                      ? 'bg-brand-terracotta text-brand-cream'
                      : 'bg-brand-sand/50 hover:bg-brand-sand text-brand-charcoal/70'
                  }`}
                >
                  {shortcutLabels[shortcut]}
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* No results for the current search / filter combination */}
      {processedPieces.length === 0 && (
        <div className="bg-white border border-dashed border-brand-clay rounded-2xl p-10 text-center space-y-2">
          <Search className="h-6 w-6 text-brand-charcoal/30 mx-auto" />
          <p className="text-sm font-bold text-brand-charcoal">{t('No pottery pieces match your search', 'لا توجد قطع فخار تطابق بحثك')}</p>
          <p className="text-xs text-brand-charcoal/60">
            {search.trim()
              ? (lang === 'ar'
                ? <>لم يُعثر على نتائج لـ “<span className="font-bold">{search.trim()}</span>”. جرّب رمز القطعة أو اسم العميل أو الهاتف أو رقم العميل أو الموظف المسؤول أو الورشة أو الحالة.</>
                : <>Nothing found for “<span className="font-bold">{search.trim()}</span>”. Try a piece code, customer name, phone, customer ID, assigned staff, workshop or status.</>)
              : t('No pieces match the current filters.', 'لا توجد قطع تطابق عوامل التصفية الحالية.')}
          </p>
          {(search.trim() || overdueOnly || awaitingCollectionOnly || startDate || endDate) && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setOverdueOnly(false);
                setAwaitingCollectionOnly(false);
                setStartDate('');
                setEndDate('');
              }}
              className="mt-1 px-4 py-2 bg-brand-sand hover:bg-brand-clay/40 text-brand-charcoal rounded-xl text-xs font-bold cursor-pointer"
            >
              {t('Clear search & filters', 'مسح البحث وعوامل التصفية')}
            </button>
          )}
        </div>
      )}

      {/* VIEW PANEL: KANBAN BOARD */}
      {viewMode === 'Board' ? (
        /* One horizontal row of fixed-width columns that scrolls inside itself.
           flex-nowrap + shrink-0 keep them side by side at every width; min-w-0
           on the track is what allows it to scroll rather than push the page. */
        <div className="flex flex-row flex-nowrap gap-4 overflow-x-auto overscroll-x-contain pb-4 w-full min-w-0 max-w-full select-none no-scrollbar items-stretch">
          {COLUMNS.map((col) => {
            const columnPieces = processedPieces.filter(p => p.status === col);
            
            return (
              <div 
                key={col} 
                className="flex flex-col shrink-0 grow-0 basis-[260px] w-[260px] bg-brand-cream/35 border border-brand-clay rounded-2xl p-3 h-[70vh] min-h-[420px] max-h-[620px]"
              >
                
                {/* Column header title. A stage renamed or added in Settings still
                    shows its configured colour via the left accent. */}
                <div
                  className={`p-2.5 h-11 rounded-xl border flex items-center justify-between font-bold text-xs shrink-0 ${getColumnColorClass(col)}`}
                  style={stageColor(col) ? { borderLeft: `4px solid ${stageColor(col)}` } : undefined}
                >
                  <span className="truncate pr-1 uppercase tracking-wider text-[10px] self-center">
                    {enumLabel('pieceStatus', col, lang)}
                    {!selectableStatuses.includes(col) && (
                      <span className="ml-1 normal-case text-brand-charcoal/40">{t('(disabled)', '(معطّلة)')}</span>
                    )}
                  </span>
                  <span className="bg-brand-cream rounded-full h-5 w-5 flex items-center justify-center text-[10px] text-brand-charcoal/80 border border-brand-clay/40 shrink-0 self-center">
                    {columnPieces.length}
                  </span>
                </div>

                {/* Column Cards */}
                <div className="flex-1 overflow-y-auto pr-1 py-1 mt-3 space-y-3 flex flex-col no-scrollbar">
                  {columnPieces.map((p) => {
                    const isOverdue = p.daysElapsed >= 10 && col !== 'Collected';
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          setSelectedPieceId(p.id);
                          setEditExpectedReadyDate(p.expectedReadyDate || p.expectedCompletion || '');
                          setEditStorageLocation(p.storageLocation || '');
                          setEditPieceCode(p.pieceCode || p.id);
                          setEditGlazingNotes(p.additionalDescriptionGlazingNotes || p.notes || '');
                          setIsEditingPiece(false);
                        }}
                        className={`cursor-pointer bg-white p-3 rounded-xl border hover:shadow-2xs transition-all text-left space-y-3 w-full shrink-0 ${
                          isOverdue 
                            ? 'border-2 border-brand-terracotta ring-2 ring-brand-terracotta/5' 
                            : 'border-brand-clay/60 hover:border-brand-terracotta/45'
                        }`}
                      >
                        {/* Image */}
                        <div className="aspect-video w-full rounded-lg overflow-hidden bg-brand-sand shrink-0">
                          <PieceImage value={p.image} alt={p.name} className="h-full w-full object-cover" fallback={photoPlaceholder} />
                        </div>

                        {/* Title and stats */}
                        <div className="space-y-1 min-w-0">
                          <div className="flex justify-between items-center">
                            <span className="font-mono text-[9px] font-bold text-brand-terracotta shrink-0 flex items-center gap-0.5">
                              <Hash className="h-2.5 w-2.5" />
                              {p.pieceCode || p.id}
                            </span>
                            <span className="text-[10px] font-bold text-brand-charcoal/50 shrink-0">{p.dateCreated}</span>
                          </div>
                          <h4 className="text-xs font-bold text-brand-charcoal truncate" title={p.name}>{p.name}</h4>
                          <p className="text-[10px] text-brand-sage font-semibold truncate" title={p.workshopName}>{p.workshopName}</p>
                          {(p.expectedReadyDate || p.expectedCompletion) && (
                            <p className="text-[9px] text-brand-terracotta font-bold flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              <span>{t('Ready:', 'جاهزة:')} {p.expectedReadyDate || p.expectedCompletion}</span>
                            </p>
                          )}
                        </div>

                        {/* Customer and days counter */}
                        <div className="pt-2 border-t border-brand-clay/30 flex items-center justify-between text-[10px] min-w-0">
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-brand-charcoal truncate pr-2" title={p.customerName}>{p.customerName}</p>
                          </div>
                          
                          <span className={`font-bold uppercase tracking-wider text-[9px] shrink-0 ${
                            isOverdue ? 'text-red-500 animate-pulse font-extrabold' : 'text-brand-charcoal/40'
                          }`}>
                            {p.daysElapsed} {t('days', 'يوم')}
                          </span>
                        </div>

                      </div>
                    );
                  })}

                  {columnPieces.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-brand-clay/40 rounded-xl bg-brand-cream/10 p-4">
                      <p className="text-[10px] text-brand-charcoal/30 text-center font-bold italic">{t('Empty stage', 'مرحلة فارغة')}</p>
                    </div>
                  )}
                </div>

              </div>
            );
          })}
        </div>
      ) : (
        /* VIEW PANEL: DATA TABLE LIST */
        <div className="bg-white border border-brand-clay rounded-2xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-brand-cream/40 border-b border-brand-clay/60 text-brand-charcoal/50 uppercase tracking-wider font-semibold">
                  <th className="p-4">{t('Piece Code', 'رمز القطعة')}</th>
                  <th className="p-4">{t('Piece Name', 'اسم القطعة')}</th>
                  <th className="p-4">{t('Owner Name', 'اسم المالك')}</th>
                  <th className="p-4">{t('Workshop Origin', 'مصدر الورشة')}</th>
                  <th className="p-4">{t('Creation Date', 'تاريخ الإنشاء')}</th>
                  <th className="p-4">{t('Expected Ready Date', 'تاريخ الجاهزية المتوقع')}</th>
                  <th className="p-4">{t('Storage Shelf', 'رف التخزين')}</th>
                  <th className="p-4 text-center">{t('Lifecycle Status', 'مرحلة القطعة')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30">
                {tablePager.pageItems.map((p) => {
                  const isOverdue = p.daysElapsed >= 10 && p.status !== 'Collected';
                  return (
                    <tr 
                      key={p.id}
                      onClick={() => {
                        setSelectedPieceId(p.id);
                        setEditExpectedReadyDate(p.expectedReadyDate || p.expectedCompletion || '');
                        setEditStorageLocation(p.storageLocation || '');
                        setEditPieceCode(p.pieceCode || p.id);
                        setEditGlazingNotes(p.additionalDescriptionGlazingNotes || p.notes || '');
                        setIsEditingPiece(false);
                      }}
                      className="cursor-pointer hover:bg-brand-sand/15 font-semibold"
                    >
                      <td className="p-4 font-mono font-bold text-brand-terracotta">{p.pieceCode || p.id}</td>
                      <td className="p-4 text-brand-charcoal font-bold">{p.name}</td>
                      <td className="p-4">{p.customerName}</td>
                      <td className="p-4 text-brand-sage">{p.workshopName}</td>
                      <td className="p-4">{p.dateCreated}</td>
                      <td className="p-4 font-bold text-brand-terracotta">{p.expectedReadyDate || p.expectedCompletion || t('N/A', 'غير متاح')}</td>
                      <td className="p-4 font-bold font-mono">{p.storageLocation || t('Unassigned', 'غير محدد')}</td>
                      <td className="p-4 text-center">
                        <span className={`inline-flex items-center rounded-lg px-2.5 py-0.5 text-[10px] font-bold border ${getColumnColorClass(p.status)}`}>
                          {enumLabel('pieceStatus', p.status, lang)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-4 pb-4">
            <TablePager
              page={tablePager.page}
              totalPages={tablePager.totalPages}
              from={tablePager.from}
              to={tablePager.to}
              total={tablePager.total}
              onPage={tablePager.setPage}
              noun={t('pieces', 'قطع')}
            />
          </div>
        </div>
      )}

      {/* PIECE DETAIL DIALOG MODAL */}
      {selectedPiece && (
        <ConsoleModal
          maxWidth="max-w-3xl"
          onClose={() => setSelectedPieceId(null)}
          title={
            <span className="flex flex-col">
              <span className="text-[10px] font-bold text-brand-terracotta font-mono uppercase tracking-widest">{t('PIECE TRACKER DETAIL', 'تفاصيل تتبع القطعة')}</span>
              <span className="font-display text-xl font-bold text-brand-charcoal">{t('Code:', 'الرمز:')} {selectedPiece.pieceCode || selectedPiece.id}</span>
            </span>
          }
          footer={
            <div className="w-full grid grid-cols-2 gap-3">
              {selectedPiece.status === 'Broken' ? (
                // Broken is an outcome, not a lifecycle step in progress — the
                // only forward action here is resolving it, so the ordinary
                // making-stage buttons are replaced rather than shown alongside
                // a modal that could be skipped by clicking past it.
                <button
                  onClick={() => {
                    setResolveTargetId(selectedPiece.id);
                    setResolveType(null);
                    setResolvePerformer('');
                    setResolveNote('');
                    setResolveError('');
                  }}
                  className="col-span-2 cursor-pointer bg-brand-charcoal hover:bg-brand-charcoal/90 text-brand-cream font-bold text-xs py-3 rounded-xl transition-all flex items-center justify-center gap-1.5"
                >
                  <ClipboardList className="h-4 w-4" />
                  <span>{t('Resolve Broken Piece', 'معالجة القطعة المكسورة')}</span>
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      onAttemptStatusChange(selectedPiece.id, 'Ready for Pickup');
                      setSelectedPieceId(null);
                    }}
                    className="cursor-pointer bg-green-600 hover:bg-green-700 text-brand-cream font-bold text-xs py-3 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <Check className="h-4 w-4 stroke-[3]" />
                    <span>{t('Mark Ready for Pickup', 'تحديد كجاهزة للاستلام')}</span>
                  </button>

                  <button
                    onClick={() => {
                      onAttemptStatusChange(selectedPiece.id, 'Collected');
                      setSelectedPieceId(null);
                    }}
                    className="cursor-pointer bg-brand-charcoal hover:bg-brand-charcoal/90 text-brand-cream font-bold text-xs py-3 rounded-xl transition-all flex items-center justify-center gap-1.5"
                  >
                    <ClipboardList className="h-4 w-4" />
                    <span>{t('Mark Collected / Picked Up', 'تحديد كمستلمة / تم الاستلام')}</span>
                  </button>

                  <button
                    onClick={() => onAttemptStatusChange(selectedPiece.id, 'Broken')}
                    className="col-span-2 cursor-pointer bg-red-50 hover:bg-red-100 border border-red-300 text-red-700 font-bold text-xs py-3 rounded-xl transition-all flex items-center justify-center gap-1.5"
                  >
                    <AlertCircle className="h-4 w-4" />
                    <span>{t('Mark as Broken', 'تحديد كمكسورة')}</span>
                  </button>
                </>
              )}
            </div>
          }
        >

            {/* Modal Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              
              {/* Left Column: Big Photo Preview */}
              <div className="space-y-4">
                <div className="aspect-square w-full rounded-2xl overflow-hidden border border-brand-clay bg-brand-sand">
                  <PieceImage value={selectedPiece.image} alt={selectedPiece.name} className="h-full w-full object-cover" fallback={photoPlaceholder} />
                </div>
                
                <div className="space-y-1.5">
                  <span className="text-[9px] font-bold text-brand-sage uppercase tracking-wider block">{t('Assigned Pottery Staff', 'موظف الفخار المسؤول')}</span>
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 shrink-0 rounded-full bg-brand-terracotta text-brand-cream flex items-center justify-center font-bold text-[10px]">
                      {selectedPiece.assignedStaff?.charAt(0) || '?'}
                    </div>
                    {/* Reassigning is done here rather than in a separate step. */}
                    <select
                      value={selectedPiece.assignedStaff || ''}
                      onChange={async e => {
                        await updatePiece(selectedPiece.id, { assignedStaff: e.target.value });
                        triggerToast(
                          t('Piece Reassigned', 'تمت إعادة التعيين'),
                          t(`Now assigned to ${e.target.value || 'nobody'}.`, `تم تعيين القطعة إلى ${e.target.value || 'لا أحد'}.`),
                          false
                        );
                      }}
                      className="min-w-0 flex-1 bg-white border border-brand-clay/80 rounded-xl p-1.5 text-xs font-bold text-brand-charcoal cursor-pointer"
                    >
                      <option value="">{t('Unassigned', 'غير معيّن')}</option>
                      {selectedPiece.assignedStaff &&
                        !assignableStaff.some(st => st.name === selectedPiece.assignedStaff) && (
                        <option value={selectedPiece.assignedStaff}>{selectedPiece.assignedStaff}</option>
                      )}
                      {assignableStaff.map(st => (
                        <option key={st.id} value={st.name}>{st.name}</option>
                      ))}
                    </select>
                  </div>
                  {/* Historical assignment kept even if that staff member is no longer active */}
                  {selectedPiece.assignedStaff && !assignableStaff.some(s => s.name === selectedPiece.assignedStaff) && (
                    <p className="text-[9px] font-semibold text-brand-charcoal/50 italic">
                      {t('No longer an active staff member — kept for history.', 'لم يعد موظفًا نشطًا — محفوظ للسجل.')}
                    </p>
                  )}
                </div>

                {/* Broken damage note — internal only, never sent to the customer */}
                {selectedPiece.status === 'Broken' && (
                  <div className="space-y-1 bg-red-50 border border-red-200 rounded-xl p-2.5">
                    <span className="text-[9px] font-bold text-red-700 uppercase tracking-wider block flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      <span>{t('Broken — Internal Note', 'مكسورة — ملاحظة داخلية')}</span>
                    </span>
                    <p className="text-[11px] font-semibold text-red-900">
                      {selectedPiece.damageNote ? displayReason(selectedPiece.damageNote, t, lang) : t('No damage note recorded.', 'لم تُسجَّل ملاحظة عن الضرر.')}
                    </p>
                    <p className="text-[9px] font-semibold text-red-700/70">
                      {t('The customer was asked to contact the café. This note is not shared with them.', 'طُلب من العميل التواصل مع المقهى. هذه الملاحظة غير مشتركة مع العميل.')}
                    </p>
                  </div>
                )}
              </div>

              {/* Right Column: Metadata Fields */}
              <div className="space-y-4 text-xs text-brand-charcoal">
                
                <div className="space-y-1.5">
                  <span className="font-bold text-brand-charcoal/50 block">{t('Ceramic Piece Name', 'اسم قطعة السيراميك')}</span>
                  <p className="text-sm font-bold text-brand-charcoal">{selectedPiece.name}</p>
                </div>

                <div className="space-y-1.5">
                  <span className="font-bold text-brand-charcoal/50 block">{t('Artist Owner Info', 'بيانات الفنان المالك')}</span>
                  <div className="p-2.5 bg-brand-sand/40 border border-brand-clay rounded-xl">
                    <p className="font-bold">{selectedPiece.customerName}</p>
                    <p className="text-[10px] text-brand-charcoal/50 font-bold">{selectedPiece.customerPhone}</p>
                  </div>
                </div>

                {/* Editable Expected Ready Date and Storage Shelf */}
                <div className="space-y-3 bg-brand-sand/30 p-3 rounded-2xl border border-brand-clay/60">
                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block flex items-center justify-between">
                      <span>{t('Expected-Ready Date', 'تاريخ الجاهزية المتوقع')}</span>
                      <span className="text-[9px] text-brand-terracotta">{t('Syncs to My Pieces', 'يتزامن مع «أعمالي»')}</span>
                    </label>
                    <DateInput
                      value={editExpectedReadyDate}
                      onChange={e => setEditExpectedReadyDate(e.target.value)}
                      className="w-full bg-white border border-brand-clay/80 rounded-xl p-2 font-bold text-brand-charcoal"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block">{t('Storage Shelf', 'رف التخزين')}</label>
                    <input
                      type="text"
                      value={editStorageLocation}
                      onChange={e => setEditStorageLocation(e.target.value)}
                      placeholder="Shelf C-4"
                      className="w-full bg-white border border-brand-clay/80 rounded-xl p-2 font-mono font-bold text-brand-charcoal"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block">{t('Additional Description / Glazing Notes', 'وصف إضافي / ملاحظات التزجيج')}</label>
                    <textarea
                      rows={3}
                      value={editGlazingNotes}
                      onChange={e => setEditGlazingNotes(e.target.value)}
                      placeholder={t('Add optional piece details, glazing colour requests, finishing instructions, or other notes…', 'أضف تفاصيل اختيارية عن القطعة أو طلبات ألوان التزجيج أو تعليمات التشطيب أو ملاحظات أخرى…')}
                      className="w-full bg-white border border-brand-clay/80 rounded-xl p-2 font-semibold text-brand-charcoal text-xs resize-y"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      await updatePiece(selectedPiece.id, {
                        expectedReadyDate: editExpectedReadyDate,
                        expectedCompletion: editExpectedReadyDate,
                        storageLocation: editStorageLocation,
                        additionalDescriptionGlazingNotes: editGlazingNotes,
                        notes: editGlazingNotes
                      });
                      triggerToast(t('Updated Piece Details', 'تم تحديث بيانات القطعة'), t('Piece details and glazing notes updated successfully.', 'تم تحديث بيانات القطعة وملاحظات التزجيج بنجاح.'), false);
                    }}
                    className="w-full bg-brand-terracotta text-brand-cream font-bold py-2 rounded-xl text-xs hover:bg-brand-terracotta-hover transition-colors cursor-pointer"
                  >
                    {t('Save Changes', 'حفظ التغييرات')}
                  </button>
                </div>

                {/* Status selector directly within the detail dialog */}
                <div className="space-y-1.5 pt-1">
                  <label className="font-bold text-brand-charcoal/50 block">{t('Advance Lifecycle State', 'تحديث مرحلة القطعة')}</label>
                  <select
                    value={selectedPiece.status}
                    onChange={e => onAttemptStatusChange(selectedPiece.id, e.target.value as any)}
                    className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2 font-bold text-brand-charcoal cursor-pointer"
                  >
                    {/* Making stages only. Ready for Pickup, Collected and
                        Broken have dedicated buttons below, and offering them
                        here as well gave two routes to the same transition.
                        The piece's own stage stays listed even when it is an
                        end-state, so its status is never lost. */}
                    {allStageNames
                      .filter(col => !DEDICATED_BUTTON_STATUSES.includes(col) || col === selectedPiece.status)
                      .filter(col => selectableStatuses.includes(col) || col === selectedPiece.status)
                      .map(col => (
                        <option key={col} value={col}>
                          {enumLabel('pieceStatus', col, lang)}{!selectableStatuses.includes(col) ? t(' (disabled)', ' (معطّلة)') : ''}
                        </option>
                      ))}
                  </select>
                </div>

              </div>

            </div>

        </ConsoleModal>
      )}

      {/* Backward Move Confirmation Modal */}
      {/* ================= MARK AS BROKEN MODAL ================= */}
      {brokenTargetId && (() => {
        const target = pieces.find(p => p.id === brokenTargetId);
        if (!target) return null;

        return (
          <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-60 flex items-center justify-center p-4">
            <div className="bg-white border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-md w-full space-y-4 text-left animate-in zoom-in-95 duration-150">

              <div className="flex items-start gap-3 border-b border-brand-clay/60 pb-3">
                <div className="h-10 w-10 rounded-2xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                  <AlertCircle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold text-brand-charcoal">{t('Mark Piece as Broken', 'تحديد القطعة كمكسورة')}</h3>
                  <p className="text-[11px] font-semibold text-brand-charcoal/60">
                    {target.pieceCode || target.id} · {target.customerName}
                  </p>
                </div>
              </div>

              <p className="text-[11px] font-semibold text-brand-charcoal/70 bg-brand-cream/60 border border-brand-clay/50 rounded-xl p-2.5">
                {t('The customer is notified that there is an important update and asked to contact the café. Your internal note stays in the console and is never sent to them. The piece is not marked collected or cancelled.', 'يُبلَّغ العميل بوجود تحديث مهم ويُطلب التواصل مع المقهى. تبقى ملاحظتك الداخلية في لوحة التحكم ولا تُرسل إلى العميل أبدًا. لا تُحدَّد القطعة كمستلمة أو ملغاة.')}
              </p>

              <div className="space-y-3.5 text-xs">
                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/60 block">{t('Staff member recording this *', 'الموظف الذي يسجّل هذا *')}</label>
                  <select
                    value={brokenPerformer}
                    onChange={e => { setBrokenPerformer(e.target.value); setBrokenError(''); }}
                    className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                  >
                    <option value="">{t('Select staff member...', 'اختر الموظف...')}</option>
                    {assignableStaff.map(s => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/60 block">{t('Internal reason / damage note', 'السبب الداخلي / ملاحظة الضرر')}</label>
                  <textarea
                    value={brokenReason}
                    onChange={e => setBrokenReason(e.target.value)}
                    rows={3}
                    placeholder={t('E.g. Cracked during kiln firing — handle separated at the join.', 'مثال: تشقّقت أثناء الحرق في الفرن — انفصل المقبض عند الوصلة.')}
                    className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                  />
                </div>

                {brokenError && (
                  <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl p-2.5">
                    {brokenError}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  onClick={() => { setBrokenTargetId(null); setBrokenError(''); }}
                  className="bg-brand-sand/60 hover:bg-brand-sand text-brand-charcoal font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors"
                >
                  {t('Cancel', 'إلغاء')}
                </button>
                <button
                  onClick={async () => {
                    if (!brokenPerformer) {
                      setBrokenError(t('Select the staff member recording this.', 'اختر الموظف الذي يسجّل هذا.'));
                      return;
                    }
                    await handleUpdatePieceStatus(
                      brokenTargetId,
                      'Broken',
                      brokenPerformer,
                      brokenReason.trim() || 'Piece reported broken'
                    );
                    setBrokenTargetId(null);
                    setBrokenPerformer('');
                    setBrokenReason('');
                    setBrokenError('');
                    setSelectedPieceId(null);
                  }}
                  className="bg-red-600 hover:bg-red-700 text-brand-cream font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors shadow-sm"
                >
                  {t('Confirm Broken', 'تأكيد الكسر')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ================= RESOLVE BROKEN PIECE MODAL ================= */}
      {resolveTargetId && (() => {
        const target = pieces.find(p => p.id === resolveTargetId);
        if (!target) return null;

        const RESOLUTION_TYPES = ['Replaced', 'Refunded', 'Other'] as const;

        return (
          <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-60 flex items-center justify-center p-4">
            <div className="bg-white border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-md w-full space-y-4 text-left animate-in zoom-in-95 duration-150">

              <div className="flex items-start gap-3 border-b border-brand-clay/60 pb-3">
                <div className="h-10 w-10 rounded-2xl bg-brand-charcoal/10 text-brand-charcoal flex items-center justify-center shrink-0">
                  <ClipboardList className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-display text-base font-bold text-brand-charcoal">{t('Resolve Broken Piece', 'معالجة القطعة المكسورة')}</h3>
                  <p className="text-[11px] font-semibold text-brand-charcoal/60">
                    {target.pieceCode || target.id} · {target.customerName}
                  </p>
                </div>
              </div>

              <p className="text-[11px] font-semibold text-brand-charcoal/70 bg-brand-cream/60 border border-brand-clay/50 rounded-xl p-2.5">
                {t('This closes the piece out as Collected. Choose how it was resolved with the customer.', 'يؤدي هذا إلى إغلاق القطعة كـ«مستلمة». اختر كيف تمت التسوية مع العميل.')}
              </p>

              <div className="space-y-3.5 text-xs">
                <div className="space-y-1.5">
                  <label className="font-bold text-brand-charcoal/60 block">{t('Resolution *', 'التسوية *')}</label>
                  <div className="grid grid-cols-3 gap-2">
                    {RESOLUTION_TYPES.map(type => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => { setResolveType(type); setResolveError(''); }}
                        className={`py-2.5 rounded-xl border font-bold text-center transition-colors cursor-pointer ${
                          resolveType === type
                            ? 'bg-brand-charcoal text-brand-cream border-brand-charcoal'
                            : 'bg-brand-cream border-brand-clay text-brand-charcoal hover:bg-brand-sand'
                        }`}
                      >
                        {enumLabel('resolutionType', type, lang)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/60 block">{t('Staff member recording this *', 'الموظف الذي يسجّل هذا *')}</label>
                  <select
                    value={resolvePerformer}
                    onChange={e => { setResolvePerformer(e.target.value); setResolveError(''); }}
                    className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                  >
                    <option value="">{t('Select staff member...', 'اختر الموظف...')}</option>
                    {assignableStaff.map(s => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/60 block">
                    {t('Note', 'ملاحظة')}{resolveType === 'Other' ? ' *' : t(' (optional)', ' (اختياري)')}
                  </label>
                  <textarea
                    value={resolveNote}
                    onChange={e => { setResolveNote(e.target.value); setResolveError(''); }}
                    rows={3}
                    placeholder={resolveType === 'Other' ? t('Describe how this was resolved…', 'صف كيف تمت التسوية…') : t('Optional additional detail…', 'تفاصيل إضافية اختيارية…')}
                    className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                  />
                </div>

                {resolveError && (
                  <p className="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-xl p-2.5">
                    {resolveError}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  onClick={() => { setResolveTargetId(null); setResolveError(''); }}
                  className="bg-brand-sand/60 hover:bg-brand-sand text-brand-charcoal font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors"
                >
                  {t('Cancel', 'إلغاء')}
                </button>
                <button
                  onClick={async () => {
                    if (!resolveType) {
                      setResolveError(t('Choose how this was resolved.', 'اختر كيف تمت التسوية.'));
                      return;
                    }
                    if (!resolvePerformer) {
                      setResolveError(t('Select the staff member recording this.', 'اختر الموظف الذي يسجّل هذا.'));
                      return;
                    }
                    if (resolveType === 'Other' && !resolveNote.trim()) {
                      setResolveError(t('Add a note describing the resolution.', 'أضف ملاحظة تصف التسوية.'));
                      return;
                    }
                    const formattedReason = `Resolved: ${resolveType}${resolveNote.trim() ? ` — ${resolveNote.trim()}` : ''}`;
                    await handleUpdatePieceStatus(resolveTargetId, 'Collected', resolvePerformer, formattedReason);
                    setResolveTargetId(null);
                    setResolveType(null);
                    setResolvePerformer('');
                    setResolveNote('');
                    setResolveError('');
                    setSelectedPieceId(null);
                  }}
                  className="bg-brand-charcoal hover:bg-brand-charcoal/90 text-brand-cream font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors shadow-sm"
                >
                  {t('Confirm Resolution', 'تأكيد التسوية')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {backwardMoveTarget && (
        <div className="fixed inset-0 bg-brand-charcoal/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-md w-full text-left space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <h3 className="font-display text-lg font-bold text-red-600 flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
                <span>{t('Confirm Reverting Stage', 'تأكيد إرجاع المرحلة')}</span>
              </h3>
              <button 
                onClick={() => setBackwardMoveTarget(null)}
                className="p-1 rounded-lg hover:bg-brand-sand cursor-pointer text-brand-charcoal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-brand-charcoal/70 leading-relaxed font-semibold">
              {lang === 'ar'
                ? <>تحذير: أنت تنقل القطعة <span className="font-mono font-bold text-brand-terracotta">{backwardMoveTarget.pieceId}</span> إلى الخلف من <span className="font-bold uppercase text-brand-charcoal">{enumLabel('pieceStatus', backwardMoveTarget.currentStatus, lang)}</span> إلى <span className="font-bold uppercase text-brand-terracotta">{enumLabel('pieceStatus', backwardMoveTarget.targetStatus, lang)}</span>. يتطلب إرجاع المراحل تحققًا ومبررًا مسجَّلًا.</>
                : <>Warning: You are moving piece <span className="font-mono font-bold text-brand-terracotta">{backwardMoveTarget.pieceId}</span> backward from <span className="font-bold uppercase text-brand-charcoal">{backwardMoveTarget.currentStatus}</span> to <span className="font-bold uppercase text-brand-terracotta">{backwardMoveTarget.targetStatus}</span>. Reverting stages requires validation and a recorded justification.</>}
            </p>

            <div className="space-y-3.5 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal/60 block">{t('Who is performing this reversal?', 'من يُجري هذا الإرجاع؟')}</label>
                <select
                  value={backwardPerformer}
                  onChange={e => setBackwardPerformer(e.target.value)}
                  className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                >
                  <option value="">{t('Select staff member...', 'اختر الموظف...')}</option>
                  {assignableStaff.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-brand-charcoal/60 block">{t('Reason for Reversal / Correction note', 'سبب الإرجاع / ملاحظة التصحيح')}</label>
                <textarea
                  value={backwardReason}
                  onChange={e => setBackwardReason(e.target.value)}
                  className="w-full bg-brand-cream border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal"
                  rows={3}
                  placeholder={t('E.g. Piece needs more drying time, glazing correction required...', 'مثال: القطعة تحتاج وقتًا أطول للتجفيف أو يلزم تصحيح التزجيج...')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={() => setBackwardMoveTarget(null)}
                className="bg-brand-sand/60 hover:bg-brand-sand text-brand-charcoal font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors text-center"
              >
                {t('Cancel Move', 'إلغاء النقل')}
              </button>
              <button
                onClick={() => {
                  handleUpdatePieceStatus(
                    backwardMoveTarget.pieceId,
                    backwardMoveTarget.targetStatus,
                    backwardPerformer || 'Staff',
                    backwardReason || 'Stage corrected backward'
                  );
                  setBackwardMoveTarget(null);
                }}
                className="bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream font-bold text-xs py-3 rounded-xl cursor-pointer transition-colors text-center shadow-sm"
              >
                {t('Confirm Reversal', 'تأكيد الإرجاع')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MANUAL LOG PIECE MODAL - Cleaned & Updated to Prompt Rules */}
      {showManualLogModal && (
        <div className="fixed inset-0 bg-brand-charcoal/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-brand-cream border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-2xl w-full text-left space-y-5 animate-in zoom-in-95 duration-200 overflow-y-auto max-h-[90vh] no-scrollbar">
            
            {/* Modal Header */}
            <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3">
              <div>
                <span className="text-[10px] font-bold text-brand-terracotta font-mono uppercase tracking-widest block">{t('Pottery Logging Console', 'لوحة تسجيل الفخار')}</span>
                <h3 className="font-display text-xl font-bold text-brand-charcoal flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-brand-terracotta shrink-0" />
                  <span>{t('Log Piece Manually', 'تسجيل قطعة يدويًا')}</span>
                </h3>
              </div>
              <button 
                onClick={() => setShowManualLogModal(false)}
                className="p-1 rounded-lg text-brand-charcoal hover:bg-brand-sand cursor-pointer focus:outline-none"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body / Form */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs text-brand-charcoal">
              
              {/* Left Column: Customer & Piece Type */}
              <div className="space-y-4">
                
                {/* Searchable Customer Input with PhoneInput */}
                <div className="space-y-1.5 relative">
                  <label className="font-bold text-brand-charcoal/60 block">{t('1. Customer / Ceramic Owner *', '1. العميل / مالك القطعة *')}</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/40" />
                    <input
                      type="text"
                      placeholder={t('Type customer name to search existing...', 'اكتب اسم العميل للبحث بين العملاء الحاليين...')}
                      value={custSearch}
                      onChange={e => {
                        setCustSearch(e.target.value);
                        if (selectedCust) {
                          setSelectedCust(null);
                          setIsNewCust(false);
                        }
                      }}
                      className="w-full bg-white border border-brand-clay rounded-xl py-2.5 pl-9 pr-3 font-semibold text-brand-charcoal"
                    />
                  </div>

                  {/* Customer matches drop-down list */}
                  {!selectedCust && custSearch.trim() && (
                    <div className="absolute left-0 right-0 mt-1 bg-white border border-brand-clay rounded-xl shadow-lg z-50 max-h-40 overflow-y-auto always-scrollbar divide-y divide-brand-clay/20">
                      {filteredCustResults.map(c => (
                        <button
                          key={`${c.id}-${c.phone}`}
                          type="button"
                          onClick={() => {
                            setSelectedCust(c);
                            setCustSearch(`${c.name} (${c.phone})`);
                            setManualName(c.name);
                            setManualPhone(c.phone);
                            setManualEmail(c.email);
                            setIsNewCust(false);
                          }}
                          className="w-full text-left p-2.5 hover:bg-brand-sand/35 font-semibold text-xs flex justify-between items-center gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <p className="font-bold text-brand-charcoal truncate">{c.name}</p>
                            <p className="text-[10px] text-brand-charcoal/50 truncate">
                              {c.phone}{c.email ? ` · ${c.email}` : ''} · {c.id}
                            </p>
                          </div>
                          {/* No website account is required to link a piece */}
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ${
                            c.hasAccount
                              ? 'bg-brand-sand/50 text-brand-sage'
                              : 'bg-purple-50 text-purple-700'
                          }`}>
                            {displayOrigin(c.origin, t, lang)}
                          </span>
                        </button>
                      ))}

                      {filteredCustResults.length === 0 && (
                        <p className="p-2.5 text-[11px] font-semibold text-brand-charcoal/50 italic">
                          {t('No matching customer. Use "Add as new customer" below.', 'لا يوجد عميل مطابق. استخدم «إضافة كعميل جديد» أدناه.')}
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCust({ name: custSearch, phone: '', email: '' });
                          setManualName(custSearch);
                          setManualPhone('');
                          setManualEmail('');
                          setIsNewCust(true);
                        }}
                        className="w-full text-left p-2.5 hover:bg-brand-terracotta/5 font-bold text-brand-terracotta text-xs flex items-center gap-1.5 cursor-pointer"
                      >
                        <span>{t('+ Add', '+ إضافة')} "{custSearch}" {t('as New Customer', 'كعميل جديد')}</span>
                      </button>
                    </div>
                  )}

                  {/* Customer Phone & Name */}
                  <div className="p-3 bg-brand-sand/35 border border-brand-clay/60 rounded-xl space-y-3 mt-2">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-brand-charcoal/70">{t('Customer Name *', 'اسم العميل *')}</label>
                      <input
                        type="text"
                        required
                        value={manualName}
                        onChange={e => setManualName(e.target.value)}
                        placeholder={t('e.g. Noura Al-Amri', 'مثال: نورة العمري')}
                        className="w-full bg-white border border-brand-clay rounded-xl p-2 font-bold text-brand-charcoal"
                      />
                    </div>

                    <PhoneInput
                      label={t('Customer Phone Number', 'رقم هاتف العميل')}
                      required
                      value={manualPhone}
                      onChange={setManualPhone}
                    />
                  </div>
                </div>

                {/* Optional Workshop dropdown */}
                <div className="space-y-1.5">
                  <label className="font-bold text-brand-charcoal/60 block">{t('2. Workshop / Class Origin (Optional)', '2. الورشة / الدرس الأصلي (اختياري)')}</label>
                  <select
                    value={relatedWorkshopId}
                    onChange={e => setRelatedWorkshopId(e.target.value)}
                    className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal cursor-pointer"
                  >
                    <option value="">{t('None / Freestyle Studio Play', 'بدون / لعب حر في الاستوديو')}</option>
                    {workshops.map(w => (
                      <option key={w.id} value={w.id}>{localizedText(w.title, w.titleAr, lang)}</option>
                    ))}
                  </select>
                </div>

                {/* Piece Type Selection */}
                <div className="space-y-1.5">
                  <label className="font-bold text-brand-charcoal/60 block">{t('3. Pottery Piece Type', '3. نوع قطعة الفخار')}</label>
                  <select
                    value={pieceType}
                    onChange={e => {
                      setPieceType(e.target.value);
                    }}
                    className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                  >
                    <option value="Mug">{t('Mug', 'كوب')}</option>
                    <option value="Mug with handle">{t('Mug with handle', 'كوب بمقبض')}</option>
                    <option value="Bowl">{t('Bowl', 'وعاء')}</option>
                    <option value="Plate">{t('Plate', 'طبق')}</option>
                    <option value="Vase">{t('Vase', 'مزهرية')}</option>
                    <option value="Sculpture">{t('Sculpture', 'منحوتة')}</option>
                    <option value="Ash tray">{t('Ash tray', 'طفاية')}</option>
                    <option value="Other">{t('Other (Trinket Box, Tile, etc.)', 'أخرى (علبة حلي، بلاطة، إلخ)')}</option>
                  </select>
                </div>

                {/* Additional Description / Glazing Notes */}
                <div className="space-y-1.5">
                  <label className="font-bold text-brand-charcoal/80 block">{t('4. Additional Description / Glazing Notes', '4. وصف إضافي / ملاحظات التزجيج')}</label>
                  <textarea
                    rows={3}
                    placeholder={t('Add optional piece details, glazing colour requests, finishing instructions, or other notes…', 'أضف تفاصيل اختيارية عن القطعة أو طلبات ألوان التزجيج أو تعليمات التشطيب أو ملاحظات أخرى…')}
                    value={manualNotes}
                    onChange={e => setManualNotes(e.target.value)}
                    className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-semibold text-brand-charcoal text-xs resize-y"
                  />
                </div>

              </div>

              {/* Right Column: Piece Code, Camera Capture, Dates */}
              <div className="space-y-4">
                
                {/* OPTION 5: PIECE CODE (Required, Unique, Searchable) */}
                <div className="space-y-1.5">
                  <label className="font-bold text-brand-charcoal/80 block flex items-center justify-between">
                    <span>{t('5. Piece Code *', '5. رمز القطعة *')}</span>
                    <span className="text-[10px] text-brand-terracotta font-mono">{t('Unique Identifier', 'معرّف فريد')}</span>
                  </label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-terracotta" />
                    <input
                      type="text"
                      required
                      placeholder={t('e.g. AC-8802', 'مثال: AC-8802')}
                      value={pieceCodeInput}
                      onChange={e => setPieceCodeInput(e.target.value.toUpperCase())}
                      className="w-full bg-white border-2 border-brand-terracotta/40 rounded-xl py-2.5 pl-9 pr-3 font-mono font-bold text-brand-charcoal uppercase tracking-wider"
                    />
                  </div>
                  <p className="text-[10px] text-brand-charcoal/50 font-semibold">{t('Unique piece code stamped/written on the physical piece.', 'رمز فريد مختوم أو مكتوب على القطعة الفعلية.')}</p>
                </div>

                {/* OPTION 6: PHONE-CAMERA CAPTURE & PHOTO PREVIEW */}
                <div className="space-y-2 bg-brand-sand/30 p-3 rounded-2xl border border-brand-clay/60">
                  <label className="font-bold text-brand-charcoal/80 block">{t('6. Photo Capture & Preview', '6. التقاط الصورة ومعاينتها')}</label>
                  
                  <div className="grid grid-cols-2 gap-3 items-center">
                    <div className="aspect-video rounded-xl bg-brand-sand overflow-hidden border border-brand-clay relative">
                      {customPhotoUrl ? (
                        <img
                          src={customPhotoUrl}
                          alt={t('Preview', 'معاينة')}
                          className="h-full w-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        // The sand frame with nothing in it: honest about there
                        // being no photograph of this piece yet.
                        <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-brand-charcoal/40">
                          {t('No photo yet', 'لا توجد صورة بعد')}
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="cursor-pointer bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream text-[11px] font-bold py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 shadow-xs transition-colors">
                        <Camera className="h-4 w-4" />
                        <span>{t('Take Photo / Upload', 'التقاط صورة / رفع')}</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={handleCameraCapture}
                          className="hidden"
                        />
                      </label>
                      <p className="text-[9px] text-brand-charcoal/60 leading-tight">{t('Use phone camera to snap piece photo directly.', 'استخدم كاميرا الهاتف لالتقاط صورة القطعة مباشرة.')}</p>
                      {photoUploading && (
                        <p className="text-[10px] font-bold text-brand-charcoal/70 flex items-center gap-1">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          {t('Uploading photo…', 'جارٍ رفع الصورة…')}
                        </p>
                      )}
                      {photoError && (
                        <p className="text-[10px] font-bold text-red-700 flex items-start gap-1 leading-tight">
                          <AlertCircle className="h-3 w-3 shrink-0 mt-px" />
                          {photoError}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* DATES: Logged Date & Expected Ready Date */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="font-bold text-brand-charcoal/60 block">{t('7. Date Logged', '7. تاريخ التسجيل')}</label>
                    <DateInput
                      value={dateCreatedInput}
                      onChange={e => setDateCreatedInput(e.target.value)}
                      className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-bold text-brand-charcoal/80 block text-brand-terracotta">{t('8. Expected Ready Date *', '8. تاريخ الجاهزية المتوقع *')}</label>
                    <DateInput
                      required
                      value={expectedReadyDateInput}
                      onChange={e => setExpectedReadyDateInput(e.target.value)}
                      className="w-full bg-white border-2 border-brand-terracotta/40 rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                    />
                  </div>
                </div>

                {/* Storage shelf & Staff Assignment */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="font-bold text-brand-charcoal/60 block">{t('9. Storage Shelf', '9. رف التخزين')}</label>
                    <input
                      type="text"
                      placeholder="Shelf B-1"
                      value={storageLocationInput}
                      onChange={e => setStorageLocationInput(e.target.value)}
                      className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-bold text-brand-charcoal/60 block">{t('10. Assigned Staff', '10. الموظف المسؤول')}</label>
                    {/* Reads live from Staff Management; inactive staff are not offered. */}
                    <select
                      value={assignedStaffInput}
                      onChange={e => setAssignedStaffInput(e.target.value)}
                      className="w-full bg-white border border-brand-clay rounded-xl p-2.5 font-bold text-brand-charcoal cursor-pointer"
                    >
                      <option value="">{t('Select staff member...', 'اختر الموظف...')}</option>
                      {assignableStaff.map(s => (
                        <option key={s.id} value={s.name}>
                          {s.name}{s.position ? ` (${s.position})` : ''}
                        </option>
                      ))}
                    </select>
                    {assignableStaff.length === 0 && (
                      <p className="text-[11px] font-semibold text-amber-700">
                        {t('No active staff members. Add one in Staff Management.', 'لا يوجد موظفون نشطون. أضف موظفًا من إدارة الموظفين.')}
                      </p>
                    )}
                  </div>
                </div>

              </div>

            </div>

            {/* Modal Actions */}
            <div className="pt-4 border-t border-brand-clay/60 grid grid-cols-2 gap-4 text-xs font-bold">
              <button
                type="button"
                onClick={() => setShowManualLogModal(false)}
                className="bg-brand-sand/60 hover:bg-brand-sand text-brand-charcoal font-bold py-3 rounded-xl cursor-pointer transition-colors text-center"
              >
                {t('Cancel / Reset', 'إلغاء / إعادة تعيين')}
              </button>

              <button
                type="button"
                onClick={async () => {
                  if (!manualName.trim() || !manualPhone.trim()) {
                    alert(t('Please specify Customer Name and Phone number.', 'يرجى تحديد اسم العميل ورقم الهاتف.'));
                    return;
                  }

                  if (!pieceCodeInput.trim()) {
                    alert(t('Piece Code is required and must be unique.', 'رمز القطعة مطلوب ويجب أن يكون فريدًا.'));
                    return;
                  }

                  if (photoUploading) {
                    alert(t('The photo is still uploading. Please wait a moment.', 'لا تزال الصورة قيد الرفع. يرجى الانتظار قليلًا.'));
                    return;
                  }

                  // Uniqueness check for Piece Code
                  const normalizedPieceCode = pieceCodeInput.trim().toUpperCase();
                  const codeExists = pieces.some(p => {
                    const existingCode = (p.pieceCode || p.id).trim().toUpperCase();
                    return existingCode === normalizedPieceCode;
                  });

                  if (codeExists) {
                    alert(t(`Piece code '${normalizedPieceCode}' already exists. Please use a unique code.`, `رمز القطعة '${normalizedPieceCode}' موجود بالفعل. يرجى استخدام رمز فريد.`));
                    return;
                  }

                  const selectedWorkshop = workshops.find(w => w.id === relatedWorkshopId);

                  // Resolve against the one shared customers table: an existing
                  // customer is reused (matched on normalized phone), never copied.
                  const { customer: linkedCustomer } = await resolveCustomer(
                    {
                      name: manualName.trim(),
                      phone: manualPhone.trim(),
                      email: manualEmail.trim()
                    },
                    // Staff typing a customer in by hand while logging a piece.
                    'Admin Created'
                  );

                  const newPieceData = {
                    customerId: linkedCustomer.id,
                    // The customer's My Pieces page shows this workshop's cover
                    // photo instead of the shot uploaded below.
                    workshopId: selectedWorkshop?.id,
                    pieceCode: pieceCodeInput.trim(),
                    name: pieceNameInput.trim() || `${pieceType} Piece`,
                    workshopName: selectedWorkshop ? selectedWorkshop.title : 'Freestyle Handbuilding',
                    customerName: manualName.trim(),
                    customerPhone: manualPhone.trim(),
                    dateCreated: dateCreatedInput,
                    // No stand-in photograph. This used to fall back to a stock
                    // photo of the selected piece type, so a piece nobody
                    // photographed was stored carrying a picture of someone
                    // else's mug — which the customer then reads as their own
                    // pottery on My Pieces.
                    // The storage reference, never the photo itself: see
                    // handleCameraCapture. Empty when nothing was uploaded.
                    image: customPhotoRef || '',
                    status: initialStatus,
                    assignedStaff: assignedStaffInput,
                    storageLocation: storageLocationInput,
                    notes: manualNotes,
                    additionalDescriptionGlazingNotes: manualNotes,
                    expectedCompletion: expectedReadyDateInput,
                    expectedReadyDate: expectedReadyDateInput
                  };

                  try {
                    await addPiece(newPieceData);
                  } catch (err) {
                    alert(err instanceof Error ? err.message : t('Could not log the piece. Please try again.', 'تعذّر تسجيل القطعة. يرجى المحاولة مرة أخرى.'));
                    return;
                  }

                  triggerToast(
                    t('Ceramic Piece Added Successfully', 'تمت إضافة قطعة السيراميك بنجاح'),
                    t(`Logged piece "${pieceCodeInput}" under customer "${manualName}".`, `تم تسجيل القطعة "${pieceCodeInput}" للعميل "${manualName}".`),
                    false
                  );

                  setShowManualLogModal(false);
                  setPieceNameInput('Custom Clay Vessel');
                  setCustSearch('');
                  setManualName('');
                  setManualPhone('');
                  setSelectedCust(null);
                  setIsNewCust(false);
                  setRelatedWorkshopId('');
                  clearCustomPhoto();
                  setManualNotes('');
                }}
                className="bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream font-bold py-3 rounded-xl cursor-pointer transition-colors text-center shadow-sm"
              >
                {t('Create Piece Record', 'إنشاء سجل القطعة')}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Toast notifications container */}
      <div className="fixed bottom-6 right-6 z-50 space-y-3 max-w-sm w-full pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto p-4 rounded-2xl border shadow-xl flex gap-3 items-start justify-between animate-in slide-in-from-bottom-5 duration-300 ${
              toast.highlighted 
                ? 'bg-gradient-to-r from-amber-50 to-amber-100/40 border-amber-400 text-amber-950 ring-4 ring-amber-400/10' 
                : 'bg-brand-charcoal text-brand-cream border-brand-charcoal/40'
            }`}
          >
            <div className="text-left">
              <p className={`text-xs font-extrabold uppercase tracking-wider ${toast.highlighted ? 'text-amber-800 animate-pulse' : 'text-brand-sage'}`}>
                {toast.title}
              </p>
              <p className="text-[11px] font-semibold mt-1 leading-relaxed">
                {toast.message}
              </p>
            </div>
            <button
              onClick={() => setToasts(prev => prev.filter(item => item.id !== toast.id))}
              className="cursor-pointer shrink-0 opacity-60 hover:opacity-100"
              aria-label={t('Dismiss', 'إغلاق')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

    </div>
  );
};
