/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import {
  Users, Clock, Play, CheckCircle, PhoneCall, Plus, X, Edit2, Trash2, AlertTriangle,
  Sparkles, ChevronDown, GraduationCap, Hourglass, LayoutGrid, ArrowLeftRight
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { QueueItem } from '../types';
import { PhoneInput } from './PhoneInput';
import {
  resolveQueueInstructor, resolveQueueSession, getTodaysAvailableSessions,
  getSessionSeatUsage, computeQueueSessionPlan, validateHoursAndGuests, isSelfGuided, formatQueueNumber,
  QueueRecordSources, AvailableSessionOption, CapacitySnapshot
} from '../utils/queueUtils';
import { timeToMinutes, getEndTimeMinutes } from '../utils/timeUtils';
import { validateCustomerForm, validateBookingForm, canonicalPhone, phoneMatchKey } from '../utils/validation';
import { checkStaffMemberAvailability } from '../utils/staffAvailabilityUtils';
import { AssignmentSources } from '../utils/staffAssignments';
import { searchCustomers, summarizeCustomerActivity, customerPhoneKey, CustomerSearchResult } from '../utils/customerIdentity';
import { hasWebsiteAccount } from '../utils/accountUtils';
import { CustomerAccount } from '../types';
import {
  getConfiguredTables, computeTableStates, summarizeTableCapacity, validateTableSelection,
  tableNamesFor, TableSeatState, tableSeatTotal
} from '../utils/tableSeatingUtils';
import { TableSelector, TableMultiPicker } from './ui/TableSelector';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';

/**
 * Display text for a queue entry's activity. It stays English in the data
 * (categorizeQueueItem, the Dashboard and Bookings all read it); only the
 * self-guided pattern this page writes is translated, and anything else is shown
 * exactly as stored.
 */
const SELF_GUIDED_ACTIVITY = /^Walk-in \(No Instructor - (.+) hrs\)$/;
function displayActivity(activity: string, t: (en: string, ar: string) => string) {
  const m = SELF_GUIDED_ACTIVITY.exec(activity);
  return m ? t(activity, `زيارة مباشرة (بدون مدرب - ${m[1]} ساعة)`) : activity;
}

// ==========================================
// ======== MODULAR QUEUE CARD COMPONENTS ===
// ==========================================

const WaitingCard: React.FC<{
  item: QueueItem;
  isExpanded: boolean;
  instructorName: string;
  tableLabel?: string;
  onToggle: () => void;
  onEdit: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
  updateQueueStatus: (id: string, status: any) => void;
  onSeat: (item: QueueItem) => void;
}> = ({ item, isExpanded, instructorName, tableLabel, onToggle, onEdit, onCancel, updateQueueStatus, onSeat }) => {
  const { lang, t } = useLanguage();
  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onToggle();
  };

  return (
    <div className="bg-white border border-brand-clay rounded-2xl p-4 shadow-2xs hover:shadow-xs transition-shadow flex flex-col gap-3 relative">
      {/* Interactive Collapsed Header Area */}
      <div 
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-terracotta rounded-xl cursor-pointer flex flex-col gap-2 select-none text-left"
      >
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            <div className="bg-brand-charcoal text-brand-cream text-xs font-extrabold px-2.5 py-1.5 rounded-lg font-mono">
              {t('No.', 'رقم')} {formatQueueNumber(item.queueNumber)}
            </div>
            <span className={`text-[10px] font-bold px-2 py-1 rounded-md border ${
              item.source === 'Website' 
                ? 'bg-blue-50 border-blue-200 text-blue-700' 
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              {enumLabel('source', item.source, lang)}
            </span>
          </div>
          <div className="text-brand-charcoal/40 p-1">
            <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-brand-terracotta' : ''}`} />
          </div>
        </div>

        <div className="space-y-0.5 text-left">
          <h3 className="font-display text-sm font-bold text-brand-charcoal">{item.name}</h3>
          <p className="text-[11px] font-mono text-brand-charcoal/50 font-bold">{item.phone}</p>
        </div>
      </div>

      {/* Expanded Inline Details */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2 border-t border-brand-clay/40 space-y-3 text-left">
              {/* Controls inside expanded view */}
              <div className="flex justify-between items-center bg-brand-sand/15 p-2 rounded-xl border border-brand-clay/30">
                <span className="text-[11px] font-bold text-brand-charcoal/50">{t('Controls:', 'التحكم:')}</span>
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={() => onEdit(item)}
                    title={t('Edit entry', 'تعديل الإدخال')}
                    className="p-1.5 rounded-lg hover:bg-brand-sand border border-brand-clay/50 text-brand-charcoal/70 cursor-pointer flex items-center justify-center"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </button>
                  <button 
                    onClick={() => onCancel(item)}
                    title={t('Cancel Entry', 'إلغاء الإدخال')}
                    className="p-1.5 rounded-lg hover:bg-red-50 border border-red-200 text-red-500 cursor-pointer flex items-center justify-center"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Activity / Session Type */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-brand-charcoal/40 uppercase tracking-wider">{t('Activity / Session:', 'النشاط / الجلسة:')}</span>
                <p className="text-xs text-brand-charcoal/70 bg-brand-cream/50 p-2 rounded-lg border border-brand-clay/30 leading-relaxed">
                  {displayActivity(item.activity, t)}
                </p>
              </div>

              {/* Badges metadata: guest count, instructor, self-guided */}
              <div className="flex flex-wrap gap-2 pt-1 text-[11px] text-brand-charcoal/60">
                <span className="font-bold flex items-center gap-1 bg-brand-sand/50 px-2 py-0.5 rounded">
                  <Users className="h-3 w-3" />
                  <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.participants} {t('Guests', 'ضيوف')}</span>
                </span>
                {!isSelfGuided(item) ? (
                  <span className="font-bold flex items-center gap-1 bg-brand-sage/20 text-brand-sage-hover px-2 py-0.5 rounded">
                    <GraduationCap className="h-3 w-3" />
                    <span>{instructorName}</span>
                  </span>
                ) : (
                  <span className="font-bold flex items-center gap-1 bg-purple-50 text-purple-700 px-2 py-0.5 rounded">
                    {enumLabel('category', 'Self-Guided', lang)}
                  </span>
                )}
                {tableLabel && (
                  <span className="font-bold flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                    <LayoutGrid className="h-3 w-3" />
                    <span>{t('Reserved', 'محجوز')}: {tableLabel}</span>
                  </span>
                )}
              </div>

              {/* The operational detail box (duration, estimated end, seats/tables,
                  session time and capacity) is intentionally not rendered here to
                  keep the collapsed card clean. The values are still saved on the
                  queue record and drive capacity, timers, completion and wait-time
                  logic, and remain visible in the detailed booking views. */}

              {/* Check-in time and elapsed wait time */}
              <div className="bg-brand-sand/10 p-2 rounded-xl border border-brand-clay/20 text-[11px] space-y-1 text-brand-charcoal/70">
                <div className="flex justify-between font-bold">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{t('Check-In Time:', 'وقت تسجيل الحضور:')}</span>
                  <span className="font-mono">{item.checkInTime}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>{t('⏳ Wait Duration:', '⏳ مدة الانتظار:')}</span>
                  <span className="font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.elapsedMinutes} {t('mins', 'دقيقة')}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Primary Action Buttons (Always visible) */}
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-brand-clay/40">
        <button
          onClick={() => updateQueueStatus(item.id, 'Called')}
          className="cursor-pointer py-2 px-3 bg-amber-500 hover:bg-amber-600 text-brand-cream text-xs font-bold rounded-xl flex items-center justify-center gap-1 shadow-2xs"
        >
          <PhoneCall className="h-3 w-3" />
          <span>{t('Call', 'نداء')}</span>
        </button>
        <button
          onClick={() => onSeat(item)}
          className="cursor-pointer py-2 px-3 bg-brand-sage hover:bg-brand-sage-hover text-brand-cream text-xs font-bold rounded-xl flex items-center justify-center gap-1 shadow-2xs"
        >
          <Play className="h-3 w-3" />
          <span>{t('Seat', 'إجلاس')}</span>
        </button>
      </div>
    </div>
  );
};

const CalledCard: React.FC<{
  item: QueueItem;
  isExpanded: boolean;
  instructorName: string;
  tableLabel?: string;
  onToggle: () => void;
  onCancel: (item: QueueItem) => void;
  updateQueueStatus: (id: string, status: any) => void;
  onSeat: (item: QueueItem) => void;
}> = ({ item, isExpanded, instructorName, tableLabel, onToggle, onCancel, updateQueueStatus, onSeat }) => {
  const { lang, t } = useLanguage();
  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onToggle();
  };

  return (
    <div className="bg-white border-2 border-amber-500 rounded-2xl p-4 shadow-2xs hover:shadow-xs transition-shadow flex flex-col gap-3 relative">
      {/* Interactive Collapsed Header Area */}
      <div 
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-terracotta rounded-xl cursor-pointer flex flex-col gap-2 select-none text-left"
      >
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-2">
            <div className="bg-brand-charcoal text-brand-cream text-xs font-extrabold px-2.5 py-1.5 rounded-lg font-mono animate-pulse">
              {t('No.', 'رقم')} {formatQueueNumber(item.queueNumber)}
            </div>
            <span className={`text-[10px] font-bold px-2 py-1 rounded-md border ${
              item.source === 'Website' 
                ? 'bg-blue-50 border-blue-200 text-blue-700' 
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              {enumLabel('source', item.source, lang)}
            </span>
          </div>
          <div className="text-brand-charcoal/40 p-1">
            <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-brand-terracotta' : ''}`} />
          </div>
        </div>

        <div className="space-y-0.5 text-left">
          <h3 className="font-display text-sm font-bold text-brand-charcoal">{item.name}</h3>
          <p className="text-[11px] font-mono text-brand-charcoal/50 font-bold">{item.phone}</p>
        </div>
      </div>

      {/* Expanded Inline Details */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2 border-t border-brand-clay/40 space-y-3 text-left">
              {/* Controls inside expanded view */}
              <div className="flex justify-between items-center bg-brand-sand/15 p-2 rounded-xl border border-brand-clay/30">
                <span className="text-[11px] font-bold text-brand-charcoal/50">{t('Controls:', 'التحكم:')}</span>
                <button 
                  onClick={() => onCancel(item)}
                  title={t('Cancel Entry', 'إلغاء الإدخال')}
                  className="p-1.5 rounded-lg hover:bg-red-50 border border-red-200 text-red-500 cursor-pointer flex items-center justify-center"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Activity / Session Type */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-brand-charcoal/40 uppercase tracking-wider">{t('Activity / Session:', 'النشاط / الجلسة:')}</span>
                <p className="text-xs text-brand-charcoal/70 bg-brand-cream/50 p-2 rounded-lg border border-brand-clay/30 leading-relaxed">
                  {displayActivity(item.activity, t)}
                </p>
              </div>

              {/* Badges metadata: guest count, instructor */}
              <div className="flex flex-wrap gap-2 pt-1 text-[11px] text-brand-charcoal/60">
                <span className="font-bold flex items-center gap-1 bg-brand-sand/50 px-2 py-0.5 rounded">
                  <Users className="h-3 w-3" />
                  <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.participants} {t('Guests', 'ضيوف')}</span>
                </span>
                {!isSelfGuided(item) && (
                  <span className="font-bold flex items-center gap-1 bg-brand-sage/20 text-brand-sage-hover px-2 py-0.5 rounded">
                    <GraduationCap className="h-3 w-3" />
                    <span>{instructorName}</span>
                  </span>
                )}
                {tableLabel && (
                  <span className="font-bold flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                    <LayoutGrid className="h-3 w-3" />
                    <span>{t('Reserved', 'محجوز')}: {tableLabel}</span>
                  </span>
                )}
              </div>

              {/* Check-in time and elapsed wait time */}
              <div className="bg-brand-sand/10 p-2 rounded-xl border border-brand-clay/20 text-[11px] space-y-1 text-brand-charcoal/70">
                <div className="flex justify-between font-bold">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{t('Check-In Time:', 'وقت تسجيل الحضور:')}</span>
                  <span className="font-mono">{item.checkInTime}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>{t('⏳ Wait Duration:', '⏳ مدة الانتظار:')}</span>
                  <span className="font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.elapsedMinutes} {t('mins', 'دقيقة')}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Primary Action Buttons (Always visible) */}
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-brand-clay/40">
        <button
          onClick={() => onCancel(item)}
          className="cursor-pointer py-2 px-3 border border-red-200 text-red-500 hover:bg-red-50 text-xs font-bold rounded-xl flex items-center justify-center gap-1"
        >
          <X className="h-3 w-3" />
          <span>{t('Cancel', 'إلغاء')}</span>
        </button>
        <button
          onClick={() => onSeat(item)}
          className="cursor-pointer py-2 px-3 bg-brand-sage hover:bg-brand-sage-hover text-brand-cream text-xs font-bold rounded-xl flex items-center justify-center gap-1 shadow-2xs"
        >
          <Play className="h-3 w-3" />
          <span>{t('Seat', 'إجلاس')}</span>
        </button>
      </div>
    </div>
  );
};

/** How long before "time is up" a card turns red. */
const ENDING_SOON_MS = 5 * 60 * 1000;

/**
 * When an In Progress visit is due to finish, for either instructor type.
 *
 *  - Without Instructor: the paid hours, counted from when they were seated.
 *  - With Instructor: the booked session's end time on today's date, falling
 *    back to its start time plus the session duration.
 *
 * Returns null when there is no known end — an entry with neither paid hours
 * nor a session never warns and never auto-completes.
 */
function getVisitEnd(item: QueueItem, todayDateStr: string): Date | null {
  if (item.type === 'Without Instructor') {
    if (!item.hours || !item.seatedTime) return null;
    return new Date(new Date(item.seatedTime).getTime() + item.hours * 60 * 60 * 1000);
  }

  const endLabel = item.sessionEndTime;
  const minutes = endLabel
    ? timeToMinutes(endLabel)
    : (item.sessionStartTime
        ? getEndTimeMinutes(item.sessionStartTime, item.sessionDuration)
        : null);

  if (minutes === null || Number.isNaN(minutes)) return null;

  const day = new Date(`${item.date || todayDateStr}T00:00:00`);
  if (Number.isNaN(day.getTime())) return null;
  day.setMinutes(day.getMinutes() + minutes);
  return day;
}

/** Normal -> ending soon -> overtime, from the end time and the current tick. */
function getVisitTiming(item: QueueItem, todayDateStr: string, now: Date) {
  const endTime = getVisitEnd(item, todayDateStr);
  if (!endTime) {
    return { endTime: null, remainingMs: null, isExceeded: false, isEndingSoon: false };
  }

  const remainingMs = endTime.getTime() - now.getTime();
  return {
    endTime,
    remainingMs,
    isExceeded: remainingMs <= 0,
    isEndingSoon: remainingMs > 0 && remainingMs <= ENDING_SOON_MS
  };
}

const InProgressCard: React.FC<{
  item: QueueItem;
  isExpanded: boolean;
  instructorName: string;
  tableLabel?: string;
  onToggle: () => void;
  updateQueueStatus: (id: string, status: any) => void;
  onChangeTable: (item: QueueItem) => void;
  now: Date;
  todayDateStr: string;
}> = ({ item, isExpanded, instructorName, tableLabel, onToggle, updateQueueStatus, onChangeTable, now, todayDateStr }) => {
  const { lang, t } = useLanguage();
  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onToggle();
  };

  // Calculate live timer
  const startTime = item.seatedTime ? new Date(item.seatedTime) : null;
  const elapsedMs = startTime ? (now.getTime() - startTime.getTime()) : (item.elapsedMinutes * 60000);
  const totalSecs = Math.max(0, Math.floor(elapsedMs / 1000));
  
  const hrsStr = Math.floor(totalSecs / 3600);
  const minsStr = Math.floor((totalSecs % 3600) / 60);
  const secsStr = totalSecs % 60;
  
  const timerStr = `${hrsStr > 0 ? hrsStr + 'h ' : ''}${minsStr}m ${secsStr}s`;

  // Handle warning state calculations for Self-Guided with Hour limits
  const isWithoutInstructor = item.type === 'Without Instructor';
  const hasHours = !!item.hours;
  
  // Timing applies to both instructor types: paid hours for a self-guided
  // visit, the booked session's end time for an instructor-led one.
  const { endTime, remainingMs, isExceeded, isEndingSoon } =
    getVisitTiming(item, todayDateStr, now);

  const expectedCheckout = endTime
    ? endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  let remainingTimeStr = '';
  if (remainingMs !== null) {
    const rMins = Math.floor(Math.abs(remainingMs) / 60000);
    const rHrs = Math.floor(rMins / 60);
    const spread = `${rHrs > 0 ? rHrs + 'h ' : ''}${rMins % 60}m`;
    remainingTimeStr = isExceeded ? t(`Overtime by ${spread}`, `تجاوز بمقدار ${spread}`) : t(`${spread} left`, `متبقي ${spread}`);
  }

  return (
    <div className={`rounded-2xl p-4 shadow-2xs border-2 transition-all duration-300 flex flex-col gap-3 ${
      isExceeded || isEndingSoon
        ? 'border-red-500 bg-red-50/70 shadow-md animate-pulse'
        : 'border-brand-clay bg-white hover:shadow-xs'
    }`}>
      {/* Interactive Collapsed Header Area */}
      <div 
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-terracotta rounded-xl cursor-pointer flex flex-col gap-2 select-none text-left"
      >
        {/* One flow with a single gap, so the timing badge reads as its own
            piece of information instead of butting against the source label
            whichever source it is. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-lg bg-brand-charcoal px-2.5 font-mono text-xs font-extrabold text-brand-cream">
            {t('No.', 'رقم')} {formatQueueNumber(item.queueNumber)}
          </span>
          <span className={`inline-flex h-6 items-center rounded-md border px-2 text-[10px] font-bold ${
            item.source === 'Website'
              ? 'bg-blue-50 border-blue-200 text-blue-700'
              : 'bg-amber-50 border-amber-200 text-amber-700'
          }`}>
            {enumLabel('source', item.source, lang)}
          </span>

          {(isExceeded || isEndingSoon) && (
            <span className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-bold ${
              isExceeded
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-amber-300 bg-amber-50 text-amber-800'
            }`}>
              <AlertTriangle className="h-3 w-3" />
              <span>{isExceeded ? t('Overtime', 'تجاوز الوقت') : t('5 min left', 'تبقى 5 دقائق')}</span>
            </span>
          )}

          <ChevronDown className={`ms-auto h-4 w-4 shrink-0 text-brand-charcoal/40 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-brand-terracotta' : ''}`} />
        </div>

        <div className="space-y-0.5 text-left">
          <h3 className="font-display text-sm font-bold text-brand-charcoal">{item.name}</h3>
          {/* The same `timerStr` the expanded box used to show — one timer,
              read in a second place, so there is nothing extra to keep in
              step. Quiet by default, and it takes the warning accent when the
              session is nearly up or already over. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <p className="font-mono text-[11px] font-bold text-brand-charcoal/50">{item.phone}</p>
            <span className={`inline-flex items-center gap-1 font-mono text-[11px] font-bold ${
              isExceeded
                ? 'text-red-700'
                : isEndingSoon
                  ? 'text-amber-700'
                  : 'text-brand-charcoal/45'
            }`}>
              <Clock className="h-3.5 w-3.5" />
              <span>{timerStr}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Expanded Inline Details */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2 border-t border-brand-clay/30 space-y-3 text-left">
              {/* Activity / Session Type */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-brand-charcoal/40 uppercase tracking-wider">{t('Activity / Session:', 'النشاط / الجلسة:')}</span>
                <p className="text-xs text-brand-charcoal/70 bg-brand-cream/50 p-2 rounded-lg border border-brand-clay/30 leading-relaxed">
                  {displayActivity(item.activity, t)}
                </p>
              </div>

              {/* The Session Time box was removed: the timer now sits beside
                  the phone number, where it is readable without expanding. */}

              {/* Instructor and Workshop where applicable */}
              {/* No Self-Guided chip: the activity line above already reads
                  "Walk-in (No Instructor…)", so the tag repeated it. The row
                  wraps on its own gap, so nothing is left behind. */}
              <div className="flex flex-wrap gap-2 pt-1 text-[11px] text-brand-charcoal/60">
                <span className="font-bold flex items-center gap-1 bg-brand-sand/50 px-2 py-0.5 rounded">
                  <Users className="h-3 w-3" />
                  <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.participants} {t('Guests', 'ضيوف')}</span>
                </span>
                {!isSelfGuided(item) && (
                  <span className="font-bold flex items-center gap-1 bg-brand-sage/20 text-brand-sage-hover px-2 py-0.5 rounded">
                    <GraduationCap className="h-3 w-3" />
                    <span>{instructorName}</span>
                  </span>
                )}
                {tableLabel && (
                  <span className="font-bold flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                    <LayoutGrid className="h-3 w-3" />
                    <span>{t('Seated', 'جالس عند')}: {tableLabel}</span>
                  </span>
                )}
              </div>

              {/* Self guided Expected checkout details */}
              {endTime && (
                <div className={`p-2 rounded-xl text-[11px] border leading-relaxed ${
                  isExceeded || isEndingSoon
                    ? 'bg-red-100 border-red-200 text-red-800'
                    : 'bg-brand-sand/20 border-brand-clay/40 text-brand-charcoal/80'
                }`}>
                  {isWithoutInstructor && hasHours && (
                    <div className="flex justify-between font-bold">
                      <span>{t('Paid Hours:', 'الساعات المدفوعة:')}</span>
                      <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.hours} {t('hrs', 'ساعة')}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold">
                    <span>{isWithoutInstructor ? t('Est Checkout:', 'الخروج المتوقع:') : t('Session Ends:', 'تنتهي الجلسة:')}</span>
                    <span>{expectedCheckout}</span>
                  </div>
                  <div className="flex justify-between font-extrabold border-t border-brand-clay/20 mt-1 pt-1">
                    <span>{t('Status:', 'الحالة:')}</span>
                    <span className={isExceeded || isEndingSoon ? 'text-red-600 animate-pulse' : 'text-brand-sage-hover'}>
                      {remainingTimeStr}
                    </span>
                  </div>
                </div>
              )}

              {/* Check-in time & Seated time */}
              <div className="bg-brand-sand/10 p-2 rounded-xl border border-brand-clay/20 text-[11px] space-y-1 text-brand-charcoal/70 font-bold">
                <div className="flex justify-between">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{t('Check-In Time:', 'وقت تسجيل الحضور:')}</span>
                  <span className="font-mono">{item.checkInTime}</span>
                </div>
                <div className="flex justify-between">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{t('Seated At:', 'وقت الجلوس:')}</span>
                  <span className="font-mono">{item.seatedTime ? new Date(item.seatedTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Primary Action Buttons (Always visible) */}
      <div className={`pt-2 border-t border-brand-clay/30 grid gap-2 ${isWithoutInstructor ? 'grid-cols-[auto_1fr]' : 'grid-cols-1'}`}>
        {isWithoutInstructor && (
          <button
            onClick={() => onChangeTable(item)}
            className="cursor-pointer py-2.5 px-2 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-[10px] font-bold rounded-xl flex items-center justify-center gap-1.5"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap">{t('Change Table', 'تغيير الطاولة')}</span>
          </button>
        )}
        <button
          onClick={() => updateQueueStatus(item.id, 'Completed')}
          className="cursor-pointer py-3 bg-brand-sage hover:bg-brand-sage-hover text-brand-cream text-[11px] font-bold rounded-xl flex items-center justify-center gap-2 shadow-xs"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          <span className="whitespace-nowrap">{t('Complete Session', 'إنهاء الجلسة')}</span>
        </button>
      </div>
    </div>
  );
};

const CompletedCard: React.FC<{
  item: QueueItem;
  isExpanded: boolean;
  instructorName: string;
  onToggle: () => void;
  onReturnToWaiting: (item: QueueItem) => void;
}> = ({ item, isExpanded, instructorName, onToggle, onReturnToWaiting }) => {
  const { lang, t } = useLanguage();
  const handleCardClick = () => {
    onToggle();
  };

  // Find transition intervals
  const progressEvent = item.history?.find(h => h.status === 'In Progress');
  const completedEvent = item.history?.find(h => h.status === 'Completed');
  let timeSpentStr = '';
  if (progressEvent && completedEvent) {
    const tStart = new Date(progressEvent.timestamp).getTime();
    const tEnd = new Date(completedEvent.timestamp).getTime();
    const totalSecs = Math.max(0, Math.floor((tEnd - tStart) / 1000));
    const totalMins = Math.max(1, Math.round(totalSecs / 60));
    timeSpentStr = t(`${totalMins} mins`, `${totalMins} دقيقة`);
  } else {
    timeSpentStr = t(`${item.elapsedMinutes} mins`, `${item.elapsedMinutes} دقيقة`);
  }

  return (
    <div className="bg-white/70 border border-brand-clay/60 rounded-2xl p-4 shadow-3xs hover:shadow-xs transition-shadow flex flex-col gap-2 opacity-85">
      {/* Interactive Collapsed Header Area */}
      <div 
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-terracotta rounded-xl cursor-pointer flex flex-col gap-2 select-none text-left"
      >
        {/* One row, one gap rhythm: the pieces used to sit in two clusters
            pushed to opposite edges, which left the status stranded away from
            everything else. Each chip now has the same height and the same
            2-unit gap, with only the chevron pinned to the end. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-md bg-brand-clay px-2 font-mono text-[11px] font-extrabold text-brand-charcoal/70">
            {t('No.', 'رقم')} {formatQueueNumber(item.queueNumber)}
          </span>
          <span className="inline-flex h-6 items-center rounded-md border border-blue-100 bg-blue-50 px-2 text-[10px] font-bold text-blue-700">
            {enumLabel('source', item.source, lang)}
          </span>
          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-brand-sage-line bg-brand-sage-soft px-2 text-[10px] font-bold text-brand-sage-hover">
            <CheckCircle className="h-3.5 w-3.5" />
            <span>{enumLabel('bookingStatus', 'Completed', lang)}</span>
          </span>
          <ChevronDown className={`ms-auto h-4 w-4 shrink-0 text-brand-charcoal/40 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
        </div>

        <div className="space-y-0.5 text-left">
          <h3 className="font-display text-xs font-bold text-brand-charcoal">{item.name}</h3>
          <p className="text-[10px] font-mono text-brand-charcoal/50">{item.phone}</p>
        </div>
      </div>

      {/* Expanded Inline Details */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2 border-t border-brand-clay/30 space-y-2 text-left text-xs text-brand-charcoal/80 font-bold">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-brand-charcoal/40 uppercase tracking-wider">{t('Activity:', 'النشاط:')}</span>
                <p className="text-xs text-brand-charcoal/70 bg-brand-cream/50 p-2 rounded-lg border border-brand-clay/30 font-medium">
                  {displayActivity(item.activity, t)}
                </p>
              </div>

              {/* Stats footer */}
              <div className="flex items-center justify-between text-[11px] font-bold text-brand-charcoal/60 pt-2 border-t border-brand-clay/30">
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.participants} {t('Guests', 'ضيوف')}</span>
                </span>
                <span className="flex items-center gap-1 font-mono text-brand-sage-hover">
                  <Clock className="h-3 w-3" />
                  <span>{t(`${timeSpentStr} spent`, `استغرق ${timeSpentStr}`)}</span>
                </span>
              </div>

              {/* The instructor line only when there is one — a self-guided
                  session says so in its activity text. `ms-auto` keeps the
                  hours on the trailing edge when they are the only item, so no
                  empty slot is left where the tag used to be. */}
              {(!isSelfGuided(item) || item.hours !== undefined) && (
                <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-brand-charcoal/60">
                  {!isSelfGuided(item) && (
                    <span className="flex items-center gap-1">
                      <GraduationCap className="h-3 w-3" />
                      <span>{instructorName}</span>
                    </span>
                  )}
                  {item.hours !== undefined && (
                    <span className={isSelfGuided(item) ? 'ms-auto' : ''}>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{item.hours} {t('hrs booked', 'ساعة محجوزة')}</span>
                  )}
                </div>
              )}

              {/* `extendedByQueueId` and `returnedFromQueueId` still link a
                  completed session to the entry that continued it — the
                  relationship is untouched on the record, it just is not
                  spelled out on the card. */}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Only self-guided sessions can be given more time. Instructor-led sessions
          stay completed and are never restarted. */}
      {isSelfGuided(item) && (
        <div className="pt-2 border-t border-brand-clay/30">
          {/* `whitespace-nowrap` on the label stops it breaking at the slash
              into a ragged two lines; the fixed height keeps the icon and text
              on one baseline whatever the column width. */}
          <button
            onClick={() => onReturnToWaiting(item)}
            className="flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-brand-terracotta/50 px-3 text-[11px] font-bold text-brand-terracotta transition-colors hover:bg-brand-terracotta/5"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">{t('Add Time', 'إضافة وقت')}</span>
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Table Inventory, made useful: every configured café table, who (if anyone)
 * is reserved or seated at it, and the few actions staff actually need —
 * seat a waiting guest, move an active one, or release a reservation. No
 * floor-plan editor; this is a list, same as the rest of the console.
 */
const SeatingManagerModal: React.FC<{
  tables: TableSeatState[];
  queue: QueueItem[];
  onClose: () => void;
  onSeatWaiting: (item: QueueItem) => void;
  onChangeTable: (item: QueueItem) => void;
  onRelease: (item: QueueItem) => void;
  onAssign: (item: QueueItem, tableId: string) => void;
}> = ({ tables, queue, onClose, onSeatWaiting, onChangeTable, onRelease, onAssign }) => {
  const { lang, t } = useLanguage();
  const [assigningTableId, setAssigningTableId] = useState<string | null>(null);
  const [assignSelection, setAssignSelection] = useState<Record<string, string>>({});

  // Waiting/Called guests with no table yet — the only candidates a table can
  // pull from here, so this never contests a reservation another table holds.
  const unassignedCandidates = useMemo(
    () => queue.filter(q =>
      (q.status === 'Waiting' || q.status === 'Called') && (!q.tableIds || q.tableIds.length === 0)
    ),
    [queue]
  );

  const queueById = useMemo(() => new Map(queue.map(q => [q.id, q])), [queue]);

  return (
    <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-brand-cream border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-lg w-full text-left space-y-4 animate-in zoom-in-95 duration-200 max-h-[85vh] overflow-y-auto always-scrollbar">

        <div className="flex justify-between items-center border-b border-brand-clay/60 pb-3 sticky -top-6 bg-brand-cream pt-1">
          <div>
            <h3 className="font-display text-base font-bold text-brand-charcoal">{t('Seating Manager', 'مدير الجلوس')}</h3>
            <p className="text-[11px] font-bold text-brand-charcoal/50">{t('Every configured café table, live.', 'كل طاولات المقهى المُعدّة، مباشرةً.')}</p>
          </div>
          <button onClick={onClose} className="text-brand-charcoal hover:bg-brand-sand p-1.5 rounded-lg cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        {tables.length === 0 ? (
          <p className="text-xs font-semibold text-brand-charcoal/50 bg-white border border-brand-clay/40 rounded-xl p-4 text-center">
            {t('No café tables are configured yet. Add them in Settings → Capacity → Table Inventory.', 'لم يتم إعداد أي طاولات مقهى بعد. أضفها من الإعدادات ← السعة ← جرد الطاولات.')}
          </p>
        ) : (
          <div className="space-y-3">
            {tables.map(table => {
              const reserved = table.occupants.filter(o => o.status !== 'In Progress');
              const occupied = table.occupants.filter(o => o.status === 'In Progress');
              const eligible = unassignedCandidates.filter(c => c.participants <= table.freeSeats);

              return (
                <div key={table.id} className="border border-brand-clay rounded-2xl bg-white p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h4 className="font-display text-sm font-bold text-brand-charcoal">{table.name}</h4>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-md border ${
                      table.status !== 'Active'
                        ? 'bg-gray-100 border-gray-200 text-gray-600'
                        : table.freeSeats === 0
                          ? 'bg-red-50 border-red-200 text-red-700'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    }`}>
                      {table.status !== 'Active' ? enumLabel('resourceStatus', table.status, lang) : table.freeSeats === 0 ? t('Full', 'ممتلئة') : t('Available', 'متاحة')}
                    </span>
                  </div>

                  <p className="text-[11px] font-bold text-brand-charcoal/60 font-mono">
                    {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${table.seats} seats · ${table.occupiedSeats} occupied · ${table.reservedSeats} reserved · ${table.freeSeats} free`, `${table.seats} مقاعد · ${table.occupiedSeats} مشغولة · ${table.reservedSeats} محجوزة · ${table.freeSeats} شاغرة`)}
                  </p>

                  {occupied.map(o => (
                    <div key={o.queueId} className="flex items-center justify-between bg-brand-sage/10 border border-brand-sage/30 rounded-xl px-3 py-2">
                      <span className="text-[11px] font-bold text-brand-charcoal">
                        {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`Customer: ${o.name} / ${o.participants} guests`, `العميل: ${o.name} / ${o.participants} ضيوف`)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { const q = queueById.get(o.queueId); if (q) onChangeTable(q); }}
                        className="text-[10px] font-bold text-brand-terracotta hover:underline cursor-pointer shrink-0"
                      >
                        {t('Move', 'نقل')}
                      </button>
                    </div>
                  ))}

                  {reserved.map(o => (
                    <div key={o.queueId} className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">
                      <span className="text-[11px] font-bold text-brand-charcoal">
                        {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`Reserved for: ${o.name} / ${o.participants} guests`, `محجوزة لـ: ${o.name} / ${o.participants} ضيوف`)}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => { const q = queueById.get(o.queueId); if (q) onSeatWaiting(q); }}
                          className="text-[10px] font-bold text-brand-terracotta hover:underline cursor-pointer"
                        >
                          {t('Seat', 'إجلاس')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { const q = queueById.get(o.queueId); if (q) onRelease(q); }}
                          className="text-[10px] font-bold text-red-500 hover:underline cursor-pointer"
                        >
                          {t('Release', 'تحرير')}
                        </button>
                      </div>
                    </div>
                  ))}

                  {table.occupants.length === 0 && table.status === 'Active' && (
                    <p className="text-[11px] font-semibold text-brand-charcoal/40">{t('Available', 'متاحة')}</p>
                  )}

                  {/* Pull an unassigned Waiting/Called guest straight onto this table. */}
                  {table.status === 'Active' && table.freeSeats > 0 && eligible.length > 0 && (
                    assigningTableId === table.id ? (
                      <div className="flex items-center gap-2 pt-1">
                        <select
                          value={assignSelection[table.id] || ''}
                          onChange={e => setAssignSelection(prev => ({ ...prev, [table.id]: e.target.value }))}
                          className="flex-1 bg-white border border-brand-clay rounded-lg py-1.5 px-2 text-[11px] font-bold text-brand-charcoal"
                        >
                          <option value="">{t('Choose a waiting guest…', 'اختر ضيفًا من قائمة الانتظار…')}</option>
                          {eligible.map(c => (
                            <option key={c.id} value={c.id}>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${c.name} — ${c.participants} guests`, `${c.name} — ${c.participants} ضيوف`)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!assignSelection[table.id]}
                          onClick={() => {
                            const chosen = queueById.get(assignSelection[table.id]);
                            if (!chosen) return;
                            onAssign(chosen, table.id);
                            setAssigningTableId(null);
                            setAssignSelection(prev => ({ ...prev, [table.id]: '' }));
                          }}
                          className="px-3 py-1.5 rounded-lg bg-brand-terracotta text-brand-cream text-[11px] font-bold disabled:opacity-50 cursor-pointer"
                        >
                          {t('Assign', 'تعيين')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAssigningTableId(table.id)}
                        className="text-[11px] font-bold text-brand-terracotta hover:underline cursor-pointer pt-1"
                      >
                        {t('+ Assign a waiting guest', '+ تعيين ضيف من قائمة الانتظار')}
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
};

export const LiveQueueSection: React.FC = () => {
  const {
    queue, updateQueueStatus, updateQueueItem, addQueueItem, returnQueueItemToWaiting,
    assignQueueTables, seatQueueItem, changeQueueItemTables,
    todayDateStr, formattedTodayDate, appSettings,
    staff, workshops, workshopSessions, bookings, events,
    customers, getCustomerPieceCount, resolveCustomer, updateCustomer, addStaffNotification,
    updateWorkshopSession, appendBookingTimeline,
    birthdayPackages,
} = useApp();
  const { lang, t } = useLanguage();

  // One shared view of the real records the queue depends on.
  const recordSources: QueueRecordSources = useMemo(
    () => ({ staff, workshops, workshopSessions, bookings, queue }),
    [staff, workshops, workshopSessions, bookings, queue]
  );

  // Same assignment sources the staff console uses, for schedule conflict checks.
  const assignmentSources: AssignmentSources = useMemo(
    () => ({ staff, workshopSessions, workshops, events, bookings, birthdayPackages, queue }),
    [staff, workshopSessions, workshops, events, bookings, birthdayPackages, queue]
  );

  const capacityConfig = appSettings?.find(s => s.id === 'capacitySettings')?.value;
  // One seat total everywhere: the sum of the configured tables' seats
  // (tableSeatTotal). The old separately stored totalSeats is no longer read.
  // Floor of 1 only so the percentage below never divides by zero.
  const totalSeats = useMemo(
    () => Math.max(1, tableSeatTotal(getConfiguredTables(appSettings || []))),
    [appSettings]
  );

  // Compute live occupied seats (In Progress status)
  const inProgressQueue = useMemo(() => {
    return queue.filter(q => q.date === todayDateStr && q.status === 'In Progress');
  }, [queue, todayDateStr]);

  const occupiedSeats = useMemo(() => {
    return inProgressQueue.reduce((acc, curr) => acc + (curr.participants || 1), 0);
  }, [inProgressQueue]);

  const availableSeats = Math.max(0, totalSeats - occupiedSeats);
  const capacityPct = Math.min(100, Math.round((occupiedSeats / totalSeats) * 100));
  const defaultSeatsPerTable = Number(capacityConfig?.defaultSeatsPerTable) || 4;

  /**
   * Real per-table occupancy — every numbered café table configured in
   * Settings → Capacity, and exactly who (Waiting/Called reserved, In
   * Progress occupied) is holding its seats right now. This is the single
   * source every table-related control on this page reads: the header
   * metric, the seat/change-table pickers and the Seating Manager.
   */
  const configuredTables = useMemo(() => getConfiguredTables(appSettings), [appSettings]);
  const tableStates = useMemo(
    () => computeTableStates(configuredTables, queue, { todayDateStr }),
    [configuredTables, queue, todayDateStr]
  );
  const tableCapacitySummary = useMemo(() => summarizeTableCapacity(tableStates), [tableStates]);
  const { totalTables, occupiedTables, availableTables } = tableCapacitySummary;

  // Collapsed / Expanded state for cards
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedCards(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  // Force re-render every second for live timers
  const prefersReducedMotion = useReducedMotion();
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  /**
   * Acts once when an In Progress visit reaches its end time.
   *
   *  - Without Instructor: the paid time is over, so the visit is completed
   *    automatically through the same mutator the Complete button uses, and
   *    staff are told.
   *  - With Instructor: the card is deliberately left alone — staff finish the
   *    class themselves — but staff are still told the session time is up.
   *
   * The ref records what has already been acted on, so the one-second tick
   * cannot fire it repeatedly.
   */
  const timeUpHandled = useRef<Set<string>>(new Set());

  useEffect(() => {
    const active = queue.filter(q => q.date === todayDateStr && q.status === 'In Progress');

    // Forget entries that are no longer running, so a returned guest can be
    // acted on again on their next visit.
    const activeIds = new Set(active.map(q => q.id));
    timeUpHandled.current.forEach(id => {
      if (!activeIds.has(id)) timeUpHandled.current.delete(id);
    });

    active.forEach(item => {
      const { isExceeded } = getVisitTiming(item, todayDateStr, now);
      if (!isExceeded || timeUpHandled.current.has(item.id)) return;

      timeUpHandled.current.add(item.id);

      if (item.type === 'Without Instructor') {
        // Same transition as the Complete button, so history is appended.
        updateQueueStatus(item.id, 'Completed');
        addStaffNotification(
          '⏱ Self-guided session ended',
          `${item.name} (No. ${formatQueueNumber(item.queueNumber)}) finished their ${item.hours ?? ''} hour session and was moved to Completed Today automatically.`,
          { newStatus: 'Completed', highlighted: true }
        );
      } else {
        // Instructor-led: notify only. The card stays In Progress.
        addStaffNotification(
          '⏱ Workshop session time is up',
          `${item.name} (No. ${formatQueueNumber(item.queueNumber)}) has reached the end of their session. Complete the visit when the class is finished.`,
          { highlighted: true }
        );
      }
    });
  }, [now, queue, todayDateStr]);

  // Filter queue strictly for TODAY ONLY (Riyadh local time)
  const todayQueue = useMemo(() => {
    return queue.filter(item => item.date === todayDateStr);
  }, [queue, todayDateStr]);

  // Screen layout tabs (for mobile responsiveness)
  const [activeFilterTab, setActiveFilterTab] = useState<'Waiting' | 'Called' | 'In Progress' | 'Completed'>('Waiting');

  // Walk-In check-in modal states
  const [addModalOpen, setAddModalOpen] = useState(false);
  // The background page must stay put while this modal is open — only its
  // own content area scrolls (see the modal markup below).
  useEffect(() => {
    if (!addModalOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [addModalOpen]);
  const [walkInType, setWalkInType] = useState<'Without Instructor' | 'With Instructor'>('Without Instructor');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('+966 5');
  const [newGuests, setNewGuests] = useState(1);
  const [newHours, setNewHours] = useState(1); // Without Instructor
  const [newSessionId, setNewSessionId] = useState(''); // With Instructor — real session
  // Returning-customer lookup, against the one shared customers table.
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerAccount | null>(null);
  /** Set when a walk-in would rename the account that already owns this number. */
  const [nameConflict, setNameConflict] = useState<
    { existing: CustomerAccount; enteredName: string } | null
  >(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Edit item modal states (for Waiting items)
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<QueueItem | null>(null);
  const [editGuests, setEditGuests] = useState(1);
  const [editHours, setEditHours] = useState(1);
  // Instructor being assigned while editing a With Instructor entry.
  const [editStaffId, setEditStaffId] = useState('');
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  // Return-to-waiting modal (completed self-guided guests)
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  // Same background-scroll lock as the Add Walk-In modal.
  useEffect(() => {
    if (!returnModalOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [returnModalOpen]);
  const [returningItem, setReturningItem] = useState<QueueItem | null>(null);
  const [returnHours, setReturnHours] = useState(1);
  const [returnGuests, setReturnGuests] = useState(1);
  const [returnTableIds, setReturnTableIds] = useState<string[]>([]);
  const [returnErrors, setReturnErrors] = useState<Record<string, string>>({});

  // Cancel confirmation dialog states
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancellingItem, setCancellingItem] = useState<QueueItem | null>(null);

  // Table assignment at check-in — optional, only for Without Instructor.
  const [newTableIds, setNewTableIds] = useState<string[]>([]);

  /**
   * One modal handles both "Seat" (Waiting/Called -> In Progress, table
   * required) and "Change Table" (already In Progress, table required) —
   * the only difference is whether confirming also flips the status.
   */
  const [seatModalOpen, setSeatModalOpen] = useState(false);
  const [seatModalItem, setSeatModalItem] = useState<QueueItem | null>(null);
  const [seatModalMode, setSeatModalMode] = useState<'seat' | 'change'>('seat');
  const [seatModalTableIds, setSeatModalTableIds] = useState<string[]>([]);
  const [seatModalError, setSeatModalError] = useState<string | null>(null);

  // Table Inventory -> Seating Manager
  const [seatingManagerOpen, setSeatingManagerOpen] = useState(false);

  // Stats
  const activeQueueCount = todayQueue.filter(q => q.status !== 'Completed' && q.status !== 'Cancelled').length;
  const avgWaitTime = useMemo(() => {
    const todayWaiting = todayQueue.filter(q => q.status === 'Waiting');
    if (todayWaiting.length === 0) return 0;
    return Math.round(todayWaiting.reduce((sum, curr) => sum + curr.elapsedMinutes, 0) / todayWaiting.length);
  }, [todayQueue]);

  // Live capacity snapshot shared by every derived calculation.
  const capacitySnapshot: CapacitySnapshot = useMemo(() => ({
    totalSeats,
    totalTables,
    defaultSeatsPerTable,
    oneGroupPerTable: capacityConfig?.oneGroupPerTable,
    occupiedSeats,
    occupiedTables
  }), [totalSeats, totalTables, defaultSeatsPerTable, capacityConfig, occupiedSeats, occupiedTables]);

  // Today's real, still-bookable sessions for a With Instructor walk-in.
  const availableSessions: AvailableSessionOption[] = useMemo(() => {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return getTodaysAvailableSessions(recordSources, todayDateStr, nowMinutes);
  }, [recordSources, todayDateStr, now]);

  const selectedSession = useMemo(
    () => availableSessions.find(s => s.sessionId === newSessionId) || null,
    [availableSessions, newSessionId]
  );

  // Instructor per queue entry, always resolved from the current staff record.
  const instructorFor = (item: QueueItem) => resolveQueueInstructor(item, recordSources).name;

  /**
   * Matching customers for what staff have typed so far — the same search the
   * Pottery Logging Console uses, over every customer regardless of how they
   * first reached the studio.
   */
  const customerMatches: CustomerSearchResult[] = useMemo(() => {
    if (linkedCustomer) return [];
    const query = customerQuery.trim() || newName.trim() || newPhone.trim();
    if (query.length < 2) return [];
    if (query === '+966 5' || query === '+966') return [];
    return searchCustomers(customers, query, 5);
  }, [customers, customerQuery, newName, newPhone, linkedCustomer]);

  /**
   * Piece counts for the linked customer and any matching customers,
   * keyed by customer id — via getCustomerPieceCount() (migration 0020),
   * not the global `pieces` context value, which is empty here for any
   * staff session without pieces-admin (0014). Bounded: at most 1 linked
   * customer or up to 5 matches (searchCustomers' own cap) at a time.
   */
  const [customerPieceCounts, setCustomerPieceCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const targets = linkedCustomer ? [linkedCustomer] : customerMatches.map(m => m.customer);
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        targets.map(async c => [c.id, await getCustomerPieceCount(c.id, c.phone)] as const)
      );
      if (!cancelled) {
        setCustomerPieceCounts(prev => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    })();
    return () => { cancelled = true; };
  }, [linkedCustomer, customerMatches]);

  /** Populates the form from an existing customer and links the visit to them. */
  const handleSelectExistingCustomer = (customer: CustomerAccount) => {
    setLinkedCustomer(customer);
    setNewName(customer.name || '');
    setNewPhone(customer.displayPhone || customer.phone || '');
    setCustomerQuery('');
    setErrors(prev => ({ ...prev, name: '', phone: '' }));
  };

  const handleClearLinkedCustomer = () => {
    setLinkedCustomer(null);
  };

  // Validation & Walk-in Submission
  const validateForm = async () => {
    // Name and phone come from the shared customer rules. A walk-in that
    // matches an existing customer is a returning guest, not a duplicate —
    // resolveCustomer reuses that record — so the duplicate check is skipped.
    const newErrors: Record<string, string> = await validateCustomerForm(
      { name: newName, phone: newPhone },
      { requireEmail: false, allowExistingCustomer: true, lang }
    );

    if (walkInType === 'With Instructor') {
      // Capacity is re-read from the database at submit time, not taken from
      // the snapshot the modal opened with.
      const bookingErrors = await validateBookingForm({
        sessionId: newSessionId,
        participants: newGuests
      }, undefined, undefined, lang);
      if (bookingErrors.sessionId) newErrors.session = bookingErrors.sessionId;
      else if (bookingErrors.participants) newErrors.session = bookingErrors.participants;
    } else {
      Object.assign(newErrors, validateHoursAndGuests(newHours, newGuests));
      // Table selection at check-in is optional, but a chosen table must
      // genuinely fit. This is the eager check for instant feedback; addQueueItem
      // re-validates against a fresh read regardless (never trust only this one).
      if (newTableIds.length > 0) {
        const tableCheck = validateTableSelection(newTableIds, newGuests, tableStates);
        if (!tableCheck.valid) newErrors.tables = tableCheck.error!;
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleAddWalkIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(await validateForm())) return;

    const enteredName = newName.trim();
    const phoneKey = phoneMatchKey(newPhone);

    // The account this number already belongs to, if any.
    const existing = linkedCustomer
      || customers.find(c => customerPhoneKey(c) === phoneKey);

    // Saving would rename that account. Ask first rather than overwriting.
    if (existing && existing.name && existing.name.trim().toLowerCase() !== enteredName.toLowerCase()) {
      setNameConflict({ existing, enteredName });
      return;
    }

    await submitWalkIn(enteredName, existing);
  };

  /**
   * Writes the walk-in. `nameToUse` is what the shared customer record ends up
   * with, so the caller decides whether an existing account keeps its name.
   */
  const submitWalkIn = async (nameToUse: string, existing?: CustomerAccount) => {
    const isWithInstructor = walkInType === 'With Instructor';
    const activity = isWithInstructor && selectedSession
      ? `${selectedSession.workshopTitle} (${selectedSession.startTime})`
      : `Walk-in (No Instructor - ${newHours} hrs)`;

    // Stored in the one canonical format so the match key always agrees.
    const normPhone = canonicalPhone(newPhone);

    // One shared customer record: an existing number always links to its own
    // account, never to a second record. resolveCustomer matches on the
    // normalized phone, so passing the chosen name is what decides whether the
    // stored name changes.
    // 'Live Queue' rather than the default 'Website': this person is standing at
    // the counter. Only applies when the record is created — a customer already
    // known to the studio keeps whatever they were first filed under.
    const { customer } = await resolveCustomer(
      { name: nameToUse, phone: normPhone },
      'Live Queue'
    );

    // "Update to new name" was chosen for an account that already existed.
    if (existing && nameToUse !== existing.name) {
      await updateCustomer(customer.id, { name: nameToUse });
    }

    const result = await addQueueItem({
      customerId: customer.id,
      name: nameToUse,
      phone: normPhone,
      activity,
      participants: newGuests,
      staffAvatar: '',
      // Real staff record for instructor-led entries; no default tutor.
      staffName: isWithInstructor ? (selectedSession?.instructorName || 'Unassigned') : 'Self-guided',
      staffId: isWithInstructor ? selectedSession?.instructorStaffId : undefined,
      source: 'Walk-in',
      type: walkInType,
      hours: isWithInstructor ? undefined : newHours,
      // Table assignment at check-in is optional — only ever set for
      // Without Instructor, and only when staff actually picked one.
      tableIds: !isWithInstructor && newTableIds.length > 0 ? newTableIds : undefined,
      // Real workshop/session links saved with the entry.
      workshopId: isWithInstructor ? selectedSession?.workshopId : undefined,
      sessionId: isWithInstructor ? selectedSession?.sessionId : undefined,
      sessionStartTime: isWithInstructor ? selectedSession?.startTime : undefined,
      sessionEndTime: isWithInstructor ? selectedSession?.endTime : undefined,
      sessionDuration: isWithInstructor ? selectedSession?.duration : undefined,
      sessionCapacity: isWithInstructor ? selectedSession?.capacity : undefined
    });

    if (!result.success) {
      setErrors({ tables: result.error || t('Could not check in this guest.', 'تعذّر تسجيل حضور هذا الضيف.') });
      return;
    }

    // Reset Form
    setNewTableIds([]);
    setNewName('');
    setNewPhone('+966 5');
    setNewGuests(1);
    setNewHours(1);
    setNewSessionId('');
    setLinkedCustomer(null);
    setCustomerQuery('');
    setErrors({});
    setNameConflict(null);
    setAddModalOpen(false);
    setActiveFilterTab('Waiting'); // Focus on Waiting tab for instant visual feedback
  };

  // Handle Edit Queue Item
  const handleOpenEdit = (item: QueueItem) => {
    setEditingItem(item);
    setEditGuests(item.participants);
    setEditHours(item.hours ?? 1);
    // Resolve the current instructor from the shared records — no default.
    setEditStaffId(resolveQueueInstructor(item, recordSources).staffId || '');
    setEditErrors({});
    setEditModalOpen(true);
  };

  /** The session an entry being edited belongs to, from the shared records. */
  const editingSession = useMemo(
    () => (editingItem ? resolveQueueSession(editingItem, recordSources) : undefined),
    [editingItem, recordSources]
  );

  /** Seats this session still has, excluding the entry being edited. */
  const editingCapacity = useMemo(() => {
    if (!editingSession || !editingItem) return null;
    const usage = getSessionSeatUsage(editingSession, {
      workshops,
      bookings,
      queue: queue.filter(q => q.id !== editingItem.id)
    });
    return usage;
  }, [editingSession, editingItem, workshops, bookings, queue]);

  /**
   * Staff who can take this session: active, and free for its date and time.
   * The instructor currently assigned stays selectable.
   */
  const availableInstructors = useMemo(() => {
    if (!editingItem || isSelfGuided(editingItem)) return [];

    const date = editingItem.date;
    const startTime = editingItem.sessionStartTime || editingSession?.startTime || editingItem.checkInTime;
    const endTime = editingItem.sessionEndTime || editingSession?.endTime;
    const duration = editingItem.sessionDuration || editingSession?.duration;

    return staff
      .filter(member => member.status === 'Active' || member.id === editingItem.staffId)
      .map(member => {
        const avail = checkStaffMemberAvailability({
          staff: member,
          date,
          startTime,
          endTime,
          duration,
          sources: assignmentSources,
          exclude: {
            sessionIds: editingItem.sessionId ? [String(editingItem.sessionId)] : []
          }
        });
        return { member, avail };
      })
      // Only currently available staff (plus whoever is already assigned).
      .filter(({ member, avail }) => avail.isAvailable || member.id === editingItem.staffId);
  }, [editingItem, editingSession, staff, assignmentSources]);

  const handleSaveEdit = async () => {
    if (!editingItem) return;

    const selfGuided = isSelfGuided(editingItem);

    const validationErrors = selfGuided
      ? validateHoursAndGuests(editHours, editGuests)
      : validateHoursAndGuests(1, editGuests); // instructor-led entries keep session hours
    if (!selfGuided) delete validationErrors.hours;

    // Guests may not exceed what the session still has free.
    if (!selfGuided && editingCapacity) {
      const guests = Number(editGuests);
      if (Number.isFinite(guests) && guests > editingCapacity.remainingCapacity) {
        validationErrors.guests = t(
          `Only ${editingCapacity.remainingCapacity} seat(s) remain in this session ` +
          `(capacity ${editingCapacity.capacity}, ${editingCapacity.seatsTaken} already taken).`,
          `تبقّى ${editingCapacity.remainingCapacity} مقاعد فقط في هذه الجلسة (السعة ${editingCapacity.capacity}، المحجوز ${editingCapacity.seatsTaken}).`
        );
      }
    }

    if (!selfGuided && !editStaffId) {
      validationErrors.instructor = t('Select an instructor for this session.', 'اختر مدرّبًا لهذه الجلسة.');
    }

    if (Object.keys(validationErrors).length > 0) {
      setEditErrors(validationErrors);
      return;
    }

    const updates: Partial<QueueItem> = { participants: Number(editGuests) };

    if (selfGuided) {
      // Hours drive duration, estimated end time and the capacity figures, all of
      // which are recomputed from the saved record.
      updates.hours = Number(editHours);
      updates.activity = `Walk-in (No Instructor - ${Number(editHours)} hrs)`;
    } else if (editStaffId && editStaffId !== editingItem.staffId) {
      const member = staff.find(m => m.id === editStaffId);
      if (!member) {
        setEditErrors({ instructor: t('That staff member no longer exists.', 'لم يعد هذا الموظف موجودًا.') });
        return;
      }
      // Store the stable id; the name is denormalized for display only.
      updates.staffId = member.id;
      updates.staffName = member.name;
    }

    await updateQueueItem(editingItem.id, updates);

    // Keep the linked booking and workshop session pointing at the same tutor,
    // so the staff calendar and customer view agree. Workshop and session links
    // are left untouched.
    if (!selfGuided && editStaffId && editStaffId !== editingItem.staffId) {
      const member = staff.find(m => m.id === editStaffId);
      if (member) {
        if (editingItem.sessionId) {
          await updateWorkshopSession(String(editingItem.sessionId), {
            staffId: member.id,
            instructor: member.name
          });
        }
        if (editingItem.bookingId) {
          await appendBookingTimeline(
            String(editingItem.bookingId),
            `Instructor reassigned to ${member.name} via Live Queue`
          );
        }
      }
    }

    setEditModalOpen(false);
    setEditingItem(null);
    setEditErrors({});
  };

  // Handle returning a completed self-guided guest to Waiting for more time
  const handleOpenReturn = (item: QueueItem) => {
    setReturningItem(item);
    setReturnHours(1);
    setReturnGuests(item.participants || 1);
    // Defaults to the table(s) this guest already had — "keep the current
    // table" is one tap away, but staff can still pick something else.
    setReturnTableIds(item.tableIds || []);
    setReturnErrors({});
    setReturnModalOpen(true);
  };

  /** Table occupancy for the Add Time modal — the guest's own former table(s)
      are excluded from their own reservation math, same as the Seat modal. */
  const returnTableStates = useMemo(
    () => computeTableStates(configuredTables, queue, {
      excludeQueueId: returningItem?.id,
      todayDateStr
    }),
    [configuredTables, queue, returningItem, todayDateStr]
  );

  const handleConfirmReturn = async () => {
    if (!returningItem) return;

    const validationErrors = validateHoursAndGuests(returnHours, returnGuests);
    if (Object.keys(validationErrors).length > 0) {
      setReturnErrors(validationErrors);
      return;
    }

    const tableCheck = validateTableSelection(returnTableIds, Number(returnGuests), returnTableStates);
    if (!tableCheck.valid) {
      setReturnErrors({ form: tableCheck.error! });
      return;
    }

    const result = await returnQueueItemToWaiting(returningItem.id, {
      hours: Number(returnHours),
      participants: Number(returnGuests),
      tableIds: returnTableIds
    });

    if (!result.success) {
      setReturnErrors({ form: result.message || t('Could not continue this session.', 'تعذّر متابعة هذه الجلسة.') });
      return;
    }

    setReturnModalOpen(false);
    setReturningItem(null);
    setActiveFilterTab('In Progress');
  };

  /**
   * Opens the shared Seat / Change Table modal. "Seat" is only required for a
   * Without Instructor entry — an instructor-led seat moves straight to
   * In Progress exactly as before, since it books a workshop session/room,
   * not a café table.
   */
  const handleOpenSeatModal = (item: QueueItem, mode: 'seat' | 'change') => {
    setSeatModalItem(item);
    setSeatModalMode(mode);
    setSeatModalTableIds(item.tableIds || []);
    setSeatModalError(null);
    setSeatModalOpen(true);
  };

  const handleSeatOrCall = (item: QueueItem) => {
    if (item.type === 'Without Instructor') {
      handleOpenSeatModal(item, 'seat');
    } else {
      updateQueueStatus(item.id, 'In Progress');
    }
  };

  /** Table occupancy for the Seat/Change modal, excluding the item's own current hold. */
  const seatModalTableStates = useMemo(
    () => computeTableStates(configuredTables, queue, {
      excludeQueueId: seatModalItem?.id,
      todayDateStr
    }),
    [configuredTables, queue, seatModalItem, todayDateStr]
  );

  const handleConfirmSeatModal = async () => {
    if (!seatModalItem) return;

    const check = validateTableSelection(seatModalTableIds, seatModalItem.participants, seatModalTableStates);
    if (!check.valid) {
      setSeatModalError(check.error!);
      return;
    }

    const result = seatModalMode === 'seat'
      ? await seatQueueItem(seatModalItem.id, seatModalTableIds)
      : await changeQueueItemTables(seatModalItem.id, seatModalTableIds);

    if (!result.success) {
      setSeatModalError(result.error || t('Could not update the table assignment.', 'تعذّر تحديث تعيين الطاولة.'));
      return;
    }

    setSeatModalOpen(false);
    setSeatModalItem(null);
    setSeatModalTableIds([]);
    if (seatModalMode === 'seat') setActiveFilterTab('In Progress');
  };

  // Handle Cancellation flow
  const handleRequestCancel = (item: QueueItem) => {
    setCancellingItem(item);
    setCancelConfirmOpen(true);
  };

  const handleConfirmCancel = async () => {
    if (!cancellingItem) return;
    await updateQueueStatus(cancellingItem.id, 'Cancelled');
    setCancelConfirmOpen(false);
    setCancellingItem(null);
  };

  // Categories of filtered queue lists for today
  const waitingItems = useMemo(() => todayQueue.filter(q => q.status === 'Waiting'), [todayQueue]);
  const calledItems = useMemo(() => todayQueue.filter(q => q.status === 'Called'), [todayQueue]);
  /**
   * In Progress, with anyone in their last five minutes lifted to the top.
   *
   * The ordering is derived from the same `getVisitTiming` the card itself
   * uses, so the list and the card can never disagree about who is urgent.
   * Within each group the original queue order is kept, so two urgent guests
   * stay in the order they were seated rather than swapping places on a tick.
   */
  const inProgressItems = useMemo(() => {
    const active = todayQueue.filter(q => q.status === 'In Progress');
    return active
      .map((item, index) => ({
        item,
        index,
        timing: getVisitTiming(item, todayDateStr, now)
      }))
      .sort((a, b) => {
        // Overtime counts as urgent too — it is past the warning, not before it.
        const aUrgent = a.timing.isEndingSoon || a.timing.isExceeded;
        const bUrgent = b.timing.isEndingSoon || b.timing.isExceeded;
        if (aUrgent !== bUrgent) return aUrgent ? -1 : 1;
        if (aUrgent && bUrgent) {
          // Least time left first.
          return (a.timing.remainingMs ?? 0) - (b.timing.remainingMs ?? 0);
        }
        return a.index - b.index;
      })
      .map(entry => entry.item);
  }, [todayQueue, todayDateStr, now]);

  /**
   * Whose five-minute warning is currently live.
   *
   * Keyed on the visit's end time as well as the entry id, so a guest who is
   * seated again later warns again — while a warning that has been dismissed
   * stays dismissed for that session, however many times this re-renders.
   */
  const endingSoonWarnings = useMemo(
    () =>
      todayQueue
        .filter(q => q.status === 'In Progress')
        .map(item => {
          const timing = getVisitTiming(item, todayDateStr, now);
          return { item, timing };
        })
        .filter(entry => entry.timing.isEndingSoon && entry.timing.endTime)
        .map(entry => ({
          key: `${entry.item.id}:${entry.timing.endTime!.getTime()}`,
          item: entry.item,
          minutesLeft: Math.max(1, Math.ceil((entry.timing.remainingMs ?? 0) / 60000))
        })),
    [todayQueue, todayDateStr, now]
  );

  const [dismissedWarnings, setDismissedWarnings] = useState<string[]>([]);
  const visibleWarnings = endingSoonWarnings.filter(w => !dismissedWarnings.includes(w.key));
  const completedItems = useMemo(() => todayQueue.filter(q => q.status === 'Completed'), [todayQueue]);

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 text-left bg-brand-cream min-h-full">
      
      {/* High-visibility Tablet Friendly Header - Read-only static date */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center p-6 bg-brand-charcoal text-brand-cream rounded-3xl shadow-md gap-4">
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-brand-sage uppercase tracking-widest">{t('Live Studio Queue • Riyadh Local Time', 'طابور الاستوديو المباشر • بتوقيت الرياض')}</p>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold select-none">{formattedTodayDate}</h1>
            <span className="h-2 w-2 rounded-full bg-red-500 animate-ping"></span>
          </div>
          <div className="flex items-center gap-4 text-xs text-brand-cream/70 font-semibold pt-1">
            <span className="flex items-center gap-1">
              <Users className="h-4 w-4 text-brand-terracotta" />
              <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${activeQueueCount} active artists today`, `${activeQueueCount} فنانين نشطين اليوم`)}</span>
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4 text-brand-sage" />
              <span>{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`Avg Wait Time: ${avgWaitTime} minutes`, `متوسط وقت الانتظار: ${avgWaitTime} دقيقة`)}</span>
            </span>
          </div>
        </div>

        {/* Primary Action Panel */}
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          <button
            onClick={() => setAddModalOpen(true)}
            className="cursor-pointer w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-brand-terracotta text-brand-cream text-sm font-bold px-5 py-4 rounded-xl hover:bg-brand-terracotta-hover transition-colors shadow-sm"
          >
            <Plus className="h-5 w-5 stroke-[3]" />
            <span>{t('Check In Walk-In', 'تسجيل زيارة مباشرة')}</span>
          </button>
        </div>
      </div>

      {/* LIVE QUEUE CAPACITY & SEATING METRICS BAR */}
      <div className="bg-white border border-brand-clay/60 rounded-3xl p-5 shadow-xs grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
        {/* Seats Occupancy Metric */}
        <div className="space-y-2">
          <div className="flex justify-between items-center text-xs font-bold">
            <span className="text-brand-charcoal/70 uppercase tracking-wider text-[10px]">{t('Studio Seats Occupied', 'مقاعد الاستوديو المشغولة')}</span>
            <span className="font-mono text-brand-charcoal">
              {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${occupiedSeats} / ${totalSeats} Seats (${capacityPct}%)`, `${occupiedSeats} / ${totalSeats} مقعد (${capacityPct}%)`)}
            </span>
          </div>
          <div className="w-full h-3 bg-brand-cream border border-brand-clay/40 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                capacityPct >= 90
                  ? 'bg-red-500'
                  : capacityPct >= 75
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
              }`}
              style={{ width: `${capacityPct}%` }}
            ></div>
          </div>
          <p className="text-[11px] text-brand-charcoal/60 font-medium">
            {t('Available:', 'المتاح: تبقى')} <strong className="text-emerald-700 font-bold font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{availableSeats} {t('seats', 'مقاعد')}</strong>{t(' left', '')}
          </p>
        </div>

        {/* Tables Inventory Metric — opens the Seating Manager */}
        <button
          type="button"
          onClick={() => setSeatingManagerOpen(true)}
          className="p-3 bg-brand-cream/40 border border-brand-clay/40 rounded-2xl flex items-center justify-between cursor-pointer text-left hover:border-brand-terracotta/50 hover:bg-brand-cream/60 transition-colors"
        >
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-charcoal/60 block">{t('Table Inventory', 'جرد الطاولات')}</span>
            <span className="text-sm font-extrabold text-brand-charcoal font-mono">{/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${availableTables} / ${totalTables} Tables Free`, `${availableTables} / ${totalTables} طاولات شاغرة`)}</span>
            <span className="text-[10px] font-bold text-brand-terracotta block mt-0.5">{t('Open Seating Manager →', 'فتح مدير الجلوس ←')}</span>
          </div>
          <div className="flex items-center justify-center h-10 w-10 bg-brand-sand/60 text-brand-terracotta rounded-xl font-bold text-xs shrink-0">
            {occupiedTables}/{totalTables}
          </div>
        </button>

        {/* Dynamic Queue Wait-Time Throughput */}
        <div className="p-3 bg-brand-cream/40 border border-brand-clay/40 rounded-2xl flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-charcoal/60 block">{t('Queue Throughput', 'معدل سير الطابور')}</span>
            <span className="text-sm font-extrabold text-brand-charcoal font-mono">
              {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`~${waitingItems.length > 0 ? Math.max(10, Math.round((waitingItems.length * 15) / Math.max(1, availableTables))) : 0} min wait`, `انتظار ~${waitingItems.length > 0 ? Math.max(10, Math.round((waitingItems.length * 15) / Math.max(1, availableTables))) : 0} دقيقة`)}
            </span>
          </div>
          <div className="flex items-center justify-center h-10 w-10 bg-brand-sage/30 text-brand-sage-hover rounded-xl">
            <Hourglass className="h-4 w-4" />
          </div>
        </div>
      </div>

      {/* MOBILE ONLY navigation tabs */}
      <div className="flex lg:hidden border-b border-brand-clay overflow-x-auto no-scrollbar gap-2 pb-1">
        {(['Waiting', 'Called', 'In Progress', 'Completed'] as const).map(tab => {
          const isActive = activeFilterTab === tab;
          const list = tab === 'Waiting' ? waitingItems 
                     : tab === 'Called' ? calledItems 
                     : tab === 'In Progress' ? inProgressItems 
                     : completedItems;
          return (
            <button
              key={tab}
              onClick={() => setActiveFilterTab(tab)}
              className={`px-5 py-3.5 text-xs font-bold border-b-2 whitespace-nowrap transition-all cursor-pointer ${
                isActive 
                  ? 'border-brand-terracotta text-brand-terracotta bg-white/40' 
                  : 'border-transparent text-brand-charcoal/50 hover:text-brand-terracotta'
              }`}
            >
              <span>{enumLabel('bookingStatus', tab, lang)}</span>
              {list.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-brand-sand text-brand-charcoal">
                  {list.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* FIVE-MINUTE WARNINGS — a staff alert, not a celebration: console
          cream and clay with one amber accent, a short fade-and-rise, and no
          animation once it has arrived. Stacked, one per guest, each dismissed
          on its own. Dismissal is keyed on the visit's end time, so closing one
          does not silence the next guest and does not come back on the next
          tick. */}
      {visibleWarnings.length > 0 && (
        <div className="space-y-2">
          {visibleWarnings.map(warning => (
            <motion.div
              key={warning.key}
              initial={prefersReducedMotion ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              role="status"
              className="flex items-start gap-3 rounded-2xl border border-brand-clay bg-brand-cream p-3.5 shadow-2xs"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                <Clock className="h-3.5 w-3.5" />
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-brand-charcoal">
                  {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${warning.item.name} · ${warning.minutesLeft} minute${warning.minutesLeft === 1 ? '' : 's'} remaining`, `${warning.item.name} · تبقى ${warning.minutesLeft} دقيقة`)}
                </p>
                <p className="mt-0.5 text-[11px] font-semibold text-brand-charcoal/55">
                  {[
                    displayActivity(warning.item.activity, t),
                    warning.item.staffName ? t(`with ${warning.item.staffName}`, `مع ${warning.item.staffName}`) : null,
                    `${t('No.', 'رقم')} ${formatQueueNumber(warning.item.queueNumber)}`
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setDismissedWarnings(prev => [...prev, warning.key])}
                aria-label={t(`Dismiss the warning for ${warning.item.name}`, `تجاهل التنبيه الخاص بـ ${warning.item.name}`)}
                className="shrink-0 rounded-lg p-1 text-brand-charcoal/40 transition-colors hover:bg-brand-sand hover:text-brand-charcoal cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* KANBAN BOARD WRAPPER: All columns side-by-side on lg screen, tab-filtered on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        
        {/* ================= COLUMN 1: WAITING ================= */}
        <div className={`flex flex-col gap-4 bg-brand-sand/15 p-4 rounded-3xl border border-brand-clay/30 min-h-[400px] ${activeFilterTab === 'Waiting' ? 'flex' : 'hidden lg:flex'}`}>
          <div className="flex justify-between items-center pb-2 border-b border-brand-clay/40">
            <h2 className="font-display text-sm font-bold text-brand-charcoal flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-500"></span>
              <span>{t('Waiting List', 'قائمة الانتظار')}</span>
            </h2>
            <span className="bg-brand-sand px-2 py-0.5 rounded-full text-xs font-bold text-brand-charcoal/60">{waitingItems.length}</span>
          </div>

          {/* Three cards tall, then the list scrolls inside itself — one busy
              column must not stretch the page and push the others out of
              reach. `always-scrollbar` keeps the bar visible so it is obvious
              there is more below. */}
          <div className="max-h-[27rem] space-y-4 overflow-y-auto always-scrollbar pe-1">
            {waitingItems.length === 0 ? (
              <div className="py-12 text-center text-xs text-brand-charcoal/40 bg-white/40 rounded-2xl border border-dashed border-brand-clay/50">
                {t('No guests waiting.', 'لا يوجد ضيوف في الانتظار.')}
              </div>
            ) : (
              waitingItems.map(item => (
                <WaitingCard
                  key={item.id}
                  item={item}
                  isExpanded={!!expandedCards[item.id]}
                  instructorName={instructorFor(item)}
                  tableLabel={tableNamesFor(item.tableIds, configuredTables)}
                  onToggle={() => toggleExpand(item.id)}
                  onEdit={handleOpenEdit}
                  onCancel={handleRequestCancel}
                  updateQueueStatus={updateQueueStatus}
                  onSeat={handleSeatOrCall}
                />
              ))
            )}
          </div>
        </div>

        {/* ================= COLUMN 2: CALLED ================= */}
        <div className={`flex flex-col gap-4 bg-brand-sand/15 p-4 rounded-3xl border border-brand-clay/30 min-h-[400px] ${activeFilterTab === 'Called' ? 'flex' : 'hidden lg:flex'}`}>
          <div className="flex justify-between items-center pb-2 border-b border-brand-clay/40">
            <h2 className="font-display text-sm font-bold text-brand-charcoal flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-600 animate-pulse"></span>
              <span>{t('Called List', 'قائمة المنادَين')}</span>
            </h2>
            <span className="bg-brand-sand px-2 py-0.5 rounded-full text-xs font-bold text-brand-charcoal/60">{calledItems.length}</span>
          </div>

          <div className="max-h-[27rem] space-y-4 overflow-y-auto always-scrollbar pe-1">
            {calledItems.length === 0 ? (
              <div className="py-12 text-center text-xs text-brand-charcoal/40 bg-white/40 rounded-2xl border border-dashed border-brand-clay/50">
                {t('No called entries.', 'لا توجد إدخالات منادى عليها.')}
              </div>
            ) : (
              calledItems.map(item => (
                <CalledCard
                  key={item.id}
                  item={item}
                  isExpanded={!!expandedCards[item.id]}
                  instructorName={instructorFor(item)}
                  tableLabel={tableNamesFor(item.tableIds, configuredTables)}
                  onToggle={() => toggleExpand(item.id)}
                  onCancel={handleRequestCancel}
                  updateQueueStatus={updateQueueStatus}
                  onSeat={handleSeatOrCall}
                />
              ))
            )}
          </div>
        </div>

        {/* ================= COLUMN 3: IN PROGRESS ================= */}
        <div className={`flex flex-col gap-4 bg-brand-sand/15 p-4 rounded-3xl border border-brand-clay/30 min-h-[400px] ${activeFilterTab === 'In Progress' ? 'flex' : 'hidden lg:flex'}`}>
          <div className="flex justify-between items-center pb-2 border-b border-brand-clay/40">
            <h2 className="font-display text-sm font-bold text-brand-charcoal flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-ping"></span>
              <span>{t('In Progress', 'جارية الآن')}</span>
            </h2>
            <span className="bg-brand-sand px-2 py-0.5 rounded-full text-xs font-bold text-brand-charcoal/60">{inProgressItems.length}</span>
          </div>

          <div className="max-h-[27rem] space-y-4 overflow-y-auto always-scrollbar pe-1">
            {inProgressItems.length === 0 ? (
              <div className="py-12 text-center text-xs text-brand-charcoal/40 bg-white/40 rounded-2xl border border-dashed border-brand-clay/50">
                {t('No active studio sessions.', 'لا توجد جلسات استوديو نشطة.')}
              </div>
            ) : (
              inProgressItems.map(item => (
                <InProgressCard
                  key={item.id}
                  item={item}
                  isExpanded={!!expandedCards[item.id]}
                  instructorName={instructorFor(item)}
                  tableLabel={tableNamesFor(item.tableIds, configuredTables)}
                  onToggle={() => toggleExpand(item.id)}
                  updateQueueStatus={updateQueueStatus}
                  onChangeTable={item2 => handleOpenSeatModal(item2, 'change')}
                  now={now}
                  todayDateStr={todayDateStr}
                />
              ))
            )}
          </div>
        </div>

        {/* ================= COLUMN 4: COMPLETED ================= */}
        <div className={`flex flex-col gap-4 bg-brand-sand/15 p-4 rounded-3xl border border-brand-clay/30 min-h-[400px] ${activeFilterTab === 'Completed' ? 'flex' : 'hidden lg:flex'}`}>
          <div className="flex justify-between items-center pb-2 border-b border-brand-clay/40">
            <h2 className="font-display text-sm font-bold text-brand-charcoal flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500"></span>
              <span>{t('Completed Today', 'المكتملة اليوم')}</span>
            </h2>
            <span className="bg-brand-sand px-2 py-0.5 rounded-full text-xs font-bold text-brand-charcoal/60">{completedItems.length}</span>
          </div>

          <div className="max-h-[27rem] space-y-4 overflow-y-auto always-scrollbar pe-1">
            {completedItems.length === 0 ? (
              <div className="py-12 text-center text-xs text-brand-charcoal/40 bg-white/40 rounded-2xl border border-dashed border-brand-clay/50">
                {t('No sessions completed yet today.', 'لم تكتمل أي جلسات اليوم بعد.')}
              </div>
            ) : (
              completedItems.map(item => (
                <CompletedCard
                  key={item.id}
                  item={item}
                  isExpanded={!!expandedCards[item.id]}
                  instructorName={instructorFor(item)}
                  onToggle={() => toggleExpand(item.id)}
                  onReturnToWaiting={handleOpenReturn}
                />
              ))
            )}
          </div>
        </div>

      </div>

      {/* ========================================================== */}
      {/* ================ WALK-IN CHECK-IN MODAL ================= */}
      {/* ========================================================== */}
      {/* Existing account, different name — ask before renaming it */}
      {nameConflict && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-[60] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white border border-brand-clay rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl text-left">
            <h3 className="text-base font-bold text-brand-charcoal">{t('This number already has an account', 'هذا الرقم لديه حساب بالفعل')}</h3>

            <div className="space-y-2 text-xs text-brand-charcoal/80">
              <p>
                {t('This number already has an account under', 'هذا الرقم لديه حساب باسم')}{' '}
                <span className="font-bold text-brand-charcoal">"{nameConflict.existing.name}"</span>.
              </p>
              <p>
                {t('You entered', 'لقد أدخلت')} <span className="font-bold text-brand-charcoal">"{nameConflict.enteredName}"</span>.
              </p>
              <p className="text-brand-charcoal/60">
                {t('The visit is linked to the existing account either way — choose which name it should keep.', 'تُربط الزيارة بالحساب الحالي في الحالتين — اختر الاسم الذي يجب الاحتفاظ به.')}
              </p>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={async () => {
                  const existing = nameConflict.existing;
                  setNameConflict(null);
                  await submitWalkIn(existing.name, existing);
                }}
                className="w-full py-2.5 rounded-xl bg-brand-terracotta text-brand-cream text-xs font-bold cursor-pointer hover:bg-brand-terracotta-hover transition-colors"
              >
                {t(`Keep existing name ("${nameConflict.existing.name}")`, `الاحتفاظ بالاسم الحالي ("${nameConflict.existing.name}")`)}
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { existing, enteredName } = nameConflict;
                  setNameConflict(null);
                  await submitWalkIn(enteredName, existing);
                }}
                className="w-full py-2.5 rounded-xl bg-brand-sand text-brand-charcoal border border-brand-clay text-xs font-bold cursor-pointer hover:bg-brand-clay/30 transition-colors"
              >
                {t(`Update to new name ("${nameConflict.enteredName}")`, `التحديث إلى الاسم الجديد ("${nameConflict.enteredName}")`)}
              </button>
              <button
                type="button"
                onClick={() => setNameConflict(null)}
                className="w-full py-2 rounded-xl text-xs font-bold text-brand-charcoal/60 cursor-pointer hover:bg-brand-sand/40 transition-colors"
              >
                {t('Cancel', 'إلغاء')}
              </button>
            </div>
          </div>
        </div>
      )}

      {addModalOpen && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          {/* `max-h-[90vh]` + `flex flex-col` is what keeps this modal inside
              the viewport at any window height: the header and footer are
              shrink-0 siblings of the scroll area, not part of it, so they
              can never be scrolled out of reach — this used to be one long
              unbounded column, which is how the close button ended up above
              the top of the screen on shorter windows. */}
          <div className="bg-brand-cream border border-brand-clay rounded-3xl shadow-2xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden text-left animate-in zoom-in-95 duration-200">

            {/* Header — always visible, never part of the scrolling content. */}
            <div className="shrink-0 flex justify-between items-center border-b border-brand-clay/60 px-6 py-4">
              <h3 className="font-display text-lg font-bold text-brand-charcoal flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-brand-terracotta" />
                <span>{t('Add Walk-In to Queue', 'إضافة زيارة مباشرة إلى الطابور')}</span>
              </h3>
              <button
                onClick={() => setAddModalOpen(false)}
                className="p-1.5 rounded-lg text-brand-charcoal hover:bg-brand-sand border border-transparent hover:border-brand-clay/40 cursor-pointer focus:outline-none"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* `min-h-0` lets this flex child actually shrink below its content
                height — without it, flexbox refuses to give the scroll area
                below any less than its natural (huge) size, and the footer
                gets pushed off-screen regardless of `overflow-y-auto`. */}
            <form onSubmit={handleAddWalkIn} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto always-scrollbar px-6 py-4 space-y-4">

            {/* TWO OPTIONS AT THE TOP presented as large clearly-selectable buttons or tabs */}
            <div className="grid grid-cols-2 gap-2 bg-brand-sand/30 p-1.5 rounded-xl border border-brand-clay">
              <button
                type="button"
                onClick={() => { setWalkInType('Without Instructor'); setErrors({}); }}
                className={`py-3.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  walkInType === 'Without Instructor' 
                    ? 'bg-brand-terracotta text-brand-cream shadow-sm' 
                    : 'text-brand-charcoal/60 hover:text-brand-charcoal hover:bg-brand-sand/30'
                }`}
              >
                {enumLabel('queueType', 'Without Instructor', lang)}
              </button>
              <button
                type="button"
                onClick={() => { setWalkInType('With Instructor'); setErrors({}); }}
                className={`py-3.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  walkInType === 'With Instructor' 
                    ? 'bg-brand-terracotta text-brand-cream shadow-sm' 
                    : 'text-brand-charcoal/60 hover:text-brand-charcoal hover:bg-brand-sand/30'
                }`}
              >
                {enumLabel('queueType', 'With Instructor', lang)}
              </button>
            </div>

            {/* FORM FIELDS */}
            <div className="space-y-4">

              {/* Name Field */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-brand-charcoal/80 flex justify-between">
                  <span>{t('Guest Name', 'اسم الضيف')} <span className="text-red-500">*</span></span>
                </label>
                <input
                  type="text"
                  placeholder={t('Sara Al-Fahad', 'سارة الفهد')}
                  value={newName}
                  onChange={e => {
                    setNewName(e.target.value);
                    setCustomerQuery(e.target.value);
                    if (linkedCustomer) setLinkedCustomer(null);
                    if(errors.name) setErrors(prev => ({...prev, name: ''}));
                  }}
                  className={`w-full bg-white border rounded-xl py-3 px-3.5 text-xs font-semibold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none ${
                    errors.name ? 'border-red-500 bg-red-50/20' : 'border-brand-clay'
                  }`}
                />
                {errors.name && <p className="text-[11px] text-red-500 font-bold">{errors.name}</p>}
              </div>

              <PhoneInput
                label={t('Phone Number', 'رقم الجوال')}
                required
                value={newPhone}
                onChange={val => {
                  setNewPhone(val);
                  setCustomerQuery(val);
                  if (linkedCustomer) setLinkedCustomer(null);
                  if(errors.phone) setErrors(prev => ({...prev, phone: ''}));
                }}
                error={errors.phone}
              />

              {/* Returning-customer lookup over the shared customers table.
                  Matching is by normalized phone, so any format finds them. */}
              {linkedCustomer ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                      {t('Existing customer linked', 'تم ربط عميل حالي')}
                    </p>
                    <p className="text-xs font-bold text-brand-charcoal truncate">{linkedCustomer.name}</p>
                    <p className="text-[11px] font-mono text-brand-charcoal/60">
                      {linkedCustomer.displayPhone || linkedCustomer.phone}
                      {linkedCustomer.email ? ` · ${linkedCustomer.email}` : ''}
                    </p>
                    {(() => {
                      const summary = summarizeCustomerActivity(linkedCustomer, { bookings, queue, piecesCount: customerPieceCounts[linkedCustomer.id] });
                      return (
                        <p className="text-[10px] font-semibold text-brand-charcoal/55 mt-0.5">
                          {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${summary.visits} previous visit${summary.visits === 1 ? '' : 's'}`, `${summary.visits} زيارات سابقة`)} ·{' '}
                          {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${summary.bookings} booking${summary.bookings === 1 ? '' : 's'}`, `${summary.bookings} حجوزات`)} ·{' '}
                          {hasWebsiteAccount(linkedCustomer) ? t('Registered account', 'حساب مسجّل') : t('No website account', 'لا يوجد حساب على الموقع')} ·{' '}
                          <span className="font-mono">{linkedCustomer.id}</span>
                        </p>
                      );
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={handleClearLinkedCustomer}
                    className="text-[10px] font-bold text-brand-charcoal/50 hover:text-red-600 shrink-0 cursor-pointer"
                  >
                    {t('Unlink', 'إلغاء الربط')}
                  </button>
                </div>
              ) : customerMatches.length > 0 && (
                <div className="bg-brand-sand/25 border border-brand-clay/50 rounded-xl p-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-brand-charcoal/50 px-1 pb-1">
                    {t('Matching customers', 'عملاء مطابقون')}
                  </p>
                  {/* Fixed height with the rest reached by scrolling — the same
                      shape the piece logging console's customer search uses.
                      Stacking every match grew the card off the screen whenever
                      several customers shared a name. */}
                  <div className="max-h-40 overflow-y-auto always-scrollbar space-y-1 pe-1">
                  {customerMatches.map(({ customer }) => {
                    const summary = summarizeCustomerActivity(customer, { bookings, queue, piecesCount: customerPieceCounts[customer.id] });
                    return (
                      <button
                        key={customer.id}
                        type="button"
                        onClick={() => handleSelectExistingCustomer(customer)}
                        className="w-full text-left p-2 rounded-lg bg-white hover:bg-brand-sand/40 border border-brand-clay/40 cursor-pointer"
                      >
                        <p className="text-xs font-bold text-brand-charcoal">{customer.name}</p>
                        <p className="text-[11px] font-mono text-brand-charcoal/60">
                          {customer.displayPhone || customer.phone}
                        </p>
                        <p className="text-[10px] font-semibold text-brand-charcoal/50">
                          {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${summary.visits} previous visit${summary.visits === 1 ? '' : 's'}`, `${summary.visits} زيارات سابقة`)} ·{' '}
                          {hasWebsiteAccount(customer) ? t('Registered account', 'حساب مسجّل') : t('Walk-in / guest', 'زيارة مباشرة / ضيف')}
                        </p>
                      </button>
                    );
                  })}
                  </div>
                </div>
              )}

              {/* Guest Count Numeric Stepper (Tablet friendly) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                  <div className="text-left">
                    <p className="text-xs font-bold text-brand-charcoal/80">{t('Number of Guests', 'عدد الضيوف')}</p>
                    <p className="text-[10px] text-brand-charcoal/40 font-bold">{t('Minimum 1 guest', 'الحد الأدنى ضيف واحد')}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setNewGuests(prev => Math.max(1, prev - 1))}
                      className="h-10 w-10 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal text-base cursor-pointer focus:outline-none"
                    >
                      -
                    </button>
                    <span className="text-sm font-bold text-brand-charcoal w-6 text-center">{newGuests}</span>
                    <button
                      type="button"
                      onClick={() => setNewGuests(prev => prev + 1)}
                      className="h-10 w-10 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal text-base cursor-pointer focus:outline-none"
                    >
                      +
                    </button>
                  </div>
                </div>
                {walkInType === 'Without Instructor' && errors.guests && (
                  <p className="text-[11px] text-red-500 font-bold">{errors.guests}</p>
                )}
              </div>

              {/* OPTION A: WITHOUT INSTRUCTOR SPECIFIC FIELDS */}
              {walkInType === 'Without Instructor' && (
                <div className="space-y-1 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                    <div className="text-left">
                      <p className="text-xs font-bold text-brand-charcoal/80">{t('Number of Hours', 'عدد الساعات')}</p>
                      <p className="text-[10px] text-brand-charcoal/40 font-bold">{t('Time limit for clay play', 'الحد الزمني للعب بالطين')}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setNewHours(prev => Math.max(1, prev - 1))}
                        className="h-10 w-10 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal text-base cursor-pointer focus:outline-none"
                      >
                        -
                      </button>
                      <span className="text-sm font-bold text-brand-charcoal w-6 text-center">{newHours}</span>
                      <button
                        type="button"
                        onClick={() => setNewHours(prev => prev + 1)}
                        className="h-10 w-10 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal text-base cursor-pointer focus:outline-none"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {errors.hours && <p className="text-[11px] text-red-500 font-bold">{errors.hours}</p>}
                </div>
              )}

              {/* Table assignment at check-in is entirely optional — Waiting
                  needs no table. Left unassigned, staff pick one later when
                  they click Seat. Same bordered-card treatment as the Guests
                  and Hours fields above, so the form reads as one consistent
                  list of sections rather than a mix of styles. */}
              {walkInType === 'Without Instructor' && (
                <div className="space-y-1.5 border border-brand-clay bg-white rounded-xl p-3 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-brand-charcoal/80">{t('Table Assignment (optional)', 'تعيين الطاولة (اختياري)')}</p>
                    {newTableIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setNewTableIds([])}
                        className="text-[11px] font-bold text-brand-terracotta hover:underline cursor-pointer"
                      >
                        {t('Leave unassigned', 'ترك دون تعيين')}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-brand-charcoal/40 font-bold">
                    {t("Choose now if you already know where they'll sit, or leave this and pick a table when you seat them.", 'اختر الآن إن كنت تعرف أين سيجلسون، أو اترك ذلك واختر طاولة عند إجلاسهم.')}
                  </p>
                  <TableMultiPicker
                    tables={tableStates}
                    selectedIds={newTableIds}
                    participants={newGuests}
                    onChange={ids => {
                      setNewTableIds(ids);
                      if (errors.tables) setErrors(prev => ({ ...prev, tables: '' }));
                    }}
                  />
                  {errors.tables && <p className="text-[11px] text-red-500 font-bold">{errors.tables}</p>}
                </div>
              )}

              {/* OPTION B: WITH INSTRUCTOR — pick one of today's real sessions */}
              {walkInType === 'With Instructor' && (
                <div className="space-y-1 animate-in fade-in duration-200">
                  <label className="text-xs font-bold text-brand-charcoal/80">
                    {t("Today's Workshop Session", 'جلسة ورشة اليوم')} <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={newSessionId}
                    onChange={e => {
                      setNewSessionId(e.target.value);
                      if (errors.session) setErrors(prev => ({ ...prev, session: '' }));
                    }}
                    disabled={availableSessions.length === 0}
                    className={`w-full bg-white border rounded-xl py-3 px-3.5 text-xs font-bold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none disabled:opacity-60 ${
                      errors.session ? 'border-red-500 bg-red-50/20' : 'border-brand-clay'
                    }`}
                  >
                    <option value="">
                      {availableSessions.length === 0
                        ? t('No available sessions left today', 'لا توجد جلسات متاحة متبقية اليوم')
                        : t('Select a session...', 'اختر جلسة...')}
                    </option>
                    {availableSessions.map(s => (
                      <option key={s.sessionId} value={s.sessionId}>{s.label}</option>
                    ))}
                  </select>
                  {errors.session && <p className="text-[11px] text-red-500 font-bold">{errors.session}</p>}

                  {selectedSession && (
                    <div className="mt-2 bg-brand-sand/20 border border-brand-clay/40 rounded-xl p-2.5 text-[11px] font-bold text-brand-charcoal/80 space-y-1">
                      <div className="flex justify-between"><span>{t('Workshop:', 'الورشة:')}</span><span>{selectedSession.workshopTitle}</span></div>
                      <div className="flex justify-between">
                        <span>{t('Time:', 'الوقت:')}</span>
                        <span className="font-mono">{selectedSession.startTime} – {selectedSession.endTime}</span>
                      </div>
                      <div className="flex justify-between"><span>{t('Instructor:', 'المدرّب:')}</span><span>{selectedSession.instructorName}</span></div>
                      <div className="flex justify-between">
                        <span>{t('Seats Left:', 'المقاعد المتبقية:')}</span>
                        <span>{t(`${selectedSession.remainingCapacity} of ${selectedSession.capacity}`, `${selectedSession.remainingCapacity} من ${selectedSession.capacity}`)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* The derived summary (duration, estimated end, seats/tables, wait) is
                  intentionally not shown here. computeQueueSessionPlan still runs for
                  queue timing, capacity, auto-completion, wait estimates and seat and
                  table allocation — only the box was removed. Hours/guests errors now
                  sit directly under their own field, above. */}

            </div>
            </div>

            {/* Footer — a shrink-0 sibling of the scroll area, so Cancel and
                Add to Queue never need scrolling to reach. */}
            <div className="shrink-0 grid grid-cols-2 gap-3 border-t border-brand-clay/60 px-6 py-4">
              <button
                type="button"
                onClick={() => setAddModalOpen(false)}
                className="cursor-pointer py-3.5 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl text-center"
              >
                {t('Cancel', 'إلغاء')}
              </button>
              <button
                type="submit"
                className="cursor-pointer py-3.5 bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream text-xs font-bold rounded-xl text-center shadow-md"
              >
                {t('Add to Queue', 'إضافة إلى الطابور')}
              </button>
            </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* =================== EDIT GUEST DIALOG ==================== */}
      {/* ========================================================== */}
      {editModalOpen && editingItem && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          {/* Same viewport-safe shape as Add Walk-In: header and footer are
              shrink-0 siblings of the scroll area, never part of it, so the
              Save button can never end up below the fold. */}
          <div className="bg-brand-cream border border-brand-clay rounded-3xl shadow-2xl max-w-sm w-full max-h-[90vh] flex flex-col overflow-hidden text-left animate-in zoom-in-95 duration-200">

            <div className="shrink-0 flex justify-between items-center border-b border-brand-clay/60 px-6 py-4">
              <h3 className="font-display text-sm font-bold text-brand-charcoal">
                {t(`Edit Queue Entry ${editingItem.id}`, `تعديل إدخال الطابور ${editingItem.id}`)}
              </h3>
              <button onClick={() => setEditModalOpen(false)} className="text-brand-charcoal hover:bg-brand-sand p-1 rounded-lg">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto always-scrollbar px-6 py-4 space-y-4">

              {/* Stepper for Guests */}
              <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                <span className="text-xs font-bold text-brand-charcoal/80">{t('Guests Count', 'عدد الضيوف')}</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setEditGuests(prev => Math.max(1, prev - 1))}
                    className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={editGuests}
                    onChange={e => {
                      setEditGuests(Number(e.target.value));
                      if (editErrors.guests) setEditErrors(prev => ({ ...prev, guests: '' }));
                    }}
                    className="text-sm font-bold text-brand-charcoal w-14 text-center bg-brand-cream/50 border border-brand-clay rounded-lg py-1"
                  />
                  <button
                    onClick={() => setEditGuests(prev => prev + 1)}
                    className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal"
                  >
                    +
                  </button>
                </div>
              </div>
              {editErrors.guests && <p className="text-[11px] text-red-500 font-bold">{editErrors.guests}</p>}

              {/* Hours — self-guided entries only */}
              {isSelfGuided(editingItem) && (
                <>
                  <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                    <span className="text-xs font-bold text-brand-charcoal/80">{t('Number of Hours', 'عدد الساعات')}</span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setEditHours(prev => Math.max(1, prev - 1))}
                        className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min={1}
                        step="0.5"
                        value={editHours}
                        onChange={e => {
                          setEditHours(Number(e.target.value));
                          if (editErrors.hours) setEditErrors(prev => ({ ...prev, hours: '' }));
                        }}
                        className="text-sm font-bold text-brand-charcoal w-14 text-center bg-brand-cream/50 border border-brand-clay rounded-lg py-1"
                      />
                      <button
                        onClick={() => setEditHours(prev => prev + 1)}
                        className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {editErrors.hours && <p className="text-[11px] text-red-500 font-bold">{editErrors.hours}</p>}

                  {/* The derived summary box is intentionally not shown here.
                      computeQueueSessionPlan still runs where the figures are used —
                      queue timing, capacity, auto-completion, wait estimates and
                      seat/table allocation — and the saved hours/guests are unchanged. */}
                </>
              )}

              {/* Instructor-led entries: reassign the tutor and see live capacity */}
              {!isSelfGuided(editingItem) && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Assigned Instructor', 'المدرّب المعيّن')}</label>
                    {/* Only staff who are free for this session's date and time. */}
                    <select
                      value={editStaffId}
                      onChange={e => {
                        setEditStaffId(e.target.value);
                        if (editErrors.instructor) setEditErrors(prev => ({ ...prev, instructor: '' }));
                      }}
                      className="w-full bg-white border border-brand-clay rounded-xl py-2.5 px-3.5 text-xs font-bold text-brand-charcoal cursor-pointer"
                    >
                      <option value="">{t('Select instructor...', 'اختر المدرّب...')}</option>
                      {availableInstructors.map(({ member, avail }) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                          {member.id === editingItem.staffId && !avail.isAvailable ? t(' (currently assigned)', ' (معيّن حاليًا)') : ''}
                        </option>
                      ))}
                    </select>
                    {availableInstructors.length === 0 && (
                      <p className="text-[11px] font-bold text-amber-700">
                        {t("No staff are free for this session's time.", 'لا يوجد موظفون متاحون في وقت هذه الجلسة.')}
                      </p>
                    )}
                    {editErrors.instructor && (
                      <p className="text-[11px] text-red-500 font-bold">{editErrors.instructor}</p>
                    )}
                  </div>

                  {/* The session/capacity summary box is intentionally not shown.
                      editingCapacity is still computed and still enforces the guest
                      limit on save, and the session and booking links are unchanged. */}
                </>
              )}

            </div>

            {/* Footer — a shrink-0 sibling of the scroll area, so Cancel and
                Save Changes never need scrolling to reach. */}
            <div className="shrink-0 grid grid-cols-2 gap-3 border-t border-brand-clay/60 px-6 py-4">
              <button
                onClick={() => setEditModalOpen(false)}
                className="cursor-pointer py-3 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl text-center"
              >
                {t('Cancel', 'إلغاء')}
              </button>
              <button
                onClick={handleSaveEdit}
                className="cursor-pointer py-3 bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream text-xs font-bold rounded-xl text-center shadow-md"
              >
                {t('Save Changes', 'حفظ التغييرات')}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* =========================== ADD TIME ====================== */}
      {/* ========================================================== */}
      {returnModalOpen && returningItem && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          {/* Same viewport-safe shape as Add Walk-In: header and footer are
              shrink-0 siblings of the scroll area, never part of it. */}
          <div className="bg-brand-cream border border-brand-clay rounded-3xl shadow-2xl max-w-sm w-full max-h-[90vh] flex flex-col overflow-hidden text-left animate-in zoom-in-95 duration-200">

            {/* Header */}
            <div className="shrink-0 flex justify-between items-center border-b border-brand-clay/60 px-6 py-4">
              <div className="min-w-0">
                <h3 className="font-display text-sm font-bold text-brand-charcoal">{t('Add Time', 'إضافة وقت')}</h3>
                <p className="text-[11px] font-bold text-brand-charcoal/50 truncate">
                  {t(`${returningItem.name} · completed entry No. ${formatQueueNumber(returningItem.queueNumber)}`, `${returningItem.name} · إدخال مكتمل رقم ${formatQueueNumber(returningItem.queueNumber)}`)}
                </p>
              </div>
              <button
                onClick={() => setReturnModalOpen(false)}
                className="shrink-0 p-1.5 rounded-lg text-brand-charcoal hover:bg-brand-sand border border-transparent hover:border-brand-clay/40 cursor-pointer focus:outline-none"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Scrollable middle */}
            <div className="flex-1 overflow-y-auto always-scrollbar px-6 py-4 space-y-4">

              <p className="text-[11px] font-semibold text-brand-charcoal/60 bg-white border border-brand-clay/50 rounded-xl p-2.5">
                {t('Goes straight back to In Progress with a fresh timer — this guest does not return to the Waiting List.', 'يعود مباشرة إلى «جارية الآن» بمؤقت جديد — لا يعود هذا الضيف إلى قائمة الانتظار.')}
              </p>

              <div className="space-y-1">
                <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                  <span className="text-xs font-bold text-brand-charcoal/80">{t('Additional Hours', 'ساعات إضافية')}</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setReturnHours(prev => Math.max(1, prev - 1))}
                      className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal cursor-pointer"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      step="0.5"
                      value={returnHours}
                      onChange={e => {
                        setReturnHours(Number(e.target.value));
                        if (returnErrors.hours) setReturnErrors(prev => ({ ...prev, hours: '' }));
                      }}
                      className="text-sm font-bold text-brand-charcoal w-14 text-center bg-brand-cream/50 border border-brand-clay rounded-lg py-1"
                    />
                    <button
                      type="button"
                      onClick={() => setReturnHours(prev => prev + 1)}
                      className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
                {returnErrors.hours && <p className="text-[11px] text-red-500 font-bold">{returnErrors.hours}</p>}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between border border-brand-clay bg-white rounded-xl p-3">
                  <span className="text-xs font-bold text-brand-charcoal/80">{t('Guests', 'الضيوف')}</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setReturnGuests(prev => Math.max(1, prev - 1))}
                      className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal cursor-pointer"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      value={returnGuests}
                      onChange={e => {
                        setReturnGuests(Number(e.target.value));
                        if (returnErrors.guests) setReturnErrors(prev => ({ ...prev, guests: '' }));
                      }}
                      className="text-sm font-bold text-brand-charcoal w-14 text-center bg-brand-cream/50 border border-brand-clay rounded-lg py-1"
                    />
                    <button
                      type="button"
                      onClick={() => setReturnGuests(prev => prev + 1)}
                      className="h-8 w-8 rounded-lg bg-brand-sand hover:bg-brand-clay flex items-center justify-center font-bold text-brand-charcoal cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                </div>
                {returnErrors.guests && <p className="text-[11px] text-red-500 font-bold">{returnErrors.guests}</p>}
              </div>

              {/* Table Assignment — the same compact popover picker as Add
                  Walk-In, pre-selected with whatever table(s) this guest had. */}
              <div className="space-y-1.5">
                <p className="text-xs font-bold text-brand-charcoal/80">{t('Table Assignment', 'تعيين الطاولة')}</p>
                <p className="text-[10px] text-brand-charcoal/40 font-bold">
                  {returningItem.tableIds && returningItem.tableIds.length > 0
                    ? t('Kept below by default — remove or change if needed.', 'محفوظة أدناه افتراضيًا — أزلها أو غيّرها عند الحاجة.')
                    : t('No table was assigned before. Choose one or more.', 'لم تُعيَّن طاولة سابقًا. اختر واحدة أو أكثر.')}
                </p>
                <TableMultiPicker
                  tables={returnTableStates}
                  selectedIds={returnTableIds}
                  participants={Number(returnGuests) || 0}
                  placeholder={t('Choose table(s)', 'اختر الطاولة/الطاولات')}
                  onChange={ids => {
                    setReturnTableIds(ids);
                    if (returnErrors.form) setReturnErrors(prev => ({ ...prev, form: '' }));
                  }}
                />
              </div>

              {(() => {
                const preview = computeQueueSessionPlan({
                  hours: returnHours,
                  guests: returnGuests,
                  startTime: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
                  capacity: capacitySnapshot,
                  aheadInQueue: waitingItems
                });
                return (
                  <div className="bg-brand-sand/20 border border-brand-clay/40 rounded-xl p-3 text-[11px] font-bold text-brand-charcoal/80 space-y-1">
                    <div className="flex justify-between"><span>{t('New Session Duration:', 'مدة الجلسة الجديدة:')}</span><span>{preview.durationLabel}</span></div>
                    <div className="flex justify-between"><span>{t('Est. End Time:', 'وقت الانتهاء المتوقع:')}</span><span className="font-mono">{preview.estimatedEndTime}</span></div>
                    <div className="flex justify-between">
                      <span>{t('Table(s):', 'الطاولة/الطاولات:')}</span>
                      <span>{returnTableIds.length > 0 ? tableNamesFor(returnTableIds, configuredTables) : t(`${preview.seatsRequired} seats needed`, `مطلوب ${preview.seatsRequired} مقاعد`)}</span>
                    </div>
                  </div>
                );
              })()}

              {returnErrors.form && (
                <p className="text-[11px] text-red-600 font-bold bg-red-50 border border-red-200 rounded-xl p-2.5">
                  {returnErrors.form}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 grid grid-cols-2 gap-3 border-t border-brand-clay/60 px-6 py-4">
              <button
                type="button"
                onClick={() => setReturnModalOpen(false)}
                className="cursor-pointer py-3 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl text-center"
              >
                {t('Cancel', 'إلغاء')}
              </button>
              <button
                type="button"
                onClick={handleConfirmReturn}
                className="cursor-pointer py-3 bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream text-xs font-bold rounded-xl text-center shadow-md"
              >
                {t('Confirm Add Time', 'تأكيد إضافة الوقت')}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* ================= CANCEL CONFIRMATION ==================== */}
      {/* ========================================================== */}
      {cancelConfirmOpen && cancellingItem && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-brand-clay rounded-3xl p-6 shadow-2xl max-w-sm w-full text-center space-y-4 animate-in zoom-in-95 duration-150">
            
            <div className="mx-auto h-12 w-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 animate-bounce" />
            </div>

            <div className="space-y-2">
              <h3 className="font-display text-base font-bold text-brand-charcoal">
                {t('Confirm Cancel Queue Entry?', 'تأكيد إلغاء إدخال الطابور؟')}
              </h3>
              <p className="text-xs text-brand-charcoal/60 leading-relaxed">
                {t('Are you sure you want to cancel the queue entry for', 'هل أنت متأكد أنك تريد إلغاء إدخال الطابور الخاص بـ')} <span className="font-bold text-brand-charcoal">{cancellingItem.name}</span> ({t('No.', 'رقم')} {formatQueueNumber(cancellingItem.queueNumber)}){t('? This action cannot be undone.', '؟ لا يمكن التراجع عن هذا الإجراء.')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={() => setCancelConfirmOpen(false)}
                className="cursor-pointer py-3 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl"
              >
                {t('Keep Entry', 'إبقاء الإدخال')}
              </button>
              <button
                onClick={handleConfirmCancel}
                className="cursor-pointer py-3 bg-red-600 hover:bg-red-700 text-brand-cream text-xs font-bold rounded-xl shadow-md"
              >
                {t('Yes, Cancel Entry', 'نعم، إلغاء الإدخال')}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* ============= SEAT / CHANGE TABLE (one modal) ============= */}
      {/* ========================================================== */}
      {seatModalOpen && seatModalItem && (
        <div className="fixed inset-0 bg-brand-charcoal/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          {/* Same viewport-safe shape as Add Walk-In: header and footer are
              shrink-0 siblings of the scroll area, never part of it, so a
              studio with many tables never pushes Seat Guest below the fold. */}
          <div className="bg-brand-cream border border-brand-clay rounded-3xl shadow-2xl max-w-sm w-full max-h-[90vh] flex flex-col overflow-hidden text-left animate-in zoom-in-95 duration-200">

            <div className="shrink-0 flex justify-between items-center border-b border-brand-clay/60 px-6 py-4">
              <div>
                <h3 className="font-display text-sm font-bold text-brand-charcoal">
                  {seatModalMode === 'seat' ? t('Seat Guest — Choose Table(s)', 'إجلاس الضيف — اختر الطاولة/الطاولات') : t('Change Table', 'تغيير الطاولة')}
                </h3>
                <p className="text-[11px] font-bold text-brand-charcoal/50">
                  {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}{t(`${seatModalItem.name} · No. ${formatQueueNumber(seatModalItem.queueNumber)} · ${seatModalItem.participants} guests`, `${seatModalItem.name} · رقم ${formatQueueNumber(seatModalItem.queueNumber)} · ${seatModalItem.participants} ضيوف`)}
                </p>
              </div>
              <button
                onClick={() => setSeatModalOpen(false)}
                className="text-brand-charcoal hover:bg-brand-sand p-1 rounded-lg cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto always-scrollbar px-6 py-4 space-y-5">

            {seatModalMode === 'seat' && (
              <p className="text-[11px] font-semibold text-brand-charcoal/60 bg-white border border-brand-clay/50 rounded-xl p-2.5">
                {t('A table is required before this guest can move to In Progress. A large group may use more than one table.', 'يلزم اختيار طاولة قبل انتقال هذا الضيف إلى «جارية الآن». قد تستخدم المجموعة الكبيرة أكثر من طاولة.')}
              </p>
            )}

            <TableSelector
              tables={seatModalTableStates}
              selectedIds={seatModalTableIds}
              participants={seatModalItem.participants}
              onToggle={id => {
                setSeatModalTableIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
                if (seatModalError) setSeatModalError(null);
              }}
            />

            {seatModalError && (
              <p className="text-[11px] text-red-600 font-bold bg-red-50 border border-red-200 rounded-xl p-2.5">
                {seatModalError}
              </p>
            )}

            </div>

            {/* Footer — a shrink-0 sibling of the scroll area, so Cancel and
                Seat Guest/Save Table never need scrolling to reach. */}
            <div className="shrink-0 grid grid-cols-2 gap-3 border-t border-brand-clay/60 px-6 py-4">
              <button
                onClick={() => setSeatModalOpen(false)}
                className="cursor-pointer py-3 border border-brand-clay hover:bg-brand-sand text-brand-charcoal text-xs font-bold rounded-xl text-center"
              >
                {t('Cancel', 'إلغاء')}
              </button>
              <button
                onClick={handleConfirmSeatModal}
                className="cursor-pointer py-3 bg-brand-terracotta hover:bg-brand-terracotta-hover text-brand-cream text-xs font-bold rounded-xl text-center shadow-md"
              >
                {seatModalMode === 'seat' ? t('Seat Guest', 'إجلاس الضيف') : t('Save Table', 'حفظ الطاولة')}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* ===================== SEATING MANAGER ====================== */}
      {/* ========================================================== */}
      {seatingManagerOpen && (
        <SeatingManagerModal
          tables={tableStates}
          queue={todayQueue}
          onClose={() => setSeatingManagerOpen(false)}
          onSeatWaiting={item => { setSeatingManagerOpen(false); handleOpenSeatModal(item, 'seat'); }}
          onChangeTable={item => { setSeatingManagerOpen(false); handleOpenSeatModal(item, 'change'); }}
          onRelease={async (item) => { await assignQueueTables(item.id, []); }}
          onAssign={async (item, tableId) => { await assignQueueTables(item.id, [tableId]); }}
        />
      )}

    </div>
  );
};
