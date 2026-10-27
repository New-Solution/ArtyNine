/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { PasswordField } from './PasswordField';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { ScrollReveal } from './ui/ScrollReveal';
import Reveal from './ui/Reveal';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Palette, Mail, Lock, User, Check, AlertCircle, ArrowLeft, LogIn, KeyRound, ShieldCheck, CheckCircle2, RefreshCw , Pin } from 'lucide-react';
import { PhoneInput } from './PhoneInput';
import { AuthBackdrop } from './AuthBackdrop';
import { validatePhone, normalisePhone } from '../utils/phoneUtils';
import {
  validateCustomerForm, canonicalEmail, canonicalPhone, passwordChecklist,
  validatePasswordRule, validatePasswordConfirmation
} from '../utils/validation';
import { STUDIO_PHONE } from '../utils/studioConfig';
import { bookingTitleLabel } from '../utils/bookingTitleLabel';
import { PHONE_AUTH_ENABLED } from '../utils/featureFlags';
import { PhoneOtpFlow, PhoneSetupForm } from './PhoneOtpFlow';
import { toE164Saudi, needsCustomerName } from '../utils/phoneAuth';
import { supabase } from '../lib/supabase';
import { useTurnstile } from './Turnstile';

/** Staggered fade-up for the title block over the photograph. */
const textVariants = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, delay: 0.1, ease: 'easeOut' as const } }
};

/**
 * The overlay copy, in four parts so the composition is a hierarchy rather
 * than one large caption: a small sans kicker, the serif line that carries the
 * meaning, an emphasised close, and a quiet supporting sentence.
 *
 * Both tabs use the same four slots, so switching changes the words and never
 * the shape of the block. Placeholder wording — the studio edits these.
 */
const AUTH_OVERLAY = {
  login: {
    kicker: 'Returning maker',
    lead: 'Where clay',
    accent: 'meets calm.',
    support: 'Your wheel, your shelf, and every piece you have made are waiting.'
  },
  register: {
    kicker: 'Your first piece',
    lead: 'Every masterpiece begins with',
    accent: 'a single touch of clay.',
    support: 'Follow each piece from the wheel to the kiln to the shelf.'
  }
} as const;

/** Each line arrives just behind the one above it. */
const overlayLineVariants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] as const } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.25 } }
};

/** The form swapping between logging in and signing up. */
const formVariants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
  exit: { opacity: 0, x: -20, transition: { duration: 0.2, ease: 'easeIn' as const } }
};

export const AuthSection: React.FC = () => {
  const { 
    authScreen, setAuthScreen, currentUser, setCurrentUser, setCustomerTab, sessionExpired, 
    loginCustomer, claimCustomerAccount, registerCustomer, requestPasswordReset,
    logoutCustomer, pendingBooking, changeCustomerPassword,
    workshops, birthdayPackages, phoneSetupPending
  } = useApp();
  const { lang, t } = useLanguage();

  // Common Inputs
  const [email, setEmail] = useState('');
  const [loginIdentifier, setLoginIdentifier] = useState(''); // Email or Phone
  /**
   * Sign In's password. Create Account has its own (`registerPassword`) below.
   *
   * They shared one state, so typing a password on Sign In and switching tabs
   * showed it pre-filled on Create Account. Separate state rather than clearing
   * on tab change: there are six places that switch screens, and a future
   * seventh would silently reintroduce the leak.
   */
  const [password, setPassword] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** Set when the typed account exists but has no password yet. */
  const [claimIdentifier, setClaimIdentifier] = useState<string | null>(null);
  const [claimPassword, setClaimPassword] = useState('');
  const [claimConfirm, setClaimConfirm] = useState('');
  /** Masked form of the address on the record, e.g. "n****a@gmail.com". */
  const [claimEmailHint, setClaimEmailHint] = useState<string | null>(null);
  /** Typed when claiming by phone: the account needs an address to confirm. */
  const [claimEmail, setClaimEmail] = useState('');
  // Field-keyed messages from the shared validation layer.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clearError = (key: string) =>
    setErrors(prev => (prev[key] ? { ...prev, [key]: '' } : prev));
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Supabase Auth CAPTCHA — one widget per form (inactive without VITE_TURNSTILE_SITE_KEY).
  const loginCaptcha = useTurnstile();
  const claimCaptcha = useTurnstile();
  const registerCaptcha = useTurnstile();
  const resetCaptcha = useTurnstile();

  // Change-password state for the account page.
  const prefersReducedMotion = useReducedMotion();
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  /** Sets a new password for whoever is signed in. Nothing else is editable. */
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordMsg(null);

    const match = validatePasswordConfirmation(newPassword, confirmNewPassword, lang);
    if (!match.valid) {
      setPasswordError(match.error!);
      return;
    }

    setIsSavingPassword(true);
    try {
      const res = await changeCustomerPassword(newPassword);
      if (!res.success) {
        setPasswordError(res.error || t('Could not change your password.', 'تعذّر تغيير كلمة المرور.'));
        return;
      }
      setShowPasswordForm(false);
      setNewPassword('');
      setConfirmNewPassword('');
      setPasswordMsg(t('Your password has been changed. Use it next time you sign in.', 'تم تغيير كلمة المرور. استخدمها في المرة القادمة لتسجيل الدخول.'));
    } catch {
      setPasswordError(t('Something went wrong. Please try again.', 'حدث خطأ ما. يرجى المحاولة مرة أخرى.'));
    } finally {
      setIsSavingPassword(false);
    }
  };

  // Phone sign-in by SMS code (VITE_PHONE_AUTH only; all three stay false/empty while it is off).
  /** "Get a code instead" opened from Sign In. */
  const [phoneCodeOpen, setPhoneCodeOpen] = useState(false);
  /** Pre-fills the phone step when the visitor already typed a number. */
  const [phoneCodeInitial, setPhoneCodeInitial] = useState('');
  /**
   * True while the phone flow holds a fresh session but has not finished. The
   * account page would otherwise replace the flow the moment currentUser is set,
   * before the password step.
   */
  const [phoneFlowActive, setPhoneFlowActive] = useState(false);

  const openPhoneCode = (identifier?: string) => {
    setErrorMsg(null);
    setPhoneCodeInitial(identifier && toE164Saudi(identifier) ? identifier : '');
    setPhoneCodeOpen(true);
  };

  /**
   * Whether the signed-in account signs in by phone (Supabase confirmed its
   * number). Its phone is the sign-in identifier, so it is not changed from
   * here. Read from the local session only — no request.
   */
  const [isPhoneAccount, setIsPhoneAccount] = useState(false);
  useEffect(() => {
    if (!PHONE_AUTH_ENABLED) return;
    if (!currentUser || !supabase) { setIsPhoneAccount(false); return; }
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setIsPhoneAccount(!!data.session?.user?.phone_confirmed_at);
    });
    return () => { cancelled = true; };
  }, [currentUser]);

  /** Where a finished phone flow goes — the same places a password sign-in goes. */
  const handlePhoneFlowDone = () => {
    setPhoneCodeOpen(false);
    setPhoneFlowActive(false);
    if (pendingBooking) setCustomerTab('checkout-info');
    else setCustomerTab('my-bookings');
  };

  /** "Finish setting up" saved: show the new name straight away, then go where a finished flow goes. */
  const handleSetupSaved = (saved: { name: string; email: string }) => {
    if (currentUser) {
      setCurrentUser({ ...currentUser, name: saved.name || currentUser.name, email: saved.email || currentUser.email });
    }
    handlePhoneFlowDone();
  };

  // Password Recovery States
  const [forgotMethod, setForgotMethod] = useState<'email' | 'phone'>('email');
  /** The non-committal confirmation shown after a reset request. */
  const [resetSent, setResetSent] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);

    const loginInput = loginIdentifier || email;
    const res = await loginCustomer(loginInput, password, loginCaptcha.getToken);
    setIsSubmitting(false);

    if (!res.success) {
      // The record exists but was created at the counter without a password.
      // Offer to claim it rather than leaving them stuck.
      if (res.needsPasswordSetup) {
        setClaimIdentifier(loginInput);
        setClaimPassword('');
        setClaimConfirm('');
        setClaimEmail('');
        setClaimEmailHint(res.claimEmailHint || null);
      }
      setErrorMsg(res.error || 'Invalid credentials.');
      return;
    }

    if (pendingBooking) {
      setCustomerTab('checkout-info');
    } else {
      setCustomerTab('my-bookings');
    }
  };

  /** Attaches a password to the existing record — never creates a new one. */
  const handleClaimAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const match = validatePasswordConfirmation(claimPassword, claimConfirm, lang);
    if (!match.valid) {
      setErrorMsg(match.error!);
      return;
    }

    setIsSubmitting(true);
    // Claiming by phone needs an address for the confirmation link; claiming by
    // email already has one.
    const res = await claimCustomerAccount(claimIdentifier || '', claimPassword, claimEmail || undefined, claimCaptcha.getToken);
    setIsSubmitting(false);

    if (!res.success) {
      setErrorMsg(res.error || 'Could not set up your password.');
      return;
    }

    setClaimIdentifier(null);
    setClaimPassword('');
    setClaimConfirm('');
    setClaimEmail('');
    setClaimEmailHint(null);
    setPassword('');
    setRegisterPassword('');
    if (pendingBooking) setCustomerTab('checkout-info');
    else setCustomerTab('my-bookings');
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Every rule comes from the shared validation layer, including the
    // duplicate phone/email checks against the customers table.
    const fieldErrors = await validateCustomerForm(
      { name: fullName, email, phone, password: registerPassword, confirmPassword },
      { requirePassword: true, lang }
    );
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setIsSubmitting(true);
    const res = await registerCustomer({
      name: fullName.trim(),
      // Stored in the one canonical format, so duplicate checks match later.
      email: canonicalEmail(email),
      phone: canonicalPhone(phone),
      password: registerPassword
    }, registerCaptcha.getToken);
    setIsSubmitting(false);

    if (!res.success) {
      setErrorMsg(res.error || 'Registration failed.');
      return;
    }

    if (pendingBooking) {
      setCustomerTab('checkout-info');
    } else {
      setCustomerTab('my-bookings');
    }
  };

  // Step 1: Request Password Recovery Code
  /**
   * Sends the reset link through Supabase Auth.
   *
   * Auth is the proof of ownership — only whoever can open the inbox finishes
   * the reset. The flow this replaces accepted a hardcoded "123456" code, so
   * anyone could reset any account.
   *
   * The confirmation reads the same whether or not the address is registered,
   * so it cannot be used to discover which emails exist.
   */
  const handleRequestPasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setResetSent(null);
    setIsSubmitting(true);

    const res = await requestPasswordReset(email, resetCaptcha.getToken);
    setIsSubmitting(false);

    if (!res.success) {
      setErrorMsg(res.error || 'Could not send the reset link.');
      return;
    }
    setResetSent(res.message || 'If an account exists for that address, a reset link is on its way.');
  };

  // FINISH SETTING UP — a signed-in phone account that left before choosing a
  // password (and name). Replaces Sign In, Create Account and the account page
  // until it is finished; the only other way out is signing out. While the
  // phone flow itself is on screen, its own last step does this job.
  if (PHONE_AUTH_ENABLED && phoneSetupPending && !phoneFlowActive) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-10 sm:py-16 animate-in fade-in duration-300">
        <div className="rounded-[28px] border border-brand-clay bg-white p-6 sm:p-8 shadow-card-sm text-start space-y-5">
          <div>
            <h1 className="font-display text-2xl font-semibold text-brand-charcoal">
              {t('Finish setting up your account', 'أكمل إعداد حسابك')}
            </h1>
            <p className="mt-1.5 text-sm text-brand-ink">
              {t('Your number is verified. Choose a password to finish — you will sign in with it and your phone number.',
                 'تم التحقق من رقمك. اختر كلمة مرور لإكمال الإعداد — ستسجّل الدخول بها مع رقم جوالك.')}
            </p>
          </div>
          {currentUser ? (
            <PhoneSetupForm
              key={currentUser.id}
              askName={needsCustomerName(currentUser.name)}
              welcomeName={currentUser.name}
              onSaved={handleSetupSaved}
            />
          ) : (
            <p className="text-sm text-brand-muted">{t('Loading your account...', 'جارٍ تحميل حسابك...')}</p>
          )}
          <button
            type="button"
            onClick={() => void logoutCustomer()}
            className="w-full cursor-pointer text-xs font-semibold text-brand-muted hover:underline"
          >
            {t('Sign out', 'تسجيل الخروج')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        currentUser && !phoneFlowActive
          ? 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 animate-in fade-in duration-300'
          : // Signed out, the page is a split screen and each half sets its own
            // padding — no shared gutter here.
            'w-full animate-in fade-in duration-300'
      }
    >

      {/* ACCOUNT DETAILS — read-only profile; the only thing changeable
          here is the password. Held back while a phone flow is mid-way
          (phoneFlowActive is always false without VITE_PHONE_AUTH). */}
      {currentUser && !phoneFlowActive ? (
        <div className="mx-auto max-w-2xl space-y-6">

          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.2, margin: '0px 0px -80px 0px' }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
          >
            <div className="text-start">
              <h1 className="font-display text-3xl sm:text-4xl font-semibold text-brand-charcoal">
                {t('Account Details', 'تفاصيل الحساب')}
              </h1>
              <p className="mt-2 text-brand-ink">{t('Manage your Arty Café profile', 'إدارة ملفك الشخصي في آرتي كافيه')}</p>
            </div>
          </ScrollReveal>

          {/* Avatar + name */}
          <ScrollReveal
            once
            viewOptions={{ once: true, amount: 0.2, margin: '0px 0px -80px 0px' }}
            transition={{ delay: 0.12, duration: 0.5, ease: 'easeOut' }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }}
          >
            <div className="flex items-center gap-4 rounded-[28px] border border-brand-clay bg-white p-6 shadow-card-sm text-start">
              <div
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-terracotta font-display text-2xl font-semibold text-brand-cream"
                aria-hidden="true"
              >
                {(currentUser.name || currentUser.email || '?').trim().charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="font-display text-xl font-semibold text-brand-charcoal truncate">
                  {currentUser.name || t('Your account', 'حسابك')}
                </p>
                <p className="mt-0.5 text-sm text-brand-muted truncate">{currentUser.email}</p>
              </div>
            </div>
          </ScrollReveal>

          {/* Read-only profile. Deliberately not inputs — these are changed by
              the studio, not here. */}
          {/* On mount, not on scroll. This page is a destination — someone
              opened it to do one thing — so its panels must not wait to be
              scrolled into view. Same Reveal the headings above already use. */}
          <Reveal
            onMount
            index={2}
          >
            <div className="rounded-[28px] border border-brand-clay bg-white p-6 sm:p-7 shadow-card-sm text-start">
              <h2 className="font-display text-lg font-semibold text-brand-charcoal">{t('Profile', 'الملف الشخصي')}</h2>
              <p className="mt-1 text-xs text-brand-muted">
                {t('Ask the studio if any of these need changing.', 'اسأل الاستوديو إذا كنت بحاجة لتغيير أي من هذه البيانات.')}
              </p>

              <dl className="mt-5 text-sm">
                {[
                  { label: t('Full Name', 'الاسم الكامل'), value: currentUser.name },
                  { label: t('Email Address', 'البريد الإلكتروني'), value: currentUser.email },
                  { label: t('Phone Number', 'رقم الجوال'), value: currentUser.phone }
                ].map(row => (
                  <div key={row.label} className="border-t border-brand-clay py-4 last:border-b">
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">
                      {row.label}
                    </dt>
                    <dd className={`mt-1.5 break-words ${row.value ? 'text-brand-charcoal ltr-numerals' : 'text-brand-muted italic'}`}>
                      {row.value || t('Not on file', 'غير مسجّل')}
                    </dd>
                  </div>
                ))}
              </dl>
              {isPhoneAccount && (
                <p className="mt-3 text-[11px] text-brand-muted">
                  {t('You sign in with this phone number, so it cannot be changed here. To change it, contact the studio.',
                     'تسجّل الدخول برقم الجوال هذا، لذا لا يمكن تغييره من هنا. لتغييره، تواصل مع الاستوديو.')}
                </p>
              )}
            </div>
          </Reveal>

          {/* The one action: a new password. */}
          {/* A form the customer navigated here specifically to use. */}
          <Reveal
            onMount
            index={3}
          >
            <div className="rounded-[28px] border border-brand-clay bg-white p-6 sm:p-7 shadow-card-sm text-start">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-lg font-semibold text-brand-charcoal">{t('Password', 'كلمة المرور')}</h2>
                  <p className="mt-1 text-xs text-brand-muted">
                    {t('Choose a new password for signing in.', 'اختر كلمة مرور جديدة لتسجيل الدخول.')}
                  </p>
                </div>
                {!showPasswordForm && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowPasswordForm(true);
                      setPasswordMsg(null);
                      setPasswordError(null);
                    }}
                    className="shrink-0 cursor-pointer rounded-full border border-brand-clay bg-brand-cream px-5 py-2.5 text-sm font-semibold text-brand-charcoal transition-colors hover:bg-brand-clay-soft"
                  >
                    {t('Change Password', 'تغيير كلمة المرور')}
                  </button>
                )}
              </div>

              {showPasswordForm && (
                <form onSubmit={handleChangePassword} className="mt-5 space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-brand-ink">{t('New password', 'كلمة المرور الجديدة')} *</label>
                    <PasswordField
                      required
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={v => { setNewPassword(v); setPasswordError(null); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3 px-4 text-sm font-semibold text-brand-charcoal"
                    />
                    <ul className="space-y-0.5 pt-0.5">
                      {passwordChecklist(newPassword, lang).map(item => (
                        <li
                          key={item.label}
                          className={`text-[11px] font-semibold flex items-center gap-1.5 ${
                            item.met ? 'text-brand-sage' : 'text-brand-muted'
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
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-brand-ink">{t('Confirm new password', 'تأكيد كلمة المرور الجديدة')} *</label>
                    <PasswordField
                      required
                      placeholder="••••••••"
                      value={confirmNewPassword}
                      onChange={v => { setConfirmNewPassword(v); setPasswordError(null); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3 px-4 text-sm font-semibold text-brand-charcoal"
                    />
                  </div>

                  {passwordError && (
                    <p className="text-xs font-semibold text-red-600">{passwordError}</p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      disabled={isSavingPassword}
                      className="cursor-pointer rounded-full bg-brand-terracotta px-6 py-3 text-sm font-semibold text-brand-cream shadow-button transition-colors hover:bg-brand-terracotta-hover disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSavingPassword ? t('Saving…', 'جارٍ الحفظ…') : t('Save new password', 'حفظ كلمة المرور الجديدة')}
                    </button>
                    <button
                      type="button"
                      disabled={isSavingPassword}
                      onClick={() => {
                        setShowPasswordForm(false);
                        setNewPassword('');
                        setConfirmNewPassword('');
                        setPasswordError(null);
                      }}
                      className="cursor-pointer rounded-full border border-brand-clay px-5 py-3 text-sm font-semibold text-brand-muted transition-colors hover:bg-brand-sand/40 disabled:opacity-50"
                    >
                      {t('Cancel', 'إلغاء')}
                    </button>
                  </div>
                </form>
              )}

              {passwordMsg && (
                <p className="mt-4 rounded-xl border border-brand-sage-line bg-brand-sage-soft px-4 py-3 text-xs font-semibold text-brand-sage-hover">
                  {passwordMsg}
                </p>
              )}
            </div>
          </Reveal>

          {/* Actions */}
          {/* Log Out lives in here. It sat below the fold on a short window,
              invisible until scrolled to and then delayed a further 0.48s —
              the control people look for when they cannot find anything else. */}
          <Reveal
            onMount
            index={4}
          >
            <div className="space-y-3">
              {pendingBooking && (
                <div className="rounded-[22px] border border-brand-clay bg-brand-sand/40 p-4 text-xs font-semibold text-brand-charcoal text-start">
                  <Pin className="inline h-3.5 w-3.5 me-1 align-[-2px]" />
                  {t('You have an active booking draft for:', 'لديك مسودة حجز نشطة لـ:')}{' '}
                  <span className="text-brand-terracotta">{bookingTitleLabel(pendingBooking, workshops, birthdayPackages, lang)}</span> ({pendingBooking.date})
                </div>
              )}

              {/* Centred rather than a two-column grid. "View My Bookings" is
                  gone — My Bookings is already in the main nav — which left Log
                  Out as the orphaned half of a `flex-1` row, stretched across
                  the full width for no reason.

                  The same element still renders as "Continue Booking" when a
                  draft exists. That is a different button wearing the same
                  markup: it returns to checkout, not to the bookings list, and
                  nothing in the nav does it. Removing it outright would leave
                  the notice above saying "you have an active booking draft"
                  with no way to reach it. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                {pendingBooking && (
                  <button
                    onClick={() => setCustomerTab('checkout-info')}
                    className="cursor-pointer rounded-full bg-brand-terracotta px-6 py-3.5 text-sm font-semibold text-brand-cream shadow-button transition-colors hover:bg-brand-terracotta-hover sm:min-w-[220px]"
                  >
                    {t('Continue Booking', 'متابعة الحجز')}
                  </button>
                )}
                <button
                  onClick={() => {
                    logoutCustomer();
                    setAuthScreen('login');
                  }}
                  className="cursor-pointer rounded-full border border-brand-clay bg-brand-cream px-6 py-3.5 text-sm font-semibold text-brand-charcoal transition-colors hover:bg-brand-clay-soft sm:min-w-[220px]"
                >
                  {t('Log Out', 'تسجيل الخروج')}
                </button>
              </div>
            </div>
          </Reveal>

        </div>
      ) : (
        /* SPLIT SCREEN: the slideshow and the title on one half, the form on a
           solid panel on the other. On phones the halves stack — the image
           becomes a banner rather than a full screen, so the fields are not
           pushed below the fold.

           `items-start` is what decouples the two columns: a grid item
           stretches to the tallest row by default, which is why the taller
           sign-up form was making the image column grow and re-crop the
           photograph. */
        <div className="grid grid-cols-1 items-start lg:grid-cols-2 lg:min-h-[calc(100vh-5rem)]">

        {/* IMAGE HALF. The slideshow is contained to this column, so the form
            never sits over a moving photograph. */}
        {/* Fixed to the viewport below the header on desktop, so the crop is
            identical whichever form is showing, and pinned while a longer form
            scrolls past it. */}
        <div className="relative overflow-hidden flex items-end justify-center h-[40vh] min-h-[260px] p-6 sm:p-10 lg:sticky lg:top-20 lg:h-[calc(100vh-5rem)] lg:min-h-[calc(100vh-5rem)] lg:p-14">
          <AuthBackdrop />

          {/* EDITORIAL OVERLAY — a kicker, a rule, the serif line, then the
              supporting sentence. Anchored to the lower-left of the frame and
              held to a narrow measure so it reads as part of the photograph
              rather than a caption laid across it.

              Keyed on the screen so the tab swap plays, and `wait` so the two
              never overlap on top of a moving image. The stagger comes from the
              parent; the shadow is what keeps it legible as the slideshow moves
              underneath, since the scrim alone is not enough for text this
              size. */}
          <AnimatePresence mode="wait" initial={false}>
            {(authScreen === 'login' || authScreen === 'register') && (() => {
              const copy = AUTH_OVERLAY[authScreen];
              return (
                <motion.figure
                  key={authScreen}
                  initial={prefersReducedMotion ? false : 'initial'}
                  animate="animate"
                  exit={prefersReducedMotion ? undefined : 'exit'}
                  variants={{
                    animate: { transition: { staggerChildren: prefersReducedMotion ? 0 : 0.08 } },
                    exit: { transition: { staggerChildren: 0 } }
                  }}
                  className="relative z-10 w-full max-w-lg text-center lg:text-start auth-heading-shadow"
                >
                  {/* Kicker — sans, wide-tracked, sage. The one accent colour. */}
                  <motion.figcaption
                    variants={overlayLineVariants}
                    className="flex items-center justify-center gap-3 lg:justify-start"
                  >
                    <span className="hidden h-px w-10 bg-brand-sage/70 lg:block" aria-hidden="true" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-brand-sage">
                      {copy.kicker}
                    </span>
                  </motion.figcaption>

                  {/* The line itself. The close is set in italic so the phrase
                      turns without needing a second size or weight. */}
                  <motion.blockquote
                    variants={overlayLineVariants}
                    className="auth-title mt-5 text-[30px] leading-[1.12] text-brand-cream sm:text-[40px] lg:text-[46px]"
                  >
                    {copy.lead}{' '}
                    <span className="italic text-brand-cream/90">{copy.accent}</span>
                  </motion.blockquote>

                  <motion.div
                    variants={overlayLineVariants}
                    aria-hidden="true"
                    className="mx-auto mt-7 h-px w-16 bg-brand-cream/35 lg:mx-0"
                  />

                  <motion.p
                    variants={overlayLineVariants}
                    className="mx-auto mt-5 max-w-sm text-sm font-medium leading-relaxed text-brand-cream/75 lg:mx-0"
                  >
                    {copy.support}
                  </motion.p>

                  <motion.p
                    variants={overlayLineVariants}
                    className="mt-8 text-[10px] font-semibold uppercase tracking-[0.28em] text-brand-cream/45"
                  >
                    Arty Café · Jeddah
                  </motion.p>
                </motion.figure>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* FORM HALF — a solid panel, so the fields read against a flat
            surface rather than a photograph. */}
        <div className="flex min-h-full items-center justify-center bg-brand-cream px-4 py-10 sm:px-8 lg:min-h-[calc(100vh-5rem)] lg:px-14 lg:py-16">
        {/* `layout` animates the height between the two forms. The fixed
            min-height it replaces was the resize bug: it held the card at
            550px whatever the login form actually needed, so returning from
            the taller sign-up form left dead space below the fields. The card
            now sizes to its own content in both directions. */}
        <motion.div
          layout={!prefersReducedMotion}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="w-full max-w-md"
        >

          {/* TABS — the primary switch between the two forms. Password
              recovery is reached from inside the sign-in form, so it is not a
              tab: it is a detour, not a third destination. The pill slides
              between them with a shared layout id rather than a width
              transition, so it tracks whatever the labels measure. */}
          {(authScreen === 'login' || authScreen === 'register') && (
            <div
              role="tablist"
              aria-label={t('Account', 'الحساب')}
              className="mb-8 grid grid-cols-2 gap-1 rounded-full border border-brand-clay bg-brand-sand/50 p-1"
            >
              {([
                { screen: 'login' as const, label: t('Sign In', 'تسجيل الدخول') },
                { screen: 'register' as const, label: t('Create Account', 'إنشاء حساب') }
              ]).map(tab => {
                const isOn = authScreen === tab.screen;
                return (
                  <button
                    key={tab.screen}
                    type="button"
                    role="tab"
                    aria-selected={isOn}
                    onClick={() => { setErrorMsg(null); setAuthScreen(tab.screen); }}
                    className={`relative cursor-pointer rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
                      isOn ? 'text-brand-cream' : 'text-brand-ink hover:text-brand-charcoal'
                    }`}
                  >
                    {isOn && (
                      <motion.span
                        layoutId={prefersReducedMotion ? undefined : 'auth-tab-pill'}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                        className="absolute inset-0 rounded-full bg-brand-terracotta"
                      />
                    )}
                    <span className="relative">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Keyed on the screen so the outgoing form actually plays its exit
              before the incoming one arrives — without a changing key React
              would reuse the node and neither transition would run. `wait`
              keeps the two forms from overlapping while the card resizes. */}
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={authScreen}
            variants={formVariants}
            initial={prefersReducedMotion ? false : 'initial'}
            animate="animate"
            exit={prefersReducedMotion ? undefined : 'exit'}
            className="flex flex-col justify-center text-start"
          >

            {/*
              Shown above any form error: it explains why the customer is
              looking at this screen at all, which no field-level message can.
            */}
            {sessionExpired && !errorMsg && (
              <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                <p>{t('Your session expired, please sign in again.', 'انتهت جلستك، يرجى تسجيل الدخول مرة أخرى.')}</p>
              </div>
            )}

            {errorMsg && (
              <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
                <div className="flex-1">
                  <p>{errorMsg}</p>
                  {/* A failed email sign-in, whatever the reason, so it reveals
                      nothing: a phone account's email is not a sign-in. */}
                  {PHONE_AUTH_ENABLED && authScreen === 'login' && !phoneCodeOpen && (loginIdentifier || email).includes('@') && (
                    <p className="mt-1 font-medium">
                      {t('Signed up with your phone? Sign in with your phone number instead.', 'سجلت برقم جوالك؟ سجّل الدخول برقم الجوال بدلًا من الإيميل.')}
                    </p>
                  )}
                  {errorMsg.includes('already exists') && (
                    <button
                      type="button"
                      onClick={() => { setErrorMsg(null); setAuthScreen('login'); }}
                      className="mt-2 text-xs font-semibold text-red-800 underline cursor-pointer"
                    >
                      {t('Click here to Sign In', 'اضغط هنا لتسجيل الدخول')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* PHONE CODE FLOW opened from Sign In (VITE_PHONE_AUTH only). */}
            {PHONE_AUTH_ENABLED && authScreen === 'login' && phoneCodeOpen && (
              <PhoneOtpFlow
                purpose="account"
                initialPhone={phoneCodeInitial}
                onActiveChange={setPhoneFlowActive}
                onDone={handlePhoneFlowDone}
                onCancel={() => { setPhoneCodeOpen(false); setPhoneFlowActive(false); setErrorMsg(null); }}
              />
            )}

            {/* 1. LOGIN SCREEN */}
            {authScreen === 'login' && !phoneCodeOpen && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-display text-3xl font-semibold text-brand-charcoal">{t('Welcome back', 'مرحبًا بعودتك')}</h2>
                  <p className="mt-1.5 text-sm text-brand-ink">
                    {t('Access your bookings and pottery pieces tracker.', 'اطّلع على حجوزاتك ومتتبع قطعك الفخارية.')}
                  </p>
                </div>

                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Email address or Phone number', 'البريد الإلكتروني أو رقم الجوال')}</label>
                    <input
                      type="text"
                      required
                      placeholder={`${t('e.g.', 'مثال:')} noura@amri.sa ${t('or', 'أو')} +966501234567`}
                      value={loginIdentifier}
                      onChange={e => { setLoginIdentifier(e.target.value); setErrorMsg(null); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-bold text-brand-charcoal/80">{t('Password', 'كلمة المرور')}</label>
                      <button
                        type="button"
                        onClick={() => {
                          setErrorMsg(null);
                          setAuthScreen('forgot');
                          setResetSent(null);
                        }}
                        className="text-xs font-semibold text-brand-terracotta hover:underline cursor-pointer"
                      >
                        {t('Forgot password?', 'هل نسيت كلمة المرور؟')}
                      </button>
                    </div>
                    <PasswordField
                      required
                      placeholder="••••••••"
                      value={password}
                      onChange={ v => { setPassword(v); setErrorMsg(null); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                  </div>

                  {loginCaptcha.widget}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full cursor-pointer rounded-full bg-brand-terracotta py-3.5 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors shadow-card-sm mt-2 flex items-center justify-center gap-2"
                  >
                    <LogIn className="h-4 w-4" />
                    <span>{isSubmitting ? t('Signing in...', 'جارٍ تسجيل الدخول...') : t('Log In', 'تسجيل الدخول')}</span>
                  </button>
                </form>

                {/* Phone sign-in on: a code instead of a password — first-time
                    set-up, a studio-made record, or a forgotten password. */}
                {PHONE_AUTH_ENABLED && (
                  <button
                    type="button"
                    onClick={() => openPhoneCode(loginIdentifier)}
                    className="w-full cursor-pointer rounded-full border border-brand-clay py-3 text-sm font-semibold text-brand-charcoal hover:bg-brand-sand/40 transition-colors flex items-center justify-center gap-2"
                  >
                    <KeyRound className="h-4 w-4" />
                    <span>{t('Get a code instead', 'احصل على رمز بدلًا من ذلك')}</span>
                  </button>
                )}

                {/* Claim an account created at the counter. The password is
                    attached to that existing record, so their bookings, visits
                    and pottery stay on one customer. Replaced by the code flow
                    when phone sign-in is on. */}
                {!PHONE_AUTH_ENABLED && claimIdentifier && (
                  <form onSubmit={handleClaimAccount} className="space-y-3 p-4 bg-brand-sand/30 border border-brand-clay rounded-2xl">
                    <div>
                      <h3 className="text-sm font-semibold text-brand-charcoal">{t('Set up your password', 'إعداد كلمة المرور')}</h3>
                      <p className="text-[11px] text-brand-muted mt-0.5 leading-relaxed">
                        {t('We already have', 'لدينا بالفعل')} <span className="font-semibold">{claimIdentifier}</span> {t(
                          'on file from a visit or booking. Choose a password to claim that account — your history stays with it.',
                          'مسجل من زيارة أو حجز سابق. اختر كلمة مرور للمطالبة بهذا الحساب — سجلك سيبقى معه.'
                        )}
                      </p>
                    </div>

                    {/* Claiming by phone: the account is created against an
                        address, and the confirmation link proves it is yours.
                        It has to be the address already on the record. */}
                    {!claimIdentifier.includes('@') && (
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-brand-charcoal/80">{t('Your email address', 'بريدك الإلكتروني')} *</label>
                        <input
                          type="email"
                          required
                          value={claimEmail}
                          onChange={e => { setClaimEmail(e.target.value); setErrorMsg(null); }}
                          placeholder={claimEmailHint || 'you@example.com'}
                          className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3 px-4 text-sm font-semibold text-brand-charcoal"
                        />
                        <p className="text-[11px] text-brand-muted leading-relaxed">
                          {claimEmailHint
                            ? t(
                                `Use the address on your record — it looks like ${claimEmailHint}. We will send a confirmation link to it.`,
                                `استخدم البريد المسجل لديك — يبدو أنه ${claimEmailHint}. سنرسل رابط تأكيد إليه.`
                              )
                            : t(
                                'We will send a confirmation link to this address to finish claiming your account.',
                                'سنرسل رابط تأكيد إلى هذا البريد لإتمام المطالبة بحسابك.'
                              )}
                        </p>
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-brand-charcoal/80">{t('New password', 'كلمة المرور الجديدة')} *</label>
                      <PasswordField
                        required
                        placeholder="••••••••"
                        value={claimPassword}
                        onChange={ v => { setClaimPassword(v); setErrorMsg(null); }}
                        className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3 px-4 text-sm font-semibold text-brand-charcoal"
                      />
                      <ul className="space-y-0.5 pt-0.5">
                        {passwordChecklist(claimPassword, lang).map(item => (
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
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-brand-charcoal/80">{t('Confirm password', 'تأكيد كلمة المرور')} *</label>
                      <PasswordField
                        required
                        placeholder="••••••••"
                        value={claimConfirm}
                        onChange={ v => { setClaimConfirm(v); setErrorMsg(null); }}
                        className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3 px-4 text-sm font-semibold text-brand-charcoal"
                      />
                    </div>

                    {claimCaptcha.widget}

                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="flex-1 cursor-pointer rounded-full bg-brand-terracotta py-3 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors disabled:opacity-50"
                      >
                        {isSubmitting ? t('Saving...', 'جارٍ الحفظ...') : t('Set password & continue', 'تعيين كلمة المرور والمتابعة')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setClaimIdentifier(null); setErrorMsg(null); }}
                        className="px-4 rounded-full border border-brand-clay text-xs font-semibold text-brand-muted cursor-pointer hover:bg-brand-sand/40"
                      >
                        {t('Cancel', 'إلغاء')}
                      </button>
                    </div>
                  </form>
                )}

                <div className="text-center pt-2">
                  <p className="text-xs font-medium text-brand-ink">
                    {t('New here?', 'جديد هنا؟')}{' '}
                    <button
                      onClick={() => { setErrorMsg(null); setAuthScreen('register'); }}
                      className="text-brand-terracotta font-semibold hover:underline cursor-pointer"
                    >
                      {t('Create an account', 'إنشاء حساب')}
                    </button>
                  </p>
                </div>
              </div>
            )}

            {/* 2. REGISTRATION — phone sign-in on: new accounts start with a
                texted code (the same flow claims a studio-made record). */}
            {PHONE_AUTH_ENABLED && authScreen === 'register' && (
              <div className="space-y-6">
                <PhoneOtpFlow
                  purpose="account"
                  onActiveChange={setPhoneFlowActive}
                  onDone={handlePhoneFlowDone}
                />
                <p className="text-center text-xs font-medium text-brand-ink">
                  {t('Already have an account?', 'لديك حساب بالفعل؟')}{' '}
                  <button
                    type="button"
                    onClick={() => { setErrorMsg(null); setAuthScreen('login'); }}
                    className="text-brand-terracotta font-semibold hover:underline cursor-pointer"
                  >
                    {t('Sign in', 'تسجيل الدخول')}
                  </button>
                </p>
              </div>
            )}

            {/* 2. REGISTRATION SCREEN */}
            {!PHONE_AUTH_ENABLED && authScreen === 'register' && (
              <div className="space-y-6">
                <div>
                  <h2 className="font-display text-3xl font-semibold text-brand-charcoal">{t('Join the Café', 'انضم إلى المقهى')}</h2>
                  <p className="mt-1.5 text-sm text-brand-ink">
                    {t('Create an account to begin tracking mud creations.', 'أنشئ حسابًا لتبدأ بتتبع أعمالك الفخارية.')}
                  </p>
                </div>

                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Full name', 'الاسم الكامل')} *</label>
                    <input
                      type="text"
                      required
                      placeholder={t('Noura Al-Amri', 'نورة العمري')}
                      value={fullName}
                      onChange={e => { setFullName(e.target.value); setErrorMsg(null); clearError('name'); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                    {errors.name && <p className="text-xs text-red-500 font-medium">{errors.name}</p>}
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Email address', 'البريد الإلكتروني')} *</label>
                    <input
                      type="email"
                      required
                      placeholder="noura@amri.sa"
                      value={email}
                      onChange={e => { setEmail(e.target.value); setErrorMsg(null); clearError('email'); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                    {errors.email && <p className="text-xs text-red-500 font-medium">{errors.email}</p>}
                  </div>

                  {/* Phone with Country Code Dropdown */}
                  <PhoneInput
                    label={t('Phone number', 'رقم الجوال')}
                    required
                    value={phone}
                    error={errors.phone}
                    onChange={(val) => { setPhone(val); setErrorMsg(null); clearError('phone'); }}
                  />

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Password', 'كلمة المرور')} *</label>
                    <PasswordField
                      required
                      placeholder="••••••••"
                      value={registerPassword}
                      onChange={ v => { setRegisterPassword(v); setErrorMsg(null); clearError('password'); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                    {/* Live checklist, updating as they type. */}
                    <ul className="space-y-0.5 pt-0.5">
                      {passwordChecklist(registerPassword, lang).map(item => (
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
                    {errors.password && <p className="text-xs text-red-500 font-medium">{errors.password}</p>}
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-brand-charcoal/80">{t('Confirm password', 'تأكيد كلمة المرور')} *</label>
                    <PasswordField
                      required
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={ v => { setConfirmPassword(v); setErrorMsg(null); clearError('confirmPassword'); }}
                      className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                    />
                    {errors.confirmPassword && (
                      <p className="text-xs text-red-500 font-medium">{errors.confirmPassword}</p>
                    )}
                  </div>

                  {registerCaptcha.widget}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full cursor-pointer rounded-full bg-brand-terracotta py-3.5 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors shadow-card-sm mt-4"
                  >
                    {isSubmitting ? t('Creating account...', 'جارٍ إنشاء الحساب...') : t('Create Account', 'إنشاء حساب')}
                  </button>
                </form>

                <div className="text-center pt-2">
                  <p className="text-xs font-medium text-brand-ink">
                    {t('Already have an account?', 'هل لديك حساب بالفعل؟')}{' '}
                    <button
                      onClick={() => { setErrorMsg(null); setAuthScreen('login'); }}
                      className="text-brand-terracotta font-semibold hover:underline cursor-pointer"
                    >
                      {t('Log in', 'تسجيل الدخول')}
                    </button>
                  </p>
                </div>
              </div>
            )}

            {/* 3. FORGOT PASSWORD RECOVERY FLOW */}
            {authScreen === 'forgot' && (
              <div className="space-y-6">

                <button
                  onClick={() => { setErrorMsg(null); setAuthScreen('login'); setResetSent(null); }}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-terracotta hover:underline cursor-pointer"
                >
                  <ArrowLeft className="h-4 w-4 flip-rtl" />
                  <span>{t('Back to login', 'العودة لتسجيل الدخول')}</span>
                </button>

                <div>
                  <h2 className="font-display text-3xl font-semibold text-brand-charcoal">{t('Password Recovery', 'استعادة كلمة المرور')}</h2>
                  <p className="text-xs text-brand-muted mt-1">
                    {t('We will email you a secure link to set a new password.', 'سنرسل إليك رابطًا آمنًا عبر البريد الإلكتروني لتعيين كلمة مرور جديدة.')}
                  </p>
                </div>

                {/* Method selector. Phone is offered but not yet available. */}
                <div className="grid grid-cols-2 gap-2 bg-brand-sand/30 p-1 rounded-full border border-brand-clay">
                  <button
                    type="button"
                    onClick={() => setForgotMethod('email')}
                    className={`py-2 text-xs font-semibold rounded-full transition-colors cursor-pointer ${
                      forgotMethod === 'email' ? 'bg-brand-cream text-brand-terracotta shadow-card-sm' : 'text-brand-muted'
                    }`}
                  >
                    {t('Email Recovery', 'استعادة عبر البريد الإلكتروني')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForgotMethod('phone')}
                    className={`py-2 text-xs font-semibold rounded-full transition-colors cursor-pointer ${
                      forgotMethod === 'phone' ? 'bg-brand-cream text-brand-terracotta shadow-card-sm' : 'text-brand-muted'
                    }`}
                  >
                    {t('Phone Recovery', 'استعادة عبر الجوال')}
                  </button>
                </div>

                {forgotMethod === 'email' ? (
                  <form onSubmit={handleRequestPasswordReset} className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-brand-charcoal/80">{t('Registered Email Address', 'البريد الإلكتروني المسجّل')}</label>
                      <input
                        type="email"
                        required
                        placeholder={`${t('e.g.', 'مثال:')} noura@amri.sa`}
                        value={email}
                        onChange={e => { setEmail(e.target.value); setResetSent(null); setErrorMsg(null); }}
                        className="w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs"
                      />
                    </div>

                    {/* Worded identically whether or not the address is on file,
                        so this cannot be used to probe for accounts. */}
                    {resetSent && (
                      <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-800 flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                        <span className="leading-relaxed">{resetSent}</span>
                      </div>
                    )}

                    {resetCaptcha.widget}

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full cursor-pointer rounded-full bg-brand-terracotta py-3.5 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors shadow-card-sm mt-2 flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      <KeyRound className="h-4 w-4" />
                      <span>{isSubmitting ? t('Sending reset link...', 'جارٍ إرسال رابط إعادة التعيين...') : t('Email me a reset link', 'أرسل لي رابط إعادة التعيين')}</span>
                    </button>
                  </form>
                ) : PHONE_AUTH_ENABLED ? (
                  /* PHONE RECOVERY — a texted code proves the number, then a new password. */
                  <PhoneOtpFlow
                    purpose="reset"
                    onActiveChange={setPhoneFlowActive}
                    onDone={handlePhoneFlowDone}
                  />
                ) : (
                  /*
                   * PHONE RECOVERY — deliberately not implemented.
                   *
                   * ⚠️ OWNERSHIP VERIFICATION
                   * A phone reset must prove the caller controls the number.
                   * Knowing it is not proof: a walk-in's number is known to
                   * anyone who has seen the booking sheet, and resetting on that
                   * basis hands over the account.
                   * TODO(stage-2): once phone auth is enabled in Supabase this is
                   * where supabase.auth.signInWithOtp({ phone }) and verifyOtp go.
                   * Until then the customer is routed to email.
                   */
                  <div className="space-y-4">
                    <div className="p-4 bg-brand-sand/40 border border-brand-clay rounded-2xl text-xs text-brand-ink space-y-1.5">
                      <p className="font-semibold text-brand-charcoal">{t('Phone recovery — coming soon', 'استعادة عبر الجوال — قريبًا')}</p>
                      <p className="leading-relaxed">
                        {t(
                          'We can only reset a password once we can confirm the account is yours. SMS verification is not switched on yet, so please use email recovery. If there is no email on your record, call the studio on ',
                          'يمكننا إعادة تعيين كلمة المرور فقط بعد التأكد من ملكية الحساب. التحقق عبر الرسائل النصية غير مفعّل بعد، لذا يرجى استخدام الاستعادة عبر البريد الإلكتروني. إذا لم يكن هناك بريد إلكتروني مسجّل، يرجى الاتصال بالاستوديو على '
                        )}{STUDIO_PHONE}.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setForgotMethod('email'); setErrorMsg(null); }}
                      className="w-full cursor-pointer rounded-full bg-brand-terracotta py-3.5 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors"
                    >
                      {t('Use email recovery instead', 'استخدم الاستعادة عبر البريد الإلكتروني بدلاً من ذلك')}
                    </button>
                  </div>
                )}

              </div>
            )}

          </motion.div>
          </AnimatePresence>

        </motion.div>
        </div>

        </div>
      )}

    </div>
  );
};
