/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The only date picker used in the app — a self-contained English Gregorian
 * calendar.
 *
 * A native `<input type="date">` renders its picker from the browser/OS locale.
 * Safari in particular ignores the element's `lang` and follows the macOS system
 * calendar, so on a device set to Umm al-Qura the picker opens in Hijri while the
 * stored value stays ISO Gregorian. This component draws its own month grid, so
 * the calendar is Gregorian on every browser and OS.
 *
 * The public contract is unchanged: the value is an ISO `YYYY-MM-DD` string and
 * `onChange` receives `{ target: { value } }`, so every call site and every
 * date-based business rule keeps working exactly as before.
 */

import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { MONTH_NAMES, MONTH_NAMES_AR, MONTH_NAMES_SHORT, WEEKDAY_NAMES_SHORT, WEEKDAY_LETTERS_AR, CALENDAR_INPUT_PROPS } from '../utils/calendarConfig';

export interface DateInputProps {
  /** ISO date, `YYYY-MM-DD`. */
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  /** Earliest selectable ISO date. */
  min?: string;
  /** Latest selectable ISO date. */
  max?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  title?: string;
}

/** Parses `YYYY-MM-DD` into its parts. Returns null for empty or malformed input. */
function parseISO(value?: string): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function toISO(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "04 Aug 2026", or "04 أغسطس 2026" in Arabic — always Gregorian, display only. */
function formatDisplay(value: string | undefined, lang: string): string {
  const parsed = parseISO(value);
  if (!parsed) return '';
  const month = lang === 'ar' ? MONTH_NAMES_AR[parsed.month - 1] : MONTH_NAMES_SHORT[parsed.month - 1];
  return `${String(parsed.day).padStart(2, '0')} ${month} ${parsed.year}`;
}

export const DateInput: React.FC<DateInputProps> = ({
  value = '',
  onChange,
  min,
  max,
  required = false,
  disabled = false,
  className = '',
  id,
  name,
  placeholder: placeholderProp,
  title
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const { lang, t } = useLanguage();
  const placeholder = placeholderProp ?? t('Select date', 'اختر التاريخ');
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Where the calendar is drawn.
   *
   * It used to be an absolutely positioned child of the field, which meant any
   * ancestor with `overflow: hidden` clipped it — on the Bookings ledger both
   * the page and the table card do, so the popup was cut off. It is portalled
   * to the body and positioned from the field's own rect instead, so nothing
   * upstream can clip it and it cannot be trapped by a transformed ancestor.
   */
  const POPUP_WIDTH = 264;
  // Raised from 360 when the day cells went to 44px: a six-row month landed at
  // ~362 and the calendar began to scroll by a hair, which is worse than the
  // small tap targets it was fixing. 420 still fits a 375x667 screen within the
  // 8px margins below.
  const POPUP_MAX_HEIGHT = 420;
  const VIEWPORT_MARGIN = 8;
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const popupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const place = () => {
      const field = containerRef.current?.getBoundingClientRect();
      if (!field) return;

      const spaceBelow = window.innerHeight - field.bottom;
      // Flip above only when below genuinely cannot hold it and above can.
      const openUpwards = spaceBelow < POPUP_MAX_HEIGHT + VIEWPORT_MARGIN && field.top > spaceBelow;

      // Aligned to the field's leading edge, then pulled back inside the
      // window if that would push it off the right.
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, field.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN)
      );

      setPopupStyle({
        position: 'fixed',
        left,
        width: POPUP_WIDTH,
        maxHeight: openUpwards
          ? Math.max(160, field.top - VIEWPORT_MARGIN * 2)
          : Math.max(160, spaceBelow - VIEWPORT_MARGIN * 2),
        ...(openUpwards
          ? { bottom: window.innerHeight - field.top + 4 }
          : { top: field.bottom + 4 })
      });
    };

    place();
    // Anything that moves the field moves the calendar with it.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);

  const selected = parseISO(value);

  // Month currently shown in the grid.
  const [viewYear, setViewYear] = useState(() => selected?.year ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (selected?.month ?? new Date().getMonth() + 1));

  // Follow the selected value when it changes from outside.
  useEffect(() => {
    if (selected) {
      setViewYear(selected.year);
      setViewMonth(selected.month);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click or Escape.
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      // The calendar is portalled to the body, so it is not inside the field's
      // container any more — without this second check, clicking a day would
      // register as a click outside and close the popup before it selected.
      const insideField = containerRef.current?.contains(target);
      const insidePopup = popupRef.current?.contains(target);
      if (!insideField && !insidePopup) setIsOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const grid = useMemo(() => {
    // Gregorian month maths, independent of any locale calendar.
    const firstDayOfWeek = new Date(viewYear, viewMonth - 1, 1).getDay(); // 0 = Sunday
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

    const cells: Array<{ day: number; iso: string } | null> = [];
    for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ day, iso: toISO(viewYear, viewMonth, day) });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const todayISO = useMemo(() => {
    const now = new Date();
    return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }, []);

  const isOutOfRange = (iso: string) => {
    if (min && iso < min) return true;
    if (max && iso > max) return true;
    return false;
  };

  const commit = (iso: string) => {
    onChange?.({ target: { value: iso } });
    setIsOpen(false);
  };

  const stepMonth = (delta: number) => {
    let month = viewMonth + delta;
    let year = viewYear;
    while (month < 1) { month += 12; year -= 1; }
    while (month > 12) { month -= 12; year += 1; }
    setViewMonth(month);
    setViewYear(year);
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Read-only display field. Keeps `required` form validation working while
          never opening the OS calendar widget. */}
      <input
        {...CALENDAR_INPUT_PROPS}
        type="text"
        id={id}
        name={name}
        readOnly
        required={required}
        disabled={disabled}
        title={title}
        placeholder={placeholder}
        value={formatDisplay(value, lang)}
        onClick={() => !disabled && setIsOpen(open => !open)}
        onKeyDown={event => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsOpen(open => !open);
          }
        }}
        className={`${className} cursor-pointer`}
        autoComplete="off"
      />

      {isOpen && !disabled && createPortal(
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-[120] overflow-y-auto always-scrollbar rounded-2xl border border-brand-clay bg-white p-3 text-start shadow-xl animate-in fade-in duration-100"
        >

          {/* Month / year navigation */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => stepMonth(-1)}
              className="relative p-1.5 rounded-lg hover:bg-brand-sand text-brand-charcoal/70 cursor-pointer before:absolute before:-inset-2 before:content-['']"
              title={t('Previous month', 'الشهر السابق')}
            >
              <ChevronLeft className="h-4 w-4 flip-rtl" />
            </button>

            <div className="flex items-center gap-1.5">
              <select
                value={viewMonth}
                onChange={e => setViewMonth(Number(e.target.value))}
                className="h-11 bg-brand-cream/50 border border-brand-clay rounded-lg px-1.5 text-[11px] font-bold text-brand-charcoal cursor-pointer"
              >
                {(lang === 'ar' ? MONTH_NAMES_AR : MONTH_NAMES).map((label, idx) => (
                  <option key={label} value={idx + 1}>{label}</option>
                ))}
              </select>
              <input
                type="number"
                value={viewYear}
                onChange={e => setViewYear(Number(e.target.value) || viewYear)}
                className="h-11 w-[62px] bg-brand-cream/50 border border-brand-clay rounded-lg px-1.5 text-[11px] font-bold text-brand-charcoal font-mono"
              />
            </div>

            <button
              type="button"
              onClick={() => stepMonth(1)}
              className="relative p-1.5 rounded-lg hover:bg-brand-sand text-brand-charcoal/70 cursor-pointer before:absolute before:-inset-2 before:content-['']"
              title={t('Next month', 'الشهر التالي')}
            >
              <ChevronRight className="h-4 w-4 flip-rtl" />
            </button>
          </div>

          {/* Weekday headers (single letters, Arabic in Arabic) */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAY_NAMES_SHORT.map((day, i) => (
              <div key={day} className="text-center text-[9px] font-bold uppercase text-brand-charcoal/45 py-1">
                {lang === 'ar' ? WEEKDAY_LETTERS_AR[i] : day.charAt(0)}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((cell, idx) => {
              if (!cell) return <div key={`pad-${idx}`} />;

              const isSelected = cell.iso === value;
              const isToday = cell.iso === todayISO;
              const disabledDay = isOutOfRange(cell.iso);

              return (
                <button
                  key={cell.iso}
                  type="button"
                  disabled={disabledDay}
                  onClick={() => commit(cell.iso)}
                  // h-11 is the 44px touch minimum. The WIDTH cannot reach it —
                  // seven columns in a 264px popup leave ~33px — so the height
                  // is taken as far as it goes.
                  className={`h-11 rounded-lg text-[11px] font-bold transition-colors ${
                    disabledDay
                      ? 'text-brand-charcoal/25 cursor-not-allowed'
                      : isSelected
                        ? 'bg-brand-terracotta text-brand-cream cursor-pointer'
                        : isToday
                          ? 'bg-brand-sand text-brand-terracotta cursor-pointer hover:bg-brand-clay/50'
                          : 'text-brand-charcoal hover:bg-brand-sand/60 cursor-pointer'
                  }`}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between pt-2 mt-2 border-t border-brand-clay/50">
            <button
              type="button"
              onClick={() => !isOutOfRange(todayISO) && commit(todayISO)}
              disabled={isOutOfRange(todayISO)}
              className="text-[10px] font-bold text-brand-terracotta hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed cursor-pointer"
            >
              {t('Today', 'اليوم')}
            </button>

            <div className="flex items-center gap-2">
              {!required && value && (
                <button
                  type="button"
                  onClick={() => commit('')}
                  className="text-[10px] font-bold text-brand-charcoal/50 hover:text-red-600 flex items-center gap-0.5 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                  <span>{t('Clear', 'مسح')}</span>
                </button>
              )}
              <span className="text-[9px] font-bold text-brand-charcoal/35 flex items-center gap-1">
                <CalendarIcon className="h-3 w-3" />
                <span>{t('Gregorian', 'ميلادي')}</span>
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

/**
 * Time picker. Native `<input type="time">` has no calendar, so it stays native
 * but is still pinned to the English locale for its AM/PM rendering.
 */
export const TimeInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = '', ...props }) => (
  <input {...CALENDAR_INPUT_PROPS} {...props} type="time" className={className} />
);

/** Month picker built on the same Gregorian calendar; value is `YYYY-MM`. */
export const MonthInput: React.FC<DateInputProps> = ({ value = '', onChange, ...rest }) => (
  <DateInput
    {...rest}
    value={value ? `${value}-01` : ''}
    onChange={event => onChange?.({ target: { value: event.target.value.slice(0, 7) } })}
  />
);
