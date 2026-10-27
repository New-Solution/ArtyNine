/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { PasswordField } from './PasswordField';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { User, Mail, Phone, ArrowRight, ShieldCheck, LogIn, CheckCircle2, Lock , Check, ChevronDown } from 'lucide-react';
import { validateSaudiPhone, normaliseSaudiPhone } from '../utils/phoneUtils';
import { PhoneInput } from './PhoneInput';
import {
  validateCustomerForm, canonicalPhone, canonicalEmail, passwordChecklist
} from '../utils/validation';
import { CheckoutStepper } from './ui/CheckoutStepper';
import { AppImage } from './ui/AppImage';
import { BackButton } from './ui/BackButton';
import { localizedText } from '../utils/localizedText';
import { enumLabel } from '../utils/enumLabels';
import { categoryLabel } from '../utils/categoryLabel';
import { bookingTitleLabel } from '../utils/bookingTitleLabel';
import { timeLabel } from '../utils/availabilityLabel';
import { durationLabel } from '../utils/workshopMetaLabel';
import { PHONE_AUTH_ENABLED } from '../utils/featureFlags';
import { PhoneOtpFlow, PhoneSetupForm } from './PhoneOtpFlow';
import { needsCustomerName } from '../utils/phoneAuth';
import { useTurnstile } from './Turnstile';

export const CheckoutInfoSection: React.FC = () => {
  const {
    pendingBooking, setPendingBooking, setCustomerTab, currentUser, setCurrentUser,
    workshops, loginCustomer, registerCustomer, requestPasswordReset, publishedBirthdayPackages, birthdayPackages, categories,
    phoneSetupPending
  } = useApp();
  const { lang, t } = useLanguage();

  const workshop = workshops.find(w => w.id === pendingBooking?.workshopId) || workshops[0];

  // A birthday reservation is summarised from its own package record, not from a
  // workshop that happens to be first in the list.
  const birthday = pendingBooking?.birthdayDetails;
  const birthdayPackage = birthday?.packageId
    ? publishedBirthdayPackages.find(p => p.id === birthday.packageId)
    : undefined;
  // The Arabic title is looked up strictly by id (not via `workshop`, which falls back to
  // workshops[0]) and, for a birthday, in the FULL package list.
  const titleLabel = pendingBooking ? bookingTitleLabel(pendingBooking, workshops, birthdayPackages, lang) : '';

  const [name, setName] = useState(pendingBooking?.customerName || currentUser?.name || '');
  const [email, setEmail] = useState(pendingBooking?.customerEmail || currentUser?.email || '');
  const [phone, setPhone] = useState(pendingBooking?.customerPhone || currentUser?.phone || '');

  // Reconcile what the customer already entered with their account details:
  // values carried from the booking form win, the account fills the gaps. This
  // is what stops a birthday customer re-typing their name and phone.
  useEffect(() => {
    if (!currentUser) return;

    setName(prev => prev || pendingBooking?.customerName || currentUser.name || '');
    setEmail(prev => prev || pendingBooking?.customerEmail || currentUser.email || '');
    setPhone(prev => prev || pendingBooking?.customerPhone || currentUser.phone || '');

    if (pendingBooking) {
      setPendingBooking({
        ...pendingBooking,
        customerName: pendingBooking.customerName || currentUser.name,
        customerEmail: pendingBooking.customerEmail || currentUser.email,
        customerPhone: pendingBooking.customerPhone || currentUser.phone,
      });
    }
  }, [currentUser]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formGlobalError, setFormGlobalError] = useState<string | null>(null);

  // Phone sign-in (VITE_PHONE_AUTH only). A guest verifies their phone inline
  // instead of creating an email + password account here; a signed-in
  // customer's phone is their account's, read-only. Both stay inert while the
  // flag is off: `phoneFlowActive` stays false and `effectivePhone` is `phone`.
  const [phoneFlowActive, setPhoneFlowActive] = useState(false);
  const showGuestPhoneFlow = PHONE_AUTH_ENABLED && (!currentUser || phoneFlowActive);
  const phoneLocked = PHONE_AUTH_ENABLED && !!currentUser && !phoneFlowActive;
  const effectivePhone = phoneLocked ? (currentUser!.phone || phone) : phone;
  /**
   * A signed-in phone account that left before choosing a password (and name)
   * finishes that first, as on the account page. While the inline flow is on
   * screen its own last step does this job.
   */
  const showPhoneSetup = PHONE_AUTH_ENABLED && phoneSetupPending && !!currentUser && !phoneFlowActive;

  /** Setup saved: show the new name and email straight away; the form takes over once the session updates. */
  const handleSetupSaved = (saved: { name: string; email: string }) => {
    if (!currentUser) return;
    if (saved.name) setName(saved.name.trim());
    if (saved.email) setEmail(saved.email);
    setCurrentUser({ ...currentUser, name: saved.name.trim() || currentUser.name, email: saved.email || currentUser.email });
  };

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  /** The typed account exists but was created without a password. */
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Supabase Auth CAPTCHA (inactive without VITE_TURNSTILE_SITE_KEY): the guest
  // account form, and the sign-in box (sign in and reset link share one).
  const registerCaptcha = useTurnstile();
  const loginCaptcha = useTurnstile();

  const validate = async () => {
    // A signed-in customer is editing their own details, so their own record
    // must not be reported as a duplicate; a guest is creating a new account,
    // where an existing phone or email genuinely is a clash.
    const errs = await validateCustomerForm(
      { name, email, phone: effectivePhone, password, confirmPassword },
      {
        requirePassword: !currentUser,
        excludeId: currentUser?.id,
        allowExistingCustomer: !!currentUser,
        // Email is optional for phone accounts; unchanged (required) otherwise.
        requireEmail: !PHONE_AUTH_ENABLED,
        lang
      }
    );

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormGlobalError(null);
    if (!(await validate())) return;

    // One canonical stored format everywhere.
    const normPhone = canonicalPhone(effectivePhone);
    const normEmail = canonicalEmail(email);

    // If currentUser is not logged in, register account explicitly
    if (!currentUser) {
      const regRes = await registerCustomer({
        name: name.trim(),
        email: normEmail,
        phone: normPhone,
        password: password
      }, registerCaptcha.getToken);

      if (!regRes.success) {
        if (regRes.error?.includes('already exists')) {
          setFormGlobalError(t('An account with these details already exists. Please sign in below to continue.', 'يوجد حساب بهذه البيانات بالفعل. يرجى تسجيل الدخول أدناه للمتابعة.'));
          setLoginEmail(normEmail);
          setIsLoginModalOpen(true);
        } else {
          setFormGlobalError(regRes.error || t('Registration failed.', 'فشل التسجيل.'));
        }
        return;
      }
    } else {
      setCurrentUser({
        ...currentUser,
        name: name.trim(),
        email: normEmail,
        phone: normPhone
      });
    }

    // Update pending booking
    if (pendingBooking) {
      setPendingBooking({
        ...pendingBooking,
        customerName: name.trim(),
        customerEmail: normEmail,
        customerPhone: normPhone
      });
    }

    setCustomerTab('checkout-payment');
  };

  /** Sends a reset link for whatever email is in the modal. */
  const handleModalForgotPassword = async () => {
    setModalError(null);
    setResetSent(null);

    const res = await requestPasswordReset(loginEmail || email, loginCaptcha.getToken);
    if (!res.success) {
      setModalError(res.error || t('Could not send the reset link.', 'تعذّر إرسال رابط إعادة التعيين.'));
      return;
    }
    setResetSent(res.message || t('If an account exists for that address, a reset link is on its way.', 'إذا كان هناك حساب مرتبط بهذا البريد، فسيصلك رابط إعادة التعيين قريبًا.'));
  };

  const handleQuickLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    if (!loginEmail.trim()) return;

    const res = await loginCustomer(loginEmail, loginPassword, loginCaptcha.getToken);
    if (!res.success) {
      setModalError(res.error || t('Login failed.', 'فشل تسجيل الدخول.'));
      // The record exists but has no password. Sending them to the Login page
      // is where the claim step lives.
      setNeedsPasswordSetup(!!res.needsPasswordSetup);
      return;
    }

    setIsLoginModalOpen(false);
  };

  if (!pendingBooking) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h2 className="font-display text-2xl font-semibold text-brand-charcoal">{t('No Workshop Selected', 'لم يتم اختيار ورشة')}</h2>
        <p className="text-sm text-brand-ink mt-2">{t('Please select a workshop from the catalog to book.', 'يرجى اختيار ورشة من الكتالوج للحجز.')}</p>
        <button
          onClick={() => setCustomerTab('workshops')}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-terracotta px-6 py-3 text-sm font-semibold text-brand-cream"
        >
          {t('Browse Workshops', 'تصفح الورش')}
        </button>
      </div>
    );
  }

  const summaryBody = (
    <>
            <div className="flex gap-4">
              <AppImage
                src={birthday ? (birthdayPackage?.image || workshop.image) : workshop.image}
                alt={birthday
                  ? (localizedText(birthdayPackage?.name ?? '', birthdayPackage?.nameAr, lang) || t('Birthday package', 'باقة عيد ميلاد'))
                  : localizedText(workshop.title, workshop.titleAr, lang)}
                className="w-20 h-20 rounded-2xl object-cover shrink-0 bg-brand-sand border border-brand-clay"
              />
              <div>
                <span className="text-[10px] font-semibold text-brand-sage uppercase tracking-wider block">
                  {birthday ? t('Birthday Package', 'باقة عيد ميلاد') : categoryLabel(workshop.category, categories, lang)}
                </span>
                <h4 className="font-semibold text-brand-charcoal text-sm leading-tight">{titleLabel}</h4>
                <p className="text-xs text-brand-ink mt-1">
                  {birthday
                    ? `${localizedText(birthdayPackage?.duration || '', birthdayPackage?.durationAr, lang)}${birthdayPackage?.ageInformation ? ` • ${localizedText(birthdayPackage.ageInformation, birthdayPackage.ageInformationAr, lang)}` : ''}`
                    : `${durationLabel(workshop.duration, lang)} • ${workshop.room.split('(')[0]}`}
                </p>
              </div>
            </div>

            <div className="border-t border-brand-clay pt-3 space-y-2 text-xs text-brand-ink">
              <div className="flex justify-between">
                <span>{t('Date', 'التاريخ')}:</span>
                <span className="font-semibold text-brand-charcoal">{pendingBooking.date}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Time Slot', 'الوقت')}:</span>
                <span className="font-semibold text-brand-charcoal">{timeLabel(pendingBooking.time, lang)}</span>
              </div>
              <div className="flex justify-between">
                <span>{birthday ? t('Guests', 'الضيوف') : t('Participants', 'المشاركون')}:</span>
                {/* ⚠ ARABIC PLURALIZATION — placeholder only, needs a native speaker. */}
                <span className="font-semibold text-brand-charcoal">{pendingBooking.participants} {pendingBooking.participants === 1 ? t('guest', 'ضيف') : t('guests', 'ضيوف')}</span>
              </div>
              <div className="flex justify-between">
                {/* Fallback only — a package with a pricingLabel shows its own.
                    "Per child" here disagreed with the "Price per person" beside
                    it for a workshop, on the same line of the same panel. */}
                <span>{birthday ? localizedText(birthdayPackage?.pricingLabel ? enumLabel('pricingType', birthdayPackage.pricingLabel, lang) : t('Per person', 'للشخص'), birthdayPackage?.pricingLabelAr, lang) : t('Price per person', 'السعر للشخص')}:</span>
                <span className="font-semibold text-brand-charcoal">
                  {birthday ? (birthdayPackage?.price ?? 0) : workshop.price} {t('SAR', 'ريال')}
                </span>
              </div>
              {birthday?.birthdayPersonName && (
                <div className="flex justify-between">
                  <span>{t('Birthday person', 'صاحب عيد الميلاد')}:</span>
                  <span className="font-semibold text-brand-charcoal">{birthday.birthdayPersonName}</span>
                </div>
              )}
            </div>

            <div className="border-t border-brand-clay pt-3 flex justify-between items-center text-brand-charcoal">
              <span className="font-semibold text-sm">{birthday ? t('Deposit Due', 'المقدم المستحق') : t('Total Due', 'الإجمالي المستحق')}:</span>
              <span className="font-serif text-xl font-semibold text-brand-terracotta">{pendingBooking.totalPrice} {t('SAR', 'ريال')}</span>
            </div>
    </>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 animate-in fade-in duration-300 text-start">
      
      {/* Back button — a birthday draft returns to its own Review & Deposit
          step, never to a workshop's details page. */}
      <BackButton onClick={() => setCustomerTab(birthday ? 'birthday-booking' : 'detail')} className="mb-6">
        {birthday ? t('Back to Review & Deposit', 'العودة إلى المراجعة والمقدم') : t('Back to Workshop Details', 'العودة إلى تفاصيل الورشة')}
      </BackButton>

      {/* Title then stepper — the same header the birthday reservation uses. */}
      <div className="mb-8">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage">
          {t('Workshop Booking', 'حجز الورشة')}
        </span>
        <h1 className="mt-3 font-display text-3xl font-semibold text-brand-charcoal sm:text-[42px]">
          {t('Customer Information', 'بيانات العميل')}
        </h1>
        <p className="mt-3 text-sm text-brand-ink">
          {t('Enter your contact details for booking confirmation.', 'أدخل بيانات التواصل لتأكيد الحجز.')}
        </p>
      </div>

      <CheckoutStepper steps={[t('Customer Information', 'بيانات العميل'), t('Payment', 'الدفع')]} current={1} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Form Column */}
        {/* shadow-card, matching the month grid on the workshop detail page —
            the same 0 18px 44px warm shadow, not a new one. The left panel was
            on shadow-card-sm (8px/20px) and the right had none at all, so both
            sat flat against the sand background. Colours, radius, padding and
            border are untouched; only the lift changes. */}
        <div className="lg:col-span-7 bg-brand-cream rounded-[28px] p-6 sm:p-8 border border-brand-clay shadow-card">
          
          {/* Quick Sign in banner if not logged in */}
          {!currentUser ? (
            <div className="mb-6 p-4 bg-brand-sand/50 rounded-[22px] border border-brand-clay flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <LogIn className="h-5 w-5 text-brand-terracotta shrink-0" />
                <div className="text-xs">
                  <p className="font-semibold text-brand-charcoal">{t('Have an account?', 'هل لديك حساب؟')}</p>
                  <p className="text-brand-ink">{t('Sign in to autofill your details and view saved bookings.', 'سجّل الدخول لتعبئة بياناتك تلقائيًا ومشاهدة حجوزاتك المحفوظة.')}</p>
                </div>
              </div>
              <button
                onClick={() => setIsLoginModalOpen(true)}
                className="px-4 py-2 min-h-11 inline-flex items-center justify-center text-xs font-semibold text-brand-terracotta bg-brand-cream border border-brand-terracotta/30 rounded-xl hover:bg-brand-terracotta hover:text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {t('Sign In', 'تسجيل الدخول')}
              </button>
            </div>
          ) : (
            <div className="mb-6 p-3.5 bg-brand-sage/10 rounded-2xl border border-brand-sage/30 flex items-center gap-3 text-xs text-brand-charcoal">
              <CheckCircle2 className="h-4 w-4 text-brand-sage shrink-0" />
              <span>Signed in as <strong>{currentUser.name}</strong> ({PHONE_AUTH_ENABLED && !currentUser.email ? currentUser.phone : currentUser.email})</span>
            </div>
          )}

          {/* Guest + phone sign-in: verify the phone inline (send code -> verify
              -> set password); once signed in, the form below takes over with
              the account's details and the customer continues to payment. */}
          {showPhoneSetup ? (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-xl font-semibold text-brand-charcoal">
                  {t('Finish setting up your account', 'أكمل إعداد حسابك')}
                </h2>
                <p className="mt-1.5 text-sm text-brand-ink">
                  {t('Your number is verified. Choose a password to finish — you will sign in with it and your phone number.',
                     'تم التحقق من رقمك. اختر كلمة مرور لإكمال الإعداد — ستسجّل الدخول بها مع رقم جوالك.')}
                </p>
              </div>
              <PhoneSetupForm
                key={currentUser!.id}
                askName={needsCustomerName(currentUser!.name)}
                welcomeName={currentUser!.name}
                onSaved={handleSetupSaved}
              />
            </div>
          ) : showGuestPhoneFlow ? (
            <div className="space-y-5">
              <PhoneOtpFlow
                purpose="checkout"
                initialPhone={phone}
                onActiveChange={setPhoneFlowActive}
                onDone={() => setPhoneFlowActive(false)}
              />
              <details className="group lg:hidden rounded-2xl border border-brand-clay bg-brand-sand/30">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 truncate text-sm font-semibold text-brand-charcoal">{titleLabel}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-serif text-lg font-semibold text-brand-terracotta">{pendingBooking.totalPrice} {t('SAR', 'ريال')}</span>
                    <ChevronDown className="h-4 w-4 text-brand-muted transition-transform group-[[open]]:rotate-180" />
                  </span>
                </summary>
                <div className="space-y-4 border-t border-brand-clay p-4">{summaryBody}</div>
              </details>
            </div>
          ) : (
          <form onSubmit={handleContinue} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-brand-ink uppercase tracking-wider mb-2">
                {t('Full Name', 'الاسم الكامل')} <span className="text-brand-terracotta">*</span>
              </label>
              <div className="relative">
                <User className="absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-charcoal/40" />
                <input
                  type="text"
                  placeholder={t('e.g. Noura Al-Amri', 'مثال: نورة العمري')}
                  value={name}
                  onChange={e => { setName(e.target.value); if (errors.name) setErrors({...errors, name: ''}); }}
                  className="w-full bg-brand-sand/20 border border-brand-clay rounded-2xl py-3 ps-10 pe-4 text-sm font-semibold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none"
                />
              </div>
              {errors.name && <p className="text-xs text-red-500 mt-1 font-medium">{errors.name}</p>}
            </div>

            <div>
              <label className="block text-xs font-semibold text-brand-ink uppercase tracking-wider mb-2">
                {t('Email Address', 'البريد الإلكتروني')}{' '}
                {PHONE_AUTH_ENABLED
                  ? <span className="normal-case tracking-normal text-brand-muted">{t('(optional)', '(اختياري)')}</span>
                  : <span className="text-brand-terracotta">*</span>}
              </label>
              <div className="relative">
                <Mail className="absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-charcoal/40" />
                {/*
                  type="text", not type="email". The browser validates an
                  type="email" field itself and pops its own tooltip before the
                  submit handler runs, so a malformed address got the native
                  "Please include an '@'" while every other field on this form
                  showed an app message. inputMode keeps the email keyboard on a
                  phone; validateEmailRule does the checking.
                */}
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t('e.g. noura@example.com', 'مثال: noura@example.com')}
                  value={email}
                  onChange={e => { setEmail(e.target.value); if (errors.email) setErrors({...errors, email: ''}); }}
                  className="w-full bg-brand-sand/20 border border-brand-clay rounded-2xl py-3 ps-10 pe-4 text-sm font-semibold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none"
                />
              </div>
              {errors.email && <p className="text-xs text-red-500 mt-1 font-medium">{errors.email}</p>}
            </div>

            {formGlobalError && (
              <div className="mb-4 p-3.5 bg-red-50 border border-red-200 rounded-2xl text-xs font-semibold text-red-700">
                {formGlobalError}
              </div>
            )}

            {/*
              `required` is dropped for the same reason: it made the browser
              claim the field before validatePhoneRule could say "Phone number
              is required." in the app's own voice. The asterisk that `required`
              rendered is kept in the label instead, so nothing looks optional.
            */}
            <PhoneInput
              label={`${t('Saudi Mobile Phone Number', 'رقم الجوال السعودي')} *`}
              value={effectivePhone}
              onChange={val => { setPhone(val); if (errors.phone) setErrors({...errors, phone: ''}); }}
              error={errors.phone}
              disabled={phoneLocked}
            />
            {phoneLocked && (
              <p className="-mt-3 text-[11px] text-brand-muted">
                {t('This is the number on your account. To change it, contact the studio.', 'هذا هو الرقم المسجّل في حسابك. لتغييره، تواصل مع الاستوديو.')}
              </p>
            )}

            {!currentUser && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-brand-ink uppercase tracking-wider mb-2">
                    {t('Account Password', 'كلمة مرور الحساب')} <span className="text-brand-terracotta">*</span>
                  </label>
                  <div className="relative">
                    <Lock className="absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-charcoal/40" />
                    <PasswordField
                      placeholder="••••••••"
                      value={password}
                      onChange={ v => { setPassword(v); if (errors.password) setErrors({...errors, password: ''}); }}
                      className="w-full bg-brand-sand/20 border border-brand-clay rounded-2xl py-3 ps-10 pe-4 text-sm font-semibold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none"
                    />
                  </div>
                  {/* Live checklist, updating as they type. */}
                  <ul className="space-y-0.5 mt-1.5">
                    {passwordChecklist(password, lang).map(item => (
                      <li
                        key={item.label}
                        className={`text-[11px] font-semibold flex items-center gap-1.5 ${
                          item.met ? 'text-brand-sage' : 'text-brand-charcoal/45'
                        }`}
                      >
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                            {item.met
                              ? <Check className="h-3.5 w-3.5" />
                              : <span className="h-1 w-1 rounded-full bg-current opacity-60" />}
                          </span>
                        <span>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                  {errors.password && <p className="text-xs text-red-500 mt-1 font-medium">{errors.password}</p>}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-brand-ink uppercase tracking-wider mb-2">
                    {t('Confirm Password', 'تأكيد كلمة المرور')} <span className="text-brand-terracotta">*</span>
                  </label>
                  <div className="relative">
                    <Lock className="absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-charcoal/40" />
                    <PasswordField
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={ v => { setConfirmPassword(v); if (errors.confirmPassword) setErrors({...errors, confirmPassword: ''}); }}
                      className="w-full bg-brand-sand/20 border border-brand-clay rounded-2xl py-3 ps-10 pe-4 text-sm font-semibold text-brand-charcoal focus:ring-1 focus:ring-brand-terracotta focus:outline-none"
                    />
                  </div>
                  {errors.confirmPassword && <p className="text-xs text-red-500 mt-1 font-medium">{errors.confirmPassword}</p>}
                </div>

                {registerCaptcha.widget}
              </>
            )}

            {/* MOBILE SUMMARY — the right-hand card is hidden below lg, so the
                breakdown would otherwise never be on screen before the customer
                commits. Native <details> rather than state: it carries the
                disclosure semantics and keyboard behaviour for free, and `open`
                expresses the per-step default as markup. Collapsed here; the
                payment step opens it, where the amount is about to be charged. */}
            <details className="group lg:hidden rounded-2xl border border-brand-clay bg-brand-sand/30">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 truncate text-sm font-semibold text-brand-charcoal">{titleLabel}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-serif text-lg font-semibold text-brand-terracotta">{pendingBooking.totalPrice} {t('SAR', 'ريال')}</span>
                  <ChevronDown className="h-4 w-4 text-brand-muted transition-transform group-[[open]]:rotate-180" />
                </span>
              </summary>
              <div className="space-y-4 border-t border-brand-clay p-4">{summaryBody}</div>
            </details>

            <div className="pt-4">
              <button
                type="submit"
                className="w-full cursor-pointer bg-brand-terracotta text-brand-cream font-semibold py-4 rounded-2xl shadow-card-sm hover:bg-brand-terracotta-hover transition-all flex items-center justify-center gap-2 text-base"
              >
                <span>{t('Continue to Payment', 'المتابعة إلى الدفع')}</span>
                <ArrowRight className="h-5 w-5 flip-rtl" />
              </button>
            </div>

            <div className="flex items-center justify-center gap-1.5 text-[11px] text-brand-muted pt-2">
              <ShieldCheck className="h-4 w-4 text-brand-sage" />
              <span>{t('Your contact details are encrypted and used solely for workshop management.', 'بياناتك مشفّرة وتُستخدم فقط لإدارة حجوزات الورش.')}</span>
            </div>
          </form>
          )}

        </div>

        {/* Right Summary Column */}
        <div className="hidden lg:block lg:col-span-5">
          <div className="bg-brand-sand/30 rounded-[28px] p-6 border border-brand-clay shadow-card space-y-4">
            <h3 className="font-display text-lg font-semibold text-brand-charcoal border-b border-brand-clay pb-3">
              {t('Order Summary', 'ملخص الطلب')}
            </h3>

            {summaryBody}
          </div>
        </div>

      </div>

      {/* Quick Login Modal */}
      {isLoginModalOpen && (
        <div className="fixed inset-0 z-50 bg-brand-charcoal/50 backdrop-blur-xs flex items-center justify-center p-4">
          {/* Bounded and scrollable: at 375x667 with the software keyboard up
              this panel is taller than the visible area, and centring it in a
              fixed overlay clipped it at BOTH ends. */}
          <div className="bg-brand-cream rounded-[28px] p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-brand-clay text-start animate-in zoom-in-95 duration-150 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <h3 className="font-display text-xl font-semibold text-brand-charcoal mb-2">{t('Sign In', 'تسجيل الدخول')}</h3>
            <p className="text-xs text-brand-ink mb-4">{t('Enter your email to quickly sign in and autofill your details.', 'أدخل بريدك الإلكتروني لتسجيل الدخول بسرعة وتعبئة بياناتك تلقائيًا.')}</p>
            
            {modalError && (
              <div className="mb-3 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-semibold space-y-2">
                <p>{modalError}</p>
                {needsPasswordSetup && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsLoginModalOpen(false);
                      setCustomerTab('auth');
                    }}
                    className="font-semibold underline cursor-pointer"
                  >
                    {t('Set up your password', 'إعداد كلمة المرور')}
                  </button>
                )}
              </div>
            )}

            <form onSubmit={handleQuickLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-brand-ink mb-1">{t('Email or phone', 'البريد الإلكتروني أو الجوال')}</label>
                <input
                  type="text"
                  required
                  placeholder={`${t('e.g.', 'مثال:')} noura@example.com ${t('or', 'أو')} 0501234567`}
                  value={loginEmail}
                  onChange={e => { setLoginEmail(e.target.value); setModalError(null); }}
                  className="w-full bg-brand-sand/20 border border-brand-clay rounded-xl py-2.5 px-3 text-sm font-semibold text-brand-charcoal"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-brand-ink mb-1">{t('Password', 'كلمة المرور')}</label>
                <PasswordField
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={ v => { setLoginPassword(v); setModalError(null); }}
                  className="w-full bg-brand-sand/20 border border-brand-clay rounded-xl py-2.5 px-3 text-sm font-semibold text-brand-charcoal"
                />
              </div>

              {loginCaptcha.widget}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsLoginModalOpen(false)}
                  className="flex-1 py-2.5 rounded-xl border border-brand-clay text-xs font-semibold text-brand-charcoal hover:bg-brand-sand cursor-pointer"
                >
                  {t('Cancel', 'إلغاء')}
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-brand-terracotta text-xs font-semibold text-brand-cream hover:bg-brand-terracotta-hover cursor-pointer"
                >
                  {t('Sign In', 'تسجيل الدخول')}
                </button>
              </div>

              {/* Forgot password, same as every other sign-in surface. */}
              <div className="pt-1 space-y-2">
                <button
                  type="button"
                  onClick={handleModalForgotPassword}
                  className="text-[11px] font-semibold text-brand-muted hover:text-brand-terracotta cursor-pointer"
                >
                  {t('Forgot password?', 'هل نسيت كلمة المرور؟')}
                </button>
                {/* Worded the same whether or not the address is registered. */}
                {resetSent && (
                  <p className="text-[11px] font-semibold text-brand-sage leading-relaxed">{resetSent}</p>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
