/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import {
  ArrowLeft, Cake, Upload, Check, ChevronDown,
  ShieldAlert, CalendarDays, Clock, PartyPopper
, Info } from 'lucide-react';
import { getMinBirthdayBookingDateStr } from '../utils/dateUtils';
import { PhoneInput } from './PhoneInput';
import {
  BirthdayFormField, BirthdayTermsConfig, DEFAULT_BIRTHDAY_TERMS, renderTermsLine
} from '../types';
import { DateInput } from './DateInput';
import { validatePhoneRule, canonicalPhone } from '../utils/validation';
import { minBirthdayNoticeDays, BIRTHDAY_DAILY_MAX, BIRTHDAY_SAME_SLOT_MAX, DEFAULT_DEPOSIT_AMOUNT } from '../utils/queueUtils';
import { ONLINE_PAYMENTS_AVAILABLE } from '../utils/featureFlags';
import { ONLINE_PAYMENTS_SETTING_ID, normalizeOnlinePayments, estimateOnlineAmount, birthdayFullPrice } from '../utils/onlinePayments';
import { useBirthdayCounts } from '../lib/sessionSeats';
import { BackButton } from './ui/BackButton';
import { localizedText } from '../utils/localizedText';
import { enumLabel } from '../utils/enumLabels';
import { dayLabel, timeLabel } from '../utils/availabilityLabel';

const FALLBACK_TIMES = ['10:00 AM', '01:00 PM', '04:00 PM', '07:00 PM'];

/**
 * Which step each configured field belongs to.
 *
 * Anything the studio adds in Settings that is not one of these lands in
 * Extras, which is where an unknown question makes the most sense: the party
 * details step is the fixed set the booking record itself is built from.
 */
const DETAIL_KEYS = [
  'bookingName', 'phone', 'numberOfPeople', 'bookingDate', 'bookingTime',
  'birthdayPersonName', 'birthdayPersonAge'
];

const STEPS = [
  { n: 1, label: 'Package', labelAr: 'الباقة' },
  { n: 2, label: 'Party Details', labelAr: 'تفاصيل الحفلة' },
  { n: 3, label: 'Extras', labelAr: 'الإضافات' },
  { n: 4, label: 'Review & Deposit', labelAr: 'المراجعة والعربون' }
];

/**
 * Arabic wording for the labels the studio ships with. Labels are staff-editable
 * (Settings → Events & Birthdays) and stored English-only, so a translation is
 * used only while the stored label still IS one of these defaults. Rename it in
 * Settings and the staff wording is shown as typed, never a stale translation of
 * the old text. Display only: never stored, never compared for logic.
 */
const DEFAULT_LABEL_AR: Record<string, { en: string[]; ar: string }> = {
  bookingName:        { en: ['Booking Name'], ar: 'اسم الحجز' },
  phone:              { en: ['Phone Number'], ar: 'رقم الجوال' },
  numberOfPeople:     { en: ['Number of People'], ar: 'عدد الأشخاص' },
  bookingDate:        { en: ['Date / Day'], ar: 'التاريخ / اليوم' },
  bookingTime:        { en: ['Time'], ar: 'الوقت' },
  birthdayPersonName: { en: ['Name of the Birthday Person'], ar: 'اسم صاحب عيد الميلاد' },
  balloonColor:       { en: ['Balloon Color 🎈', 'Pick a balloon colour 🎈'], ar: 'لون البالونات 🎈' },
  drinksChoice:       { en: ['Drinks — coffee or fresh juices of your choice', 'Choose your drinks'], ar: 'المشروبات — قهوة أو عصائر طازجة من اختيارك' },
  cakePhoto:          { en: ['Please attach a photo of the cake'], ar: 'يرجى إرفاق صورة للكعكة' }
};
const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Arabic wording for the option strings the birthday form ships with. Options are
 * staff-editable (Settings → Events & Birthdays) and stored as plain English strings, so
 * a translation is used only while an option still IS one of these defaults
 * (normalized compare); anything staff added or reworded is shown as typed.
 * DISPLAY ONLY: the option string itself is what is selected, stored, matched for the
 * "custom" text box and the colour swatch, and restored from a draft. Never the Arabic.
 */
const DEFAULT_OPTION_AR: Array<{ en: string; ar: string }> = [
  { en: 'Pink & White', ar: 'وردي وأبيض' },
  { en: 'Pastel Blue & White', ar: 'أزرق باستيل وأبيض' },
  { en: 'Gold & Cream', ar: 'ذهبي وكريمي' },
  { en: 'Rose Gold & Blush', ar: 'روز جولد وبلاش' },
  { en: 'Sage Green & Neutral', ar: 'أخضر مريمية ومحايد' },
  { en: 'Rainbow Multi-Color', ar: 'قوس قزح متعدد الألوان' },
  { en: 'Custom Mix', ar: 'مزيج مخصص' },
  { en: 'Fresh Juices (Orange, Lemonade, Watermelon)', ar: 'عصائر طازجة (برتقال، ليموناضة، بطيخ)' },
  { en: 'Specialty Coffee Bar (Latte, Cappuccino, Spanish Latte)', ar: 'ركن القهوة المختصة (لاتيه، كابتشينو، سبانيش لاتيه)' },
  { en: 'Mixed Bar (Coffee & Fresh Juices)', ar: 'ركن مشترك (قهوة وعصائر طازجة)' }
];

/** Swatches for colour-style choices, so a balloon colour reads as a colour. */
const COLOR_SWATCHES: Record<string, string> = {
  red: '#C2412D', pink: '#E39AB0', blue: '#708D9C', 'light blue': '#A8C4D4',
  green: '#7C8F80', sage: '#7C8F80', yellow: '#E3B23C', orange: '#D9813F',
  purple: '#8B7AA8', gold: '#C9A227', silver: '#BFBFBF', white: '#FAF6EF',
  black: '#2E211A', brown: '#5A4132', cream: '#FAF6EF', peach: '#E8B49A',
  'pastel mix': 'linear-gradient(135deg,#E39AB0,#A8C4D4,#E3B23C)',
  rainbow: 'linear-gradient(135deg,#C2412D,#E3B23C,#7C8F80,#708D9C,#8B7AA8)'
};

const swatchFor = (option: string): string | null => {
  const key = option.trim().toLowerCase();
  if (COLOR_SWATCHES[key]) return COLOR_SWATCHES[key];
  const hit = Object.keys(COLOR_SWATCHES).find(c => key.includes(c));
  return hit ? COLOR_SWATCHES[hit] : null;
};

export const BirthdayBookingSection: React.FC = () => {
  const {
    setCustomerTab,
    selectedBirthdayPackage,
    setSelectedBirthdayPackage,
    setPendingBooking,
    pendingBooking,
    currentUser,
    appSettings,
    publishedBirthdayPackages,
    birthdayFormFields
  } = useApp();
  const { lang, t } = useLanguage();

  const prefersReducedMotion = useReducedMotion();
  const ease = [0.22, 1, 0.36, 1] as const;

  const eventsSettings = appSettings?.find(s => s.id === 'eventsSettings')?.value;

  // Terms come from Settings → Events & Birthday, never hardcoded here.
  const terms: BirthdayTermsConfig = eventsSettings?.birthdayTerms || DEFAULT_BIRTHDAY_TERMS;
  const cancellationDays = Number(eventsSettings?.cancellationNoticeDays) || 4;

  // Arabic terms exist only when their body is non-empty. When they do AND the visitor
  // reads Arabic, the WHOLE Arabic set replaces the English one; languages never mix.
  const arLeading = terms.leadingItemsAr ?? [];
  const arSupplies = terms.suppliesAr ?? [];
  const arTrailing = terms.trailingItemsAr ?? [];
  const hasArabicTerms = arLeading.length > 0 || arSupplies.length > 0;
  const showArabicTerms = hasArabicTerms && lang === 'ar';
  const shownTerms: Pick<BirthdayTermsConfig, 'title' | 'leadingItems' | 'suppliesIntro' | 'supplies' | 'trailingItems'> =
    showArabicTerms
      ? {
          title: terms.titleAr?.trim() ?? '',
          leadingItems: arLeading,
          suppliesIntro: terms.suppliesIntroAr?.trim() ?? '',
          supplies: arSupplies,
          trailingItems: arTrailing
        }
      : terms;

  const [termsAccepted, setTermsAccepted] = useState(false);

  // Only fields enabled in Settings → Events & Birthday are shown.
  const activeFields = useMemo(
    () => birthdayFormFields.filter(f => f.enabled).sort((a, b) => a.order - b.order),
    [birthdayFormFields]
  );
  const fieldByKey = (key: string) => activeFields.find(f => f.key === key);
  const isActive = (key: string) => !!fieldByKey(key);
  /** Display text for a field label. See DEFAULT_LABEL_AR. */
  const displayLabel = (field: BirthdayFormField): string => {
    const known = DEFAULT_LABEL_AR[field.key];
    if (lang === 'ar' && known && known.en.some(en => normalizeLabel(en) === normalizeLabel(field.label))) {
      return known.ar;
    }
    return field.label;
  };
  const labelFor = (key: string, fallback: string) => {
    const field = fieldByKey(key);
    return (field && displayLabel(field)) || fallback;
  };
  const isRequired = (key: string) => !!fieldByKey(key)?.required;
  /** Display text for a dropdown option. See DEFAULT_OPTION_AR. Never used as a value. */
  const optionText = (option: string): string => {
    if (lang !== 'ar') return option;
    return DEFAULT_OPTION_AR.find(o => normalizeLabel(o.en) === normalizeLabel(option))?.ar ?? option;
  };

  const detailFields = useMemo(
    () => activeFields.filter(f => DETAIL_KEYS.includes(f.key)),
    [activeFields]
  );
  const extraFields = useMemo(
    () => activeFields.filter(f => !DETAIL_KEYS.includes(f.key) && f.key !== 'package'),
    [activeFields]
  );

  const [bookingName, setBookingName] = useState(currentUser?.name || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');

  useEffect(() => {
    if (currentUser) {
      if (currentUser.name) setBookingName(currentUser.name);
      if (currentUser.phone) setPhone(currentUser.phone);
    }
  }, [currentUser]);

  // Everything below starts empty on purpose: the ticket beside the form is a
  // live summary, and a pre-filled default would show it as booked information
  // the visitor never actually chose.
  const [numberOfPeople, setNumberOfPeople] = useState<number | ''>('');

  /**
   * Advance notice depends on the total headcount (which already includes
   * the birthday person — it is never subtracted here). Until a headcount is
   * chosen, the stricter 4-day notice is assumed so the date field is never
   * more permissive than the rule actually allows.
   */
  const minNoticeDays = minBirthdayNoticeDays(Number(numberOfPeople) || 5);
  const minBookingDate = getMinBirthdayBookingDateStr(minNoticeDays);

  // Clearing a date that a lowered headcount doesn't retroactively save is
  // deliberately NOT automatic here: collectErrors() re-checks it, so the
  // visitor sees exactly why before moving on rather than losing a valid pick
  // to a stricter default assumption.

  // The selected package is held by id and resolved from the shared record.
  const [selectedPkgId, setSelectedPkgId] = useState<string>('');
  /**
   * Whether the arriving package has already been used to advance past step 1.
   *
   * A ref, not state: this must not re-trigger the effect, and it must survive
   * the visitor going back to step 1 to change their mind — otherwise the effect
   * would push them straight forward again and step 1 would be unreachable.
   */
  const skippedPackageStep = useRef(false);

  useEffect(() => {
    if (publishedBirthdayPackages.length === 0) return;
    const match = publishedBirthdayPackages.find(
      p => p.id === selectedBirthdayPackage || p.name === selectedBirthdayPackage
    );
    // Only what the visitor picked on the packages page — never a default.
    if (!match) return;
    setSelectedPkgId(prev => prev || match.id);

    // Arriving from "Choose this package" means step 1 has already been
    // answered, so asking again is the same question twice. Open on Party
    // Details with step 1 behind them — it stays in the timeline, stays
    // clickable (furthest is 2), and shows its tick because isDone is n < step.
    //
    // Conditional on a package actually being carried. "See packages" on the
    // home page clears the selection deliberately, and anyone arriving fresh
    // has none, so those paths still land on step 1 exactly as before.
    if (!skippedPackageStep.current) {
      skippedPackageStep.current = true;
      setStep(prev => (prev === 1 ? 2 : prev));
      setFurthest(prev => Math.max(prev, 2));
    }
  }, [publishedBirthdayPackages, selectedBirthdayPackage]);

  const selectedPackage = useMemo(
    () => publishedBirthdayPackages.find(p => p.id === selectedPkgId) || null,
    [publishedBirthdayPackages, selectedPkgId]
  );
  // Display only. The stored values below (:447, :485, :513) keep the English name.
  const selectedPackageDisplayName = localizedText(selectedPackage?.name ?? '', selectedPackage?.nameAr, lang);

  // The package's full price, computed exactly as the database charges it
  // (online_payment_terms, 0046): 'Fixed price' is the price, otherwise
  // price x guests. This used to multiply Fixed-price packages too.
  const fullPrice = birthdayFullPrice(selectedPackage ?? undefined, Number(numberOfPeople || 0));

  // What is paid today. With online payments live it follows Settings ->
  // Online Payments (default: the full price); otherwise the package's
  // deposit, exactly as before.
  const onlineConfig = normalizeOnlinePayments(appSettings?.find(s => s.id === ONLINE_PAYMENTS_SETTING_ID)?.value);
  const onlineLive = ONLINE_PAYMENTS_AVAILABLE && onlineConfig.enabled;
  const onlineEstimate = estimateOnlineAmount(fullPrice, onlineConfig.birthday);
  const payMode: 'deposit' | 'full' = onlineLive ? onlineEstimate.mode : 'deposit';
  const depositAmount = onlineLive
    ? onlineEstimate.dueNow
    : (selectedPackage?.depositAmount ?? DEFAULT_DEPOSIT_AMOUNT);
  const timeOptions = selectedPackage?.availableTimes?.length
    ? selectedPackage.availableTimes
    : FALLBACK_TIMES;

  const [bookingDate, setBookingDate] = useState<string>('');
  const [bookingTime, setBookingTime] = useState<string>('');

  useEffect(() => {
    // Switching package can retire a slot. Clear it rather than silently
    // moving the booking to a time nobody picked.
    if (bookingTime && timeOptions.length > 0 && !timeOptions.includes(bookingTime)) {
      setBookingTime('');
    }
  }, [timeOptions, bookingTime]);

  /**
   * Parties already booked on the selected date, counted by the database.
   *
   * These maxima used to be checked against the `bookings` array from context,
   * which is RLS-scoped — a customer saw only their own parties, so a date was
   * never full and no slot was ever disabled. Unlike a workshop booking there
   * is no server-side check behind this, so this is the enforcement.
   */
  const birthdayCounts = useBirthdayCounts(bookingDate ? [bookingDate] : []);
  const countsForDate = birthdayCounts.get(bookingDate);
  // Undefined until the real counts arrive — never assumed to be free.
  const dateIsFull = countsForDate ? countsForDate.onDate >= BIRTHDAY_DAILY_MAX : false;
  const slotIsFull = (time: string) =>
    countsForDate ? (countsForDate.byTime.get(time) || 0) >= BIRTHDAY_SAME_SLOT_MAX : false;

  useEffect(() => {
    // Changing the date can land the previously chosen time on a slot that is
    // now full (or a date that is full outright) for the new date.
    if (
      bookingDate && bookingTime &&
      (dateIsFull || slotIsFull(bookingTime))
    ) {
      setBookingTime('');
    }
  }, [bookingDate, countsForDate]);

  const [balloonColorCustom, setBalloonColorCustom] = useState<string>('');
  const [birthdayPersonName, setBirthdayPersonName] = useState<string>('');
  const [cakePhotoUrl, setCakePhotoUrl] = useState<string | null>(null);

  // Values for configurable (dropdown / text / number / date) fields, keyed by field key.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const valueOf = (field: BirthdayFormField) => fieldValues[field.key] ?? '';
  const setValueOf = (key: string, value: string) =>
    setFieldValues(prev => ({ ...prev, [key]: value }));

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Step state. `furthest` keeps completed steps clickable in the stepper.
  const [step, setStep] = useState(1);
  const [furthest, setFurthest] = useState(1);

  /**
   * Resuming from the shared payment flow's Back button: this component
   * remounts from scratch, so without this the customer would land back on
   * Step 1 with everything they typed gone. If there is a birthday draft
   * already sitting in `pendingBooking`, restore it and jump straight back
   * to Review & Deposit — once, so it does not fight further edits.
   */
  const hydratedFromDraft = React.useRef(false);
  useEffect(() => {
    if (hydratedFromDraft.current) return;
    if (!pendingBooking || pendingBooking.workshopId !== 'birthday-party-event') return;
    const d = pendingBooking.birthdayDetails as any;
    if (!d) return;
    hydratedFromDraft.current = true;

    if (pendingBooking.customerName) setBookingName(pendingBooking.customerName);
    if (pendingBooking.customerPhone) setPhone(pendingBooking.customerPhone);
    if (d.packageId) setSelectedPkgId(d.packageId);
    if (typeof pendingBooking.participants === 'number') setNumberOfPeople(pendingBooking.participants);
    if (pendingBooking.date) setBookingDate(pendingBooking.date);
    if (pendingBooking.time) setBookingTime(pendingBooking.time);
    if (d.birthdayPersonName) setBirthdayPersonName(d.birthdayPersonName);
    if (d.cakePhotoUrl) setCakePhotoUrl(d.cakePhotoUrl);

    const restoredValues: Record<string, string> = {};
    for (const f of (d.fieldValues || [])) {
      if (f.key === 'balloonColor' && typeof f.value === 'string' && f.value.includes(' — ')) {
        const [base, custom] = f.value.split(' — ');
        restoredValues[f.key] = base;
        setBalloonColorCustom(custom || '');
      } else if (typeof f.value === 'string') {
        restoredValues[f.key] = f.value;
      }
    }
    setFieldValues(prev => ({ ...prev, ...restoredValues }));
    setTermsAccepted(!!d.termsAccepted);
    setStep(4);
    setFurthest(4);
  }, [pendingBooking]);

  const handleCakePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setCakePhotoUrl(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  /**
   * Every booking rule, unchanged and in one place.
   *
   * The step buttons show only the subset that belongs to the step being left,
   * so a visitor is never blocked by an error for a question they have not
   * reached — but nothing is submitted without the full set passing.
   */
  const collectErrors = () => {
    const errs: Record<string, string> = {};

    if (isActive('bookingName') && isRequired('bookingName') && !bookingName.trim()) {
      errs.bookingName = `${labelFor('bookingName', t('Booking name', 'اسم الحجز'))} ${t('is required', 'مطلوب')}`;
    }

    if (isActive('phone')) {
      if (!phone) {
        if (isRequired('phone')) errs.phone = t('Phone number is required', 'رقم الجوال مطلوب');
      } else {
        // The one shared phone rule, so this form agrees with sign-up, the
        // walk-in modal and every admin form.
        const result = validatePhoneRule(phone, lang);
        if (!result.valid) errs.phone = result.error!;
      }
    }

    if (isActive('numberOfPeople')) {
      if (!numberOfPeople || numberOfPeople < 1) {
        errs.numberOfPeople = t('At least 1 person is required', 'مطلوب شخص واحد على الأقل');
      } else if (selectedPackage) {
        if (numberOfPeople < selectedPackage.minGuests) {
          errs.numberOfPeople = `${t('This package requires at least', 'تتطلب هذه الباقة ما لا يقل عن')} ${selectedPackage.minGuests} ${t('guests', 'ضيوف')}`;
        } else if (numberOfPeople > selectedPackage.maxGuests) {
          errs.numberOfPeople = `${t('This package allows up to', 'تسمح هذه الباقة بحد أقصى')} ${selectedPackage.maxGuests} ${t('guests', 'ضيوف')}`;
        }
      }
    }

    if (isActive('package') && !selectedPackage) {
      errs.package = t('Please select a package', 'يرجى اختيار باقة');
    }

    if (isActive('bookingDate')) {
      // Recomputed from the actual headcount typed, not the placeholder
      // assumption the date field's `min` used before a headcount was picked.
      const noticeForCount = minBirthdayNoticeDays(Number(numberOfPeople) || 0);
      const currentMinDate = getMinBirthdayBookingDateStr(noticeForCount);
      if (!bookingDate) {
        errs.bookingDate = t('Please select a date', 'يرجى اختيار تاريخ');
      } else if (numberOfPeople && bookingDate < currentMinDate) {
        // ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. Also
        // note: this duplicates validateBirthdayBookingForm's own rule in
        // validation.ts (Phase B), but without that function's guest-count
        // singular/plural fork — a pre-existing inconsistency, not fixed here.
        errs.bookingDate = t(
          `Birthday bookings for ${numberOfPeople} guests need at least ${noticeForCount} day${noticeForCount === 1 ? '' : 's'} notice.`,
          `تتطلب حجوزات أعياد الميلاد لعدد ${numberOfPeople} ضيوف إشعارًا مسبقًا لا يقل عن ${noticeForCount} ${noticeForCount === 1 ? 'يوم' : 'أيام'}.`
        );
      } else if (bookingDate && dateIsFull) {
        // Reusing validation.ts's exact translation (Phase B) — identical English string.
        errs.bookingDate = t(
          'This date is fully booked for birthday celebrations. Please choose another date.',
          'هذا التاريخ مكتمل الحجز لاحتفالات أعياد الميلاد. يرجى اختيار تاريخ آخر.'
        );
      }
    }

    if (isActive('bookingTime')) {
      if (!bookingTime) {
        errs.bookingTime = t('Please select a time slot', 'يرجى اختيار وقت');
      } else if (bookingDate && !errs.bookingDate && slotIsFull(bookingTime)) {
        // Reusing validation.ts's exact translation (Phase B) — identical English string.
        errs.bookingTime = t(
          'This time slot is fully booked for birthday celebrations. Please choose another time.',
          'هذا الوقت مكتمل الحجز لاحتفالات أعياد الميلاد. يرجى اختيار وقت آخر.'
        );
      }
    }

    if (isActive('birthdayPersonName') && isRequired('birthdayPersonName') && !birthdayPersonName.trim()) {
      errs.birthdayPersonName = `${labelFor('birthdayPersonName', t('Name of the birthday person', 'اسم صاحب عيد الميلاد'))} ${t('is required', 'مطلوب')}`;
    }

    // Configurable fields added in Settings
    activeFields.forEach(field => {
      if (!field.required) return;
      if (['bookingName', 'phone', 'numberOfPeople', 'package', 'bookingDate', 'bookingTime', 'birthdayPersonName', 'cakePhoto'].includes(field.key)) return;
      if (!String(valueOf(field)).trim()) {
        errs[field.key] = `${displayLabel(field)} ${t('is required', 'مطلوب')}`;
      }
    });

    if (!termsAccepted) {
      errs.terms = t('Please read and accept the event terms and guidelines to continue.', 'يرجى قراءة شروط الفعالية والموافقة عليها للمتابعة.');
    }

    return errs;
  };

  const validate = () => {
    const errs = collectErrors();
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /** The error keys a given step is allowed to report. */
  const keysForStep = (s: number): string[] => {
    if (s === 1) return ['package'];
    if (s === 2) return detailFields.map(f => f.key);
    if (s === 3) return extraFields.map(f => f.key);
    return [];
  };

  const goToStep = (target: number) => {
    // Moving backwards never validates — the visitor is going back to fix
    // something, and blocking that is how forms trap people.
    if (target < step) {
      setStep(target);
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      return;
    }

    const all = collectErrors();
    const relevant: Record<string, string> = {};
    for (let s = step; s < target; s++) {
      keysForStep(s).forEach(key => {
        if (all[key]) relevant[key] = all[key];
      });
    }

    setErrors(relevant);
    if (Object.keys(relevant).length > 0) return;

    setStep(target);
    setFurthest(prev => Math.max(prev, target));
    window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      // A failure here is almost always a field on an earlier step, which the
      // review step does not render — showing the message where it cannot be
      // seen would look like the button was simply dead.
      const failing = collectErrors();
      const offending = [1, 2, 3].find(s => keysForStep(s).some(key => failing[key]));
      if (offending) setStep(offending);
      return;
    }

    // Normalize once, from the parsed components, so the country code is never doubled.
    const normPhone = canonicalPhone(phone);

    // Capture every submitted answer against its stable field key, so the value
    // stays readable even if the label is renamed in Settings later.
    const fieldValues = activeFields.map(field => {
      let value = '';
      let imageUrl: string | undefined;

      switch (field.key) {
        case 'bookingName': value = bookingName.trim(); break;
        case 'phone': value = normPhone; break;
        case 'numberOfPeople': value = String(numberOfPeople); break;
        case 'package': value = selectedPackage?.name || ''; break;
        case 'bookingDate': value = bookingDate; break;
        case 'bookingTime': value = bookingTime; break;
        case 'birthdayPersonName': value = birthdayPersonName.trim(); break;
        case 'cakePhoto':
          // The image itself is stored with the answer, not just a note about it.
          imageUrl = cakePhotoUrl || undefined;
          value = cakePhotoUrl ? 'Image submitted' : '';
          break;
        default: {
          const raw = String(valueOf(field) || '').trim();
          value = raw.toLowerCase().includes('custom') && balloonColorCustom.trim()
            ? `${raw} — ${balloonColorCustom.trim()}`
            : raw;
        }
      }

      // Any field configured as an image carries its upload the same way.
      if (field.type === 'image' && !imageUrl && cakePhotoUrl) {
        imageUrl = cakePhotoUrl;
        value = value || 'Image submitted';
      }

      return { key: field.key, label: field.label, value, imageUrl };
    });

    const answerFor = (key: string) => fieldValues.find(f => f.key === key)?.value || '';

    // Exact wording the customer saw, stored with the acceptance.
    const termsLines = [
      ...terms.leadingItems,
      terms.suppliesIntro,
      ...terms.supplies.map((item, i) => `${i + 1}. ${item}`),
      ...terms.trailingItems
    ].map(line => renderTermsLine(line, { deposit: depositAmount, cancellationDays }));

    // Arabic twin of the snapshot, only when Arabic terms exist. Built like the English
    // one (same substitutions, numbering baked in) and mirrors what step 4 displays:
    // the intro is omitted when blank, and intro + list only appear when there are supplies.
    const termsLinesAr: string[] | undefined = hasArabicTerms
      ? [
          ...arLeading,
          ...(arSupplies.length > 0
            ? [
                ...(terms.suppliesIntroAr?.trim() ? [terms.suppliesIntroAr.trim()] : []),
                ...arSupplies.map((item, i) => `${i + 1}. ${item}`)
              ]
            : []),
          ...arTrailing
        ].map(line => renderTermsLine(line, { deposit: depositAmount, cancellationDays }))
      : undefined;
    // Which set the customer was actually looking at right now.
    const termsShownLang: 'en' | 'ar' = showArabicTerms ? 'ar' : 'en';

    const birthdayDetails = {
      packageId: selectedPackage?.id,
      packageName: selectedPackage?.name,
      eventDate: bookingDate,
      eventTime: bookingTime,
      guestCount: Number(numberOfPeople),
      birthdayPersonName: birthdayPersonName.trim(),
      birthdayPersonAge: answerFor('birthdayPersonAge'),
      activitySelection: answerFor('activitySelection'),
      cakeOption: selectedPackage?.cakeDescription || '',
      cakeSize: answerFor('cakeSize'),
      cakePhotoUrl: cakePhotoUrl || undefined,
      themeOrColors: answerFor('balloonColor'),
      addOns: [answerFor('drinksChoice')].filter(Boolean),
      specialRequests: answerFor('specialRequests'),
      notes: answerFor('notes'),
      termsAccepted: true,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: terms.version,
      termsSnapshot: termsLines,
      termsSnapshotAr: termsLinesAr,
      termsShownLang,
      totalAmount: fullPrice,
      depositAmount,
      submittedAt: new Date().toISOString(),
      fieldValues
    };

    // Same draft-then-authenticate path the workshop booking uses. The full draft
    // is preserved through sign-in / account creation.
    setPendingBooking({
      workshopId: 'birthday-party-event',
      workshopTitle: `Birthday Party — ${selectedPackage?.name || 'Package'}`,
      date: bookingDate,
      time: bookingTime,
      participants: Number(numberOfPeople),
      totalPrice: onlineLive ? fullPrice : depositAmount,
      // Carried into Customer Information so it is never re-typed.
      customerName: bookingName.trim(),
      customerEmail: currentUser?.email || '',
      customerPhone: normPhone,
      birthdayDetails
    });

    // Customer Information handles sign-in or account creation, then payment.
    setCustomerTab('checkout-info');
  };

  const inputClass = (hasError?: string) =>
    `w-full rounded-2xl border bg-white p-3.5 text-sm text-brand-charcoal focus:outline-none focus:ring-2 ${
      hasError
        ? 'border-red-500 focus:ring-red-300'
        : 'border-brand-clay focus:border-brand-terracotta focus:ring-brand-terracotta/20'
    }`;

  const labelClass = 'block text-xs font-bold text-brand-charcoal/80 mb-1.5';
  const fieldError = (key: string) =>
    errors[key] ? <p className="mt-1.5 text-[11px] font-semibold text-red-500">{errors[key]}</p> : null;

  /** Chip / tile picker — the visual replacement for a plain option list. */
  const OptionTiles: React.FC<{
    options: string[];
    value: string;
    onSelect: (v: string) => void;
    withSwatches?: boolean;
    priceFor?: (option: string) => number | undefined;
    disabledOptions?: string[];
    formatOption?: (option: string) => string;
  }> = ({ options, value, onSelect, withSwatches, priceFor, disabledOptions, formatOption }) => (
    <div className="flex flex-wrap gap-2.5">
      {options.map(option => {
        const isOn = value === option;
        const isDisabled = !!disabledOptions?.includes(option);
        const swatch = withSwatches ? swatchFor(option) : null;
        const price = priceFor?.(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isOn}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            onClick={() => !isDisabled && onSelect(option)}
            className={`group flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors ${
              isDisabled
                ? 'cursor-not-allowed border-brand-clay bg-brand-sand/40 text-brand-muted opacity-60'
                : `cursor-pointer ${isOn
                    ? 'border-brand-terracotta bg-brand-terracotta/8 text-brand-charcoal'
                    : 'border-brand-clay bg-white text-brand-ink hover:border-brand-muted'}`
            }`}
          >
            {swatch && (
              <span
                aria-hidden="true"
                className="h-5 w-5 shrink-0 rounded-full ring-1 ring-brand-clay"
                style={swatch.startsWith('linear') ? { backgroundImage: swatch } : { backgroundColor: swatch }}
              />
            )}
            <span className="text-start">
              {(formatOption ?? optionText)(option)}
              {isDisabled ? (
                <span className="block text-[11px] font-medium text-brand-muted">{t('Full', 'ممتلئ')}</span>
              ) : price !== undefined && (
                <span className="block text-[11px] font-medium text-brand-muted ltr-numerals">{price} {t('SAR', 'ريال')}</span>
              )}
            </span>
            {isOn && !isDisabled && <Check className="h-4 w-4 shrink-0 text-brand-terracotta" />}
          </button>
        );
      })}
    </div>
  );

  /** Renders one configured field. Same keys, same values, new controls. */
  const renderField = (field: BirthdayFormField) => {
    const required = field.required;
    const label = (
      <label className={labelClass}>
        {displayLabel(field)} {required && <span className="text-red-500">*</span>}
      </label>
    );

    switch (field.key) {
      case 'bookingName':
        return (
          <div key={field.id}>
            {label}
            <input
              type="text"
              value={bookingName}
              onChange={e => setBookingName(e.target.value)}
              placeholder={field.placeholder || t('e.g. Noura Al-Amri', 'مثال: نورة العمري')}
              className={inputClass(errors.bookingName)}
            />
            {fieldError('bookingName')}
          </div>
        );

      case 'phone':
        return (
          <PhoneInput
            key={field.id}
            label={displayLabel(field)}
            required={required}
            value={phone}
            onChange={val => setPhone(val)}
            error={errors.phone}
          />
        );

      case 'numberOfPeople': {
        const min = selectedPackage?.minGuests || 1;
        const max = selectedPackage?.maxGuests || 100;
        return (
          <div key={field.id}>
            {label}
            {/* Stepper rather than a bare number input: guest count is the one
                field with a hard range, and nudging it is faster than typing —
                especially on a phone. */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label={t('Fewer guests', 'ضيوف أقل')}
                onClick={() => setNumberOfPeople(n => Math.max(min, (n || min) - 1))}
                className="h-12 w-12 shrink-0 rounded-full border border-brand-clay bg-white text-lg font-semibold text-brand-charcoal transition-colors hover:bg-brand-sand/50 cursor-pointer"
              >
                −
              </button>
              {/* `no-spinner` drops the browser's own up/down arrows: they sat
                  inside the field next to the custom buttons, which read as two
                  competing sets of controls. */}
              <input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                placeholder="—"
                value={numberOfPeople}
                onChange={e => {
                  const raw = e.target.value;
                  setNumberOfPeople(raw === '' ? '' : (parseInt(raw) || ''));
                }}
                className={`${inputClass(errors.numberOfPeople)} no-spinner flex-1 text-center font-semibold ltr-numerals`}
              />
              <button
                type="button"
                aria-label={t('More guests', 'ضيوف أكثر')}
                onClick={() => setNumberOfPeople(n => Math.min(max, (n || min) + 1))}
                className="h-12 w-12 shrink-0 rounded-full border border-brand-clay bg-white text-lg font-semibold text-brand-charcoal transition-colors hover:bg-brand-sand/50 cursor-pointer"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-brand-muted">
              {t('Include the birthday person in the total.', 'اشمل صاحب عيد الميلاد ضمن العدد الإجمالي.')}
            </p>
            {selectedPackage && (
              <p className="mt-1 text-[11px] font-semibold text-brand-muted">
                {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                {t('This package hosts', 'تستضيف هذه الباقة')} {selectedPackage.minGuests}–{selectedPackage.maxGuests} {t('guests', 'ضيوف')}.
              </p>
            )}
            {fieldError('numberOfPeople')}
          </div>
        );
      }

      case 'package':
        // The package is chosen on step 1 with the picker, not with a select.
        return null;

      case 'bookingDate':
        return (
          <div key={field.id}>
            {label}
            <DateInput
              min={minBookingDate}
              value={bookingDate}
              onChange={e => setBookingDate(e.target.value)}
              className={inputClass(errors.bookingDate)}
            />
            <p className="mt-1.5 text-[11px] font-semibold text-brand-terracotta">
              <Info className="inline h-3.5 w-3.5 me-1 align-[-2px]" />
              {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
              {numberOfPeople
                ? t(
                    `For ${numberOfPeople} guests, book at least ${minBirthdayNoticeDays(Number(numberOfPeople))} day${minBirthdayNoticeDays(Number(numberOfPeople)) === 1 ? '' : 's'} in advance.`,
                    `لعدد ${numberOfPeople} ضيوف، يرجى الحجز قبل ${minBirthdayNoticeDays(Number(numberOfPeople))} ${minBirthdayNoticeDays(Number(numberOfPeople)) === 1 ? 'يوم' : 'أيام'} على الأقل.`
                  )
                : t(
                    'Parties of 3–4 need 1 day notice; 5 or more need 4 days notice.',
                    'الحفلات من 3 إلى 4 أشخاص تحتاج إشعارًا قبل يوم واحد؛ 5 أشخاص أو أكثر تحتاج إشعارًا قبل 4 أيام.'
                  )}
            </p>
            {selectedPackage?.availableDays?.length ? (
              <p className="mt-0.5 text-[11px] font-semibold text-brand-muted">
                {t('Available days', 'الأيام المتاحة')}: {selectedPackage.availableDays.map(d => dayLabel(d, lang)).join(', ')}
              </p>
            ) : null}
            {fieldError('bookingDate')}
          </div>
        );

      case 'bookingTime': {
        // A slot at BIRTHDAY_SAME_SLOT_MAX is disabled here — the same rule
        // collectErrors() and the submit-time re-check both enforce — even
        // when the day overall still has room.
        const fullTimes = bookingDate ? timeOptions.filter(slotIsFull) : [];
        const dateFull = dateIsFull;
        return (
          <div key={field.id} className="sm:col-span-2">
            {label}
            <OptionTiles
              options={timeOptions}
              value={bookingTime}
              onSelect={setBookingTime}
              disabledOptions={dateFull ? timeOptions : fullTimes}
              formatOption={time => timeLabel(time, lang)}
            />
            {dateFull && (
              <p className="mt-1.5 text-[11px] font-semibold text-red-500">
                {t('This date is fully booked for birthday celebrations. Please choose another date.', 'هذا التاريخ مكتمل الحجز لاحتفالات أعياد الميلاد. يرجى اختيار تاريخ آخر.')}
              </p>
            )}
            {fieldError('bookingTime')}
          </div>
        );
      }

      case 'birthdayPersonName':
        return (
          <div key={field.id} className="sm:col-span-2">
            {label}
            <input
              type="text"
              value={birthdayPersonName}
              onChange={e => setBirthdayPersonName(e.target.value)}
              placeholder={field.placeholder || t('e.g. Maya (Turning 8!)', 'مثال: مايا (تكمل 8 سنوات!)')}
              className={inputClass(errors.birthdayPersonName)}
            />
            {fieldError('birthdayPersonName')}
          </div>
        );

      case 'cakePhoto':
        return (
          <div key={field.id} className="sm:col-span-2">
            {label}
            <div className="flex flex-col items-center gap-4 rounded-[28px] border-2 border-dashed border-brand-clay bg-white p-5 transition-colors hover:bg-brand-sand/20 sm:flex-row">
              {cakePhotoUrl ? (
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl ring-1 ring-brand-clay">
                  <img src={cakePhotoUrl} alt={t('Cake Design', 'تصميم الكعكة')} className="h-full w-full object-cover" />
                </div>
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-sand/60 text-brand-muted">
                  <Upload className="h-6 w-6" />
                </div>
              )}

              <div className="flex-1 text-center sm:text-start">
                <input
                  type="file"
                  id="cake-photo-upload"
                  accept="image/*"
                  onChange={handleCakePhotoChange}
                  className="hidden"
                />
                <label
                  htmlFor="cake-photo-upload"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-brand-clay bg-brand-cream px-4 py-2.5 text-xs font-semibold text-brand-terracotta transition-colors hover:bg-brand-sand/50"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>{cakePhotoUrl ? t('Change cake photo', 'تغيير صورة الكعكة') : t('Upload cake design image', 'رفع صورة تصميم الكعكة')}</span>
                </label>
                <p className="mt-1.5 text-[11px] text-brand-muted">
                  {field.helpText || t('Send us your customized cake design photo and we will prepare it for you!', 'أرسل لنا صورة تصميم الكعكة المخصص وسنقوم بتحضيرها لك!')}
                </p>
              </div>
            </div>
          </div>
        );

      default: {
        // Fields configured in Settings → Events & Birthday. A dropdown with a
        // handful of options becomes tiles; only long option lists stay a
        // select, where scanning tiles would be slower than a list.
        const options = field.options || [];
        const asTiles = field.type === 'dropdown' && options.length > 0 && options.length <= 8;
        const cakePriceFor = (option: string) =>
          selectedPackage?.cakeSizes.find(
            c => c.label.toLowerCase() === option.trim().toLowerCase()
          )?.price;

        return (
          <div key={field.id} className="sm:col-span-2">
            {label}
            {field.type === 'dropdown' ? (
              <>
                {asTiles ? (
                  <OptionTiles
                    options={options}
                    value={valueOf(field)}
                    onSelect={v => setValueOf(field.key, v)}
                    withSwatches={field.key.toLowerCase().includes('color') || field.key.toLowerCase().includes('colour')}
                    priceFor={field.key === 'cakeSize' ? cakePriceFor : undefined}
                  />
                ) : (
                  <select
                    value={valueOf(field)}
                    onChange={e => setValueOf(field.key, e.target.value)}
                    className="w-full rounded-2xl border border-brand-clay bg-white p-3.5 text-sm text-brand-charcoal focus:border-brand-terracotta focus:outline-none focus:ring-2 focus:ring-brand-terracotta/20"
                  >
                    {options.map(opt => (
                      <option key={opt} value={opt}>{optionText(opt)}</option>
                    ))}
                  </select>
                )}
                {/* Free-text companion for a "Custom" style choice */}
                {valueOf(field).toLowerCase().includes('custom') && (
                  <input
                    type="text"
                    placeholder={t('Please specify', 'يرجى التحديد')}
                    value={balloonColorCustom}
                    onChange={e => setBalloonColorCustom(e.target.value)}
                    className={`${inputClass()} mt-2.5`}
                  />
                )}
              </>
            ) : field.type === 'long_text' ? (
              <textarea
                rows={3}
                value={valueOf(field)}
                placeholder={field.placeholder}
                onChange={e => setValueOf(field.key, e.target.value)}
                className={inputClass(errors[field.key])}
              />
            ) : (
              <input
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                value={valueOf(field)}
                placeholder={field.placeholder}
                onChange={e => setValueOf(field.key, e.target.value)}
                className={inputClass(errors[field.key])}
              />
            )}
            {field.helpText && <p className="mt-1.5 text-[11px] text-brand-muted">{field.helpText}</p>}
            {fieldError(field.key)}
          </div>
        );
      }
    }
  };

  /** Extras the visitor has actually answered, for the summary and review. */
  const chosenExtras = useMemo(
    () =>
      extraFields
        .map(f => ({
          label: displayLabel(f),
          value: f.key === 'cakePhoto'
            ? (cakePhotoUrl ? t('Design image attached', 'تم إرفاق صورة التصميم') : '')
            : f.type === 'dropdown'
              ? optionText(String(valueOf(f) || '').trim())
              : String(valueOf(f) || '').trim()
        }))
        .filter(entry => entry.value),
    // valueOf reads fieldValues, so both drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extraFields, fieldValues, cakePhotoUrl, lang]
  );

  const estimatedTotal = fullPrice;

  const prettyDate = useMemo(() => {
    if (!bookingDate) return '';
    const d = new Date(`${bookingDate}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? bookingDate
      : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  }, [bookingDate]);

  /**
   * The one celebration ticket.
   *
   * Rendered in exactly one place at a time — beside the form while filling in,
   * in the middle of the page at the review step — and carrying a `layoutId`,
   * so Motion moves the same element between the two positions instead of
   * swapping one card for another.
   *
   * Every row reads live state; nothing is defaulted. A row the visitor has not
   * answered shows a dash, so the ticket never presents an unmade choice as a
   * booked one.
   */
  const ticketRows: Array<{ label: string; value: string }> = [
    { label: t('Booked by', 'باسم'), value: bookingName.trim() },
    { label: t('Phone', 'الجوال'), value: phone.trim() },
    { label: t('Birthday person', 'صاحب عيد الميلاد'), value: birthdayPersonName.trim() },
    { label: t('Guests', 'الضيوف'), value: numberOfPeople === '' ? '' : String(numberOfPeople) },
    { label: t('Date', 'التاريخ'), value: prettyDate },
    { label: t('Time', 'الوقت'), value: timeLabel(bookingTime, lang) },
    ...chosenExtras
  ];

  const ticketInner = (
      <div className="space-y-4">
        {selectedPackage?.image ? (
          <div className="h-32 w-full overflow-hidden rounded-2xl bg-brand-sand">
            <img
              src={selectedPackage.image}
              alt=""
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <div className="flex h-32 w-full items-center justify-center rounded-2xl bg-brand-sand/60 text-xs font-semibold text-brand-muted">
            {t('No package chosen yet', 'لم يتم اختيار باقة بعد')}
          </div>
        )}

        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
            {t('Your celebration', 'احتفالك')}
          </span>
          <p className={`mt-1 font-display text-xl font-semibold ${
            selectedPackage ? 'text-brand-charcoal' : 'text-brand-muted'
          }`}>
            {selectedPackageDisplayName || t('No package selected', 'لم يتم اختيار باقة')}
          </p>
        </div>

        <dl className="space-y-2.5 border-t border-brand-clay pt-4 text-sm">
          {ticketRows.map(row => (
            <div key={row.label} className="flex items-start justify-between gap-4">
              <dt className="text-brand-muted">{row.label}</dt>
              <dd className={`text-end ltr-numerals ${
                row.value ? 'font-semibold text-brand-charcoal' : 'text-brand-muted'
              }`}>
                {row.value || '—'}
              </dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2 border-t border-brand-clay pt-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-brand-muted">
              {t('Estimated total', 'الإجمالي التقديري')}
              {selectedPackage && numberOfPeople !== '' && selectedPackage.pricingType !== 'Fixed price' && (
                <span className="ltr-numerals"> ({selectedPackage.price} × {numberOfPeople})</span>
              )}
            </span>
            <span className={`ltr-numerals ${
              estimatedTotal ? 'font-semibold text-brand-charcoal' : 'text-brand-muted'
            }`}>
              {estimatedTotal ? `${estimatedTotal} ${t('SAR', 'ريال')}` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-semibold text-brand-charcoal">
              {payMode === 'full' ? t('Due today', 'المستحق اليوم') : t('Deposit due today', 'العربون المستحق اليوم')}
            </span>
            <span className="font-display text-xl font-semibold text-brand-terracotta ltr-numerals">
              {depositAmount} {t('SAR', 'ريال')}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-brand-muted">
            {payMode === 'full'
              ? t('Paid in full online. Any cake upgrade is added at the studio. Cancel more than 24 hours ahead for a refund.', 'يُدفع المبلغ كاملًا إلكترونيًا. أي ترقية للكعكة تُضاف في الاستوديو. يُسترد المبلغ عند الإلغاء قبل أكثر من 24 ساعة.')
              : t('The balance is settled at the studio. Any cake upgrade is added to the final bill.', 'يُسدد باقي المبلغ في الاستوديو. أي ترقية للكعكة تُضاف إلى الفاتورة النهائية.')}
          </p>
        </div>
      </div>
  );

  /**
   * The moving copy. Only ever mounted once — the mobile drawer below uses the
   * plain content instead, because two elements sharing a `layoutId` at the
   * same time would fight over the animation.
   */
  const Ticket: React.FC<{ centred?: boolean }> = ({ centred }) => (
    <motion.div
      layoutId="bday-ticket"
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.45, ease }}
      className={`rounded-[28px] bg-white p-6 shadow-card ring-1 ring-brand-clay ${
        centred ? 'mx-auto w-full max-w-xl' : ''
      }`}
    >
      {ticketInner}
    </motion.div>
  );

  const stepVariants = prefersReducedMotion
    ? { initial: {}, animate: {}, exit: {} }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -12 }
      };

  const [mobileSummaryOpen, setMobileSummaryOpen] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 pb-32 text-start lg:pb-8">

      <BackButton onClick={() => setCustomerTab('home')} className="mb-6">
        {t('Back to Home', 'العودة إلى الرئيسية')}
      </BackButton>

      <div className="mb-8">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
          {t('Private Celebration', 'احتفال خاص')}
        </span>
        <h1 className="mt-3 font-display text-3xl font-semibold text-brand-charcoal sm:text-[42px]">
          {t('Reserve your party', 'احجز حفلتك')}
        </h1>
      </div>

      {/* STEPPER */}
      <nav aria-label={t('Reservation steps', 'خطوات الحجز')} className="mb-10 border-b border-brand-clay pb-5">
        <ol className="flex items-center gap-2 overflow-x-auto no-scrollbar sm:gap-4">
          {STEPS.map(({ n, label, labelAr }) => {
            const isCurrent = n === step;
            const isDone = n < step;
            const reachable = n <= furthest;
            return (
              <li key={n} className="flex shrink-0 items-center gap-2 sm:gap-4">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && goToStep(n)}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`flex items-center gap-2.5 rounded-full px-1 py-1 text-sm transition-colors ${
                    reachable ? 'cursor-pointer' : 'cursor-not-allowed'
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                      isCurrent
                        ? 'bg-brand-terracotta text-brand-cream'
                        : isDone
                          ? 'bg-brand-sage text-brand-cream'
                          : 'border border-brand-clay bg-white text-brand-muted'
                    }`}
                  >
                    {isDone ? <Check className="h-4 w-4" /> : n}
                  </span>
                  <span
                    className={`whitespace-nowrap font-semibold ${
                      isCurrent ? 'text-brand-charcoal' : 'text-brand-muted'
                    } ${isCurrent ? '' : 'hidden sm:inline'}`}
                  >
                    {t(label, labelAr)}
                  </span>
                </button>
                {n < STEPS.length && <span className="h-px w-4 bg-brand-clay sm:w-8" aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
      </nav>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">

          {/* THE STEP */}
          <div className={step === 4 ? 'lg:col-span-12' : 'lg:col-span-7 xl:col-span-8'}>
            {step === 4 && (
              <>
                <header className="mb-6">
                  <h2 className="flex items-center gap-2 font-display text-2xl font-semibold text-brand-charcoal">
                    <PartyPopper className="h-6 w-6 text-brand-terracotta" />
                    {t('Review your booking', 'راجع حجزك')}
                  </h2>
                  <p className="mt-1.5 text-sm text-brand-ink">
                    {t('Check everything below, then pay the deposit to hold your date.', 'راجع كل ما هو أدناه، ثم ادفع العربون لتثبيت تاريخك.')}
                  </p>
                </header>

                {/* The same ticket from the sidebar, moved here rather than
                    rebuilt — so the review shows the booking once, not twice. */}
                <div className="mb-6">
                  <Ticket centred />
                </div>
              </>
            )}

            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={stepVariants.initial}
                animate={stepVariants.animate}
                exit={stepVariants.exit}
                transition={{ duration: 0.32, ease }}
              >

                {/* 1 — PACKAGE */}
                {step === 1 && (
                  <section className="space-y-5">
                    <header>
                      <h2 className="font-display text-2xl font-semibold text-brand-charcoal">
                        {t('Which celebration?', 'أي احتفال؟')}
                      </h2>
                      <p className="mt-1.5 text-sm text-brand-ink">
                        {t('Pick the package for your party. You can change it before you pay.', 'اختر الباقة لحفلتك. يمكنك تغييرها قبل الدفع.')}
                      </p>
                    </header>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {publishedBirthdayPackages.map(pkg => {
                        const isOn = pkg.id === selectedPkgId;
                        return (
                          <button
                            key={pkg.id}
                            type="button"
                            aria-pressed={isOn}
                            onClick={() => {
                              setSelectedPkgId(pkg.id);
                              setSelectedBirthdayPackage(pkg.id);
                            }}
                            /* Rings on both states, no border. `border-2
                               border-transparent` was here to reserve the space
                               the terracotta selection border would take, so the
                               card could not shift — but a background paints
                               under its own border, so `bg-white` showed through
                               those 2px as a white band around the image. A ring
                               draws outside the box: same no-shift guarantee,
                               nothing between the image and the card edge. */
                            className={`overflow-hidden rounded-[28px] bg-white text-start transition-shadow cursor-pointer ${
                              isOn
                                ? 'ring-2 ring-brand-terracotta'
                                : 'ring-1 ring-brand-clay hover:ring-brand-muted'
                            }`}
                          >
                            {pkg.image && (
                              <div className="h-32 w-full overflow-hidden bg-brand-sand">
                                <img
                                  src={pkg.image}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              </div>
                            )}
                            <div className="p-5">
                              <div className="flex items-start justify-between gap-3">
                                <h3 className="font-display text-lg font-semibold text-brand-charcoal">
                                  {localizedText(pkg.name, pkg.nameAr, lang)}
                                </h3>
                                {isOn && (
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-terracotta text-brand-cream">
                                    <Check className="h-3.5 w-3.5" />
                                  </span>
                                )}
                              </div>
                              <p className="mt-1.5 text-xs text-brand-ink">
                                {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                                {[localizedText(pkg.duration, pkg.durationAr, lang), `${pkg.minGuests}–${pkg.maxGuests} ${t('guests', 'ضيوف')}`, localizedText(pkg.ageInformation, pkg.ageInformationAr, lang)]
                                  .filter(Boolean).join(' · ')}
                              </p>
                              <p className="mt-3 font-display text-xl font-semibold text-brand-charcoal ltr-numerals">
                                {pkg.price}
                                <span className="ms-1.5 text-xs font-medium text-brand-muted">
                                  {t('SAR', 'ريال')} {localizedText(enumLabel('pricingType', pkg.pricingLabel || pkg.pricingType, lang), pkg.pricingLabelAr, lang)}
                                </span>
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {fieldError('package')}
                  </section>
                )}

                {/* 2 — PARTY DETAILS */}
                {step === 2 && (
                  <section className="space-y-5">
                    <header>
                      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold text-brand-charcoal">
                        <CalendarDays className="h-6 w-6 text-brand-terracotta" />
                        {t('Party details', 'تفاصيل الحفلة')}
                      </h2>
                      <p className="mt-1.5 text-sm text-brand-ink">
                        {t('Who the party is for, when it is, and how to reach you.', 'لمن الحفلة، متى ستُقام، وكيفية التواصل معك.')}
                      </p>
                    </header>
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                      {detailFields.map(renderField)}
                    </div>
                  </section>
                )}

                {/* 3 — EXTRAS */}
                {step === 3 && (
                  <section className="space-y-5">
                    <header>
                      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold text-brand-charcoal">
                        <Cake className="h-6 w-6 text-brand-terracotta" />
                        {t('The finishing touches', 'اللمسات الأخيرة')}
                      </h2>
                      <p className="mt-1.5 text-sm text-brand-ink">
                        {t('Colours, cake and anything else that makes the day theirs.', 'الألوان، الكعكة، وكل ما يجعل اليوم مميزًا لهم.')}
                      </p>
                    </header>
                    {extraFields.length > 0 ? (
                      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                        {extraFields.map(renderField)}
                      </div>
                    ) : (
                      <p className="rounded-[28px] bg-brand-sand/50 p-6 text-sm text-brand-ink">
                        {t('Nothing to choose here — your package already covers everything.', 'لا يوجد شيء لاختياره هنا — باقتك تغطي كل شيء بالفعل.')}
                      </p>
                    )}
                  </section>
                )}

                {/* 4 — REVIEW & DEPOSIT. The heading and the ticket sit above
                    this block, outside the step transition. */}
                {step === 4 && (
                  <section className="space-y-6">
                    {/* TERMS — shown in full. Nothing here is behind a click:
                        it is the wording the acceptance below is bound to. */}
                    <div className="mx-auto w-full max-w-xl rounded-[28px] bg-white p-6 ring-1 ring-brand-clay">
                      {(!showArabicTerms || shownTerms.title) && (
                        <h3 className="flex items-center gap-2 font-display text-base font-semibold text-brand-charcoal">
                          <ShieldAlert className="h-5 w-5 text-brand-terracotta" />
                          {shownTerms.title}
                        </h3>
                      )}

                      <div className="mt-4 space-y-3 text-xs leading-relaxed text-brand-ink">
                              {shownTerms.leadingItems.map((line, idx) => (
                                <p key={idx} className="font-semibold text-brand-charcoal">
                                  {renderTermsLine(line, { deposit: depositAmount, cancellationDays })}
                                </p>
                              ))}

                              {shownTerms.supplies.length > 0 && (
                                <div>
                                  {(!showArabicTerms || shownTerms.suppliesIntro) && (
                                    <p className="mb-1 font-semibold text-brand-charcoal">
                                      {renderTermsLine(shownTerms.suppliesIntro, { deposit: depositAmount, cancellationDays })}
                                    </p>
                                  )}
                                  <ol className="list-decimal space-y-0.5 ps-5 font-medium">
                                    {shownTerms.supplies.map((item, idx) => <li key={idx}>{item}</li>)}
                                  </ol>
                                </div>
                              )}

                              {shownTerms.trailingItems.map((line, idx) => (
                                <p key={idx} className="font-medium">
                                  {renderTermsLine(line, { deposit: depositAmount, cancellationDays })}
                                </p>
                              ))}
                      </div>

                      <label
                        className={`mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-colors ${
                          errors.terms ? 'border-red-400 bg-red-50/50' : 'border-brand-clay hover:bg-brand-sand/30'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={termsAccepted}
                          onChange={e => {
                            setTermsAccepted(e.target.checked);
                            if (errors.terms) setErrors(prev => ({ ...prev, terms: '' }));
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-terracotta"
                        />
                        <span className="text-xs font-semibold text-brand-charcoal">
                          {t('I have read and accept the event terms and guidelines.', 'لقد قرأت شروط الفعالية وإرشاداتها ووافقت عليها.')}{' '}
                          <span className="text-red-500">*</span>
                        </span>
                      </label>
                      {errors.terms && (
                        <p className="mt-2 text-[11px] font-semibold text-red-600">{errors.terms}</p>
                      )}
                    </div>
                  </section>
                )}

              </motion.div>
            </AnimatePresence>

            {/* STEP NAVIGATION */}
            <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => goToStep(step - 1)}
                  className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border border-brand-clay bg-white px-6 py-3.5 text-sm font-semibold text-brand-ink transition-colors hover:text-brand-charcoal"
                >
                  <ArrowLeft className="h-4 w-4 flip-rtl" />
                  {t('Back', 'رجوع')}
                </button>
              ) : <span className="hidden sm:block" />}

              {step < 4 ? (
                <button
                  type="button"
                  onClick={() => goToStep(step + 1)}
                  className="cursor-pointer rounded-full bg-brand-terracotta px-8 py-4 text-sm font-semibold text-brand-cream shadow-button transition-colors hover:bg-brand-terracotta-hover active:scale-[0.99]"
                >
                  {t('Continue', 'متابعة')}
                </button>
              ) : (
                <button
                  type="submit"
                  className="cursor-pointer rounded-full bg-brand-terracotta px-8 py-4 text-base font-semibold text-brand-cream shadow-button transition-colors hover:bg-brand-terracotta-hover active:scale-[0.99]"
                >
                  {payMode === 'full'
                    ? <>{t('Pay', 'ادفع')} {depositAmount} {t('SAR', 'ريال')}</>
                    : <>{t('Pay', 'ادفع')} {depositAmount} {t('SAR Deposit', 'ريال عربون')}</>}
                </button>
              )}
            </div>
          </div>

          {/* THE TICKET — beside the form from lg up, until the review step
              takes it into the middle of the page. */}
          {step < 4 && (
            <aside className="hidden lg:col-span-5 lg:block xl:col-span-4">
              <div className="sticky top-24">
                <Ticket />
              </div>
            </aside>
          )}
        </div>
      </form>

      {/* MOBILE SUMMARY — a bar that stays out of the way until it is opened.
          Hidden on the review step, where the ticket is already the page.

          Sits flush on the bottom edge. It is the only fixed element there —
          the global tab bar it used to dock above has been removed — so it
          owns the safe-area inset itself, via the toggle's padding below.

          Gated on lg, not md: it is paired with the desktop ticket sidebar,
          which does not appear until lg, so moving it would leave 768–1024px
          with no order summary at all. */}
      <div className={`fixed inset-x-0 bottom-0 z-30 border-t border-brand-clay bg-brand-cream/95 backdrop-blur-md lg:hidden ${
        step === 4 ? 'hidden' : ''
      }`}>
        <AnimatePresence initial={false}>
          {mobileSummaryOpen && (
            <motion.div
              initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={prefersReducedMotion ? undefined : { height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease }}
              className="max-h-[55vh] overflow-y-auto"
            >
              <div className="px-4 py-5">{ticketInner}</div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={() => setMobileSummaryOpen(v => !v)}
          aria-expanded={mobileSummaryOpen}
          // This bar touches the screen edge again, so it carries the
          // home-indicator inset itself.
          className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] text-start"
        >
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-brand-ink">
              {selectedPackageDisplayName || t('Select a package', 'اختر باقة')}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-brand-muted">
              <Clock className="h-3 w-3" />
              <span className="truncate">{prettyDate || '—'} · {bookingTime ? timeLabel(bookingTime, lang) : '—'}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="font-display text-lg font-semibold text-brand-terracotta ltr-numerals">
              {depositAmount} {t('SAR', 'ريال')}
            </span>
            <ChevronDown className={`h-4 w-4 text-brand-muted transition-transform ${mobileSummaryOpen ? '' : 'rotate-180'}`} />
          </span>
        </button>
      </div>
    </div>
  );
};
