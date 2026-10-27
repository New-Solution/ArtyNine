/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, KeyRound, MessageSquare, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { supabase } from '../lib/supabase';
import { PhoneInput } from './PhoneInput';
import { PasswordField } from './PasswordField';
import {
  requestPhoneCode, verifyPhoneCode, completePhoneSetup, maskE164Saudi, needsCustomerName,
  type PhoneAuthFailure
} from '../utils/phoneAuth';
import {
  canonicalEmail, passwordChecklist, validateEmailRule, validatePasswordConfirmation,
  validatePasswordRule, validateRequired
} from '../utils/validation';
import { useTurnstile } from './Turnstile';

/** Seconds before "Resend code" is offered again. */
const RESEND_SECONDS = 60;

const inputClass = 'w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs';
const buttonClass = 'w-full cursor-pointer rounded-full bg-brand-terracotta py-3.5 text-sm font-semibold text-brand-cream hover:bg-brand-terracotta-hover transition-colors shadow-card-sm flex items-center justify-center gap-2 disabled:opacity-50';

type Step = 'phone' | 'code' | 'details' | 'phone_in_use';

/** Every failure reason in both languages. Shared by the flow and the setup form. */
function phoneFailureText(reason: PhoneAuthFailure, t: (en: string, ar: string) => string): string {
  switch (reason) {
    case 'invalid_phone':
      return t('Enter a valid Saudi mobile number, e.g. 05X XXX XXXX.', 'أدخل رقم جوال سعوديًا صحيحًا، مثال: 05X XXX XXXX.');
    case 'rate_limited':
      return t('Too many codes requested. Please wait a few minutes and try again.', 'طلبت رموزًا كثيرة. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.');
    case 'send_failed':
      return t('We could not send the code right now. Please try again in a moment.', 'تعذّر إرسال الرمز حاليًا. يرجى المحاولة بعد قليل.');
    case 'invalid_code':
      return t('That code is incorrect or has expired. Check it, or send a new one.', 'الرمز غير صحيح أو انتهت صلاحيته. تحقّق منه أو اطلب رمزًا جديدًا.');
    case 'captcha_failed':
      return t('Please complete the security check, then try again.', 'يرجى إكمال التحقق الأمني ثم المحاولة مرة أخرى.');
    case 'link_failed':
      return t('Your number is verified, but we could not open your account. Please try again.', 'تم التحقق من رقمك، لكن تعذّر فتح حسابك. يرجى المحاولة مرة أخرى.');
    case 'weak_password':
      return t('Choose a stronger password.', 'اختر كلمة مرور أقوى.');
    case 'update_failed':
      return t('We could not save your password. Please try again.', 'تعذّر حفظ كلمة المرور. يرجى المحاولة مرة أخرى.');
    case 'profile_failed':
      return t('Your password is saved, but we could not save your name. Please try again.', 'تم حفظ كلمة المرور، لكن تعذّر حفظ اسمك. يرجى المحاولة مرة أخرى.');
  }
}

interface PhoneOtpFlowProps {
  /** Only changes the heading: one flow serves sign-up, walk-in claim, reset and checkout. */
  purpose: 'account' | 'reset' | 'checkout';
  /** Pre-fills the phone field (e.g. what was typed on Sign In). */
  initialPhone?: string;
  /**
   * True from the moment the code is verified (a session now exists) until the
   * flow finishes or is abandoned. The parent keeps this flow on screen while it
   * is true, even though currentUser becomes set part-way through.
   */
  onActiveChange?: (active: boolean) => void;
  /** Called once the password is saved and the customer is signed in. */
  onDone: () => void;
  /** Shown as a back link on the first step when provided. */
  onCancel?: () => void;
}

/**
 * Phone sign-in by SMS code: enter phone -> enter code -> set password (plus
 * name, and optionally email, for a new account) -> done.
 *
 * Supabase Auth owns the code. The flow answers identically whether or not the
 * number is on file until the code is verified; only then — once the visitor
 * has proved they hold the number — does it say whether an existing record was
 * found. Behind VITE_PHONE_AUTH: never rendered while the flag is off.
 */
export const PhoneOtpFlow: React.FC<PhoneOtpFlowProps> = ({ purpose, initialPhone, onActiveChange, onDone, onCancel }) => {
  const { setCurrentUser, logoutCustomer } = useApp();
  const { t } = useLanguage();
  const captcha = useTurnstile();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState(initialPhone || '');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [isNew, setIsNew] = useState(false);
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [record, setRecord] = useState<{ name: string; email: string; phone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Unmounted part-way (e.g. switching Sign In / Create Account): release the
  // hold. A verified but unfinished account then gets the parent's "Finish
  // setting up" step instead — the session, not this component, is the state.
  useEffect(() => () => onActiveChange?.(false), []);

  // Resend countdown.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = window.setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [secondsLeft]);

  const failureText = (reason: PhoneAuthFailure) => phoneFailureText(reason, t);

  const notConfigured = () =>
    setError(t('Sign-in is not available right now. Please try again later.', 'تسجيل الدخول غير متاح حاليًا. يرجى المحاولة لاحقًا.'));

  /** Ends the half-finished session when the flow cannot complete. */
  const abandonSession = async () => {
    await logoutCustomer();
    onActiveChange?.(false);
  };

  const sendCode = async (target: string) => {
    setError(null);
    if (!supabase) return notConfigured();
    setBusy(true);
    const res = await requestPhoneCode(supabase, target, captcha.getToken);
    setBusy(false);
    if ('reason' in res) {
      setError(failureText(res.reason));
      return;
    }
    setSentTo(res.phone);
    setCode('');
    setSecondsLeft(RESEND_SECONDS);
    setStep('code');
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    void sendCode(phone);
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!supabase) return notConfigured();
    setBusy(true);
    // Raised BEFORE verifying: a correct code signs the visitor in, and the
    // app's own session listener can set currentUser before this call returns.
    // The parent must already be holding this flow on screen by then.
    onActiveChange?.(true);
    const res = await verifyPhoneCode(supabase, sentTo, code, undefined, captcha.getToken);
    if ('reason' in res) {
      // A failed verify after a successful sign-in (link_failed) leaves a
      // session behind; a wrong code does not, and logging out is harmless.
      if (res.reason === 'link_failed') await logoutCustomer();
      onActiveChange?.(false);
      setBusy(false);
      setError(failureText(res.reason));
      return;
    }

    if (res.status === 'phone_in_use') {
      await abandonSession();
      setBusy(false);
      setStep('phone_in_use');
      return;
    }
    if (res.status === 'not_verified' || res.status === 'error' || !res.customerId) {
      await abandonSession();
      setBusy(false);
      setError(failureText('link_failed'));
      return;
    }

    setCustomerId(res.customerId);
    const created = res.status === 'created';
    setIsNew(created);

    if (!created) {
      // The visitor's own row — readable now that they are signed in.
      const { data } = await supabase
        .from('customers')
        .select('name, email, phone')
        .eq('id', res.customerId)
        .maybeSingle();
      const row = data as { name?: string | null; email?: string | null; phone?: string | null } | null;
      setRecord({ name: row?.name || '', email: row?.email || '', phone: row?.phone || sentTo });
    }

    setBusy(false);
    setStep('details');
  };

  /** A new row is still "Guest"; a walk-in's row keeps the name the studio gave it. */
  const askName = isNew || needsCustomerName(record?.name);

  /** The setup form has saved the password (and name) and marked setup complete. */
  const handleSaved = (saved: { name: string; email: string }) => {
    if (customerId) {
      setCurrentUser({
        id: customerId,
        name: askName ? saved.name : record?.name || '',
        email: askName ? saved.email : record?.email || '',
        phone: record?.phone || sentTo
      });
    }
    onActiveChange?.(false);
    onDone();
  };

  const heading =
    purpose === 'reset' ? t('Reset your password by phone', 'إعادة تعيين كلمة المرور عبر الجوال')
    : purpose === 'checkout' ? t('Verify your phone to continue', 'تحقّق من رقم جوالك للمتابعة')
    : t('Continue with your phone', 'المتابعة برقم جوالك');

  const subheading =
    purpose === 'reset'
      ? t('We will text you a 6-digit code, then you can choose a new password.', 'سنرسل إليك رمزًا من 6 أرقام برسالة نصية، ثم يمكنك اختيار كلمة مرور جديدة.')
      : t('We will text you a 6-digit code. New here, or booked with us at the studio? This sets up your account.',
          'سنرسل إليك رمزًا من 6 أرقام برسالة نصية. جديد هنا، أو حجزت لدينا في الاستوديو؟ بهذا يتم إعداد حسابك.');

  return (
    <div className="space-y-5 text-start">
      {step === 'phone' && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-terracotta hover:underline cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4 flip-rtl" />
          <span>{t('Back', 'رجوع')}</span>
        </button>
      )}

      <div>
        <h2 className="font-display text-2xl font-semibold text-brand-charcoal">{heading}</h2>
        {step === 'phone' && <p className="mt-1.5 text-sm text-brand-ink">{subheading}</p>}
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-start gap-2.5" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
          <p>{error}</p>
        </div>
      )}

      {/* 1. Phone */}
      {step === 'phone' && (
        <form onSubmit={handleSend} className="space-y-4">
          <PhoneInput
            label={`${t('Saudi Mobile Phone Number', 'رقم الجوال السعودي')} *`}
            value={phone}
            onChange={v => { setPhone(v); setError(null); }}
          />
          {captcha.widget}
          <button type="submit" disabled={busy} className={buttonClass}>
            <MessageSquare className="h-4 w-4" />
            <span>{busy ? t('Sending code...', 'جارٍ إرسال الرمز...') : t('Text me a code', 'أرسل لي رمزًا')}</span>
          </button>
        </form>
      )}

      {/* 2. Code — the same wording whether or not the number is on file. */}
      {step === 'code' && (
        <form onSubmit={handleVerify} className="space-y-4">
          <p className="text-sm text-brand-ink">
            {t('We sent a code to', 'أرسلنا رمزًا إلى')}{' '}
            <bdi dir="ltr" className="font-semibold text-brand-charcoal ltr-numerals">{maskE164Saudi(sentTo)}</bdi>
          </p>
          <div className="space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80" htmlFor="phone-otp-code">{t('6-digit code', 'الرمز المكوّن من 6 أرقام')}</label>
            <input
              id="phone-otp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              maxLength={6}
              required
              value={code}
              onChange={e => { setCode(e.target.value); setError(null); }}
              className={`${inputClass} tracking-[0.5em] text-center ltr-numerals`}
              placeholder="••••••"
            />
          </div>
          {/* Verify and "Resend code" each use a token. */}
          {captcha.widget}
          <button type="submit" disabled={busy} className={buttonClass}>
            <Check className="h-4 w-4" />
            <span>{busy ? t('Checking...', 'جارٍ التحقق...') : t('Verify code', 'تحقّق من الرمز')}</span>
          </button>
          <div className="flex items-center justify-between gap-3 text-xs">
            <button
              type="button"
              onClick={() => { setStep('phone'); setError(null); }}
              className="font-semibold text-brand-muted hover:underline cursor-pointer"
            >
              {t('Change number', 'تغيير الرقم')}
            </button>
            <button
              type="button"
              disabled={busy || secondsLeft > 0}
              onClick={() => void sendCode(sentTo)}
              className="inline-flex items-center gap-1.5 font-semibold text-brand-terracotta hover:underline cursor-pointer disabled:text-brand-muted disabled:no-underline disabled:cursor-not-allowed"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>
                {secondsLeft > 0
                  ? t(`Resend in ${secondsLeft}s`, `إعادة الإرسال بعد ${secondsLeft} ث`)
                  : t('Resend code', 'إعادة إرسال الرمز')}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* 3. Password (+ name and optional email when the record has no real name yet) */}
      {step === 'details' && (
        <PhoneSetupForm askName={askName} welcomeName={record?.name} onSaved={handleSaved} />
      )}

      {/* The number belongs to an email account. Said only after the code proved ownership. */}
      {step === 'phone_in_use' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-semibold flex items-start gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <p className="leading-relaxed">
              {t(
                'This number belongs to an account that signs in with email. Sign in with your email, or use Forgot password.',
                'هذا الرقم مرتبط بحساب يسجّل الدخول بالبريد الإلكتروني. سجّل الدخول ببريدك الإلكتروني، أو استخدم «نسيت كلمة المرور».'
              )}
            </p>
          </div>
          {onCancel && (
            <button type="button" onClick={onCancel} className={buttonClass}>
              <span>{t('Back to sign in', 'العودة لتسجيل الدخول')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface PhoneSetupFormProps {
  /** Ask for a name (and optional email): the record is new, or still "Guest". */
  askName: boolean;
  /** The name on file, for "Welcome back" when no name is asked for. */
  welcomeName?: string;
  /** Called after the password (and name) are saved and setup is marked complete. */
  onSaved: (saved: { name: string; email: string }) => void;
}

/**
 * The last step of a phone account: a password, plus a name when the record
 * has none yet. Used by the flow right after the code, and on its own as the
 * "Finish setting up your account" step for a signed-in phone account that
 * left before finishing (AuthSection). The phone and auth id come from the
 * session, never from props.
 */
export const PhoneSetupForm: React.FC<PhoneSetupFormProps> = ({ askName: askNameProp, welcomeName, onSaved }) => {
  const { lang, t } = useLanguage();
  // Fixed on mount: saving the name changes the record while this is still on screen.
  const [askName] = useState(askNameProp);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPasswordValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (askName) {
      const nameCheck = validateRequired(name, t('Full name', 'الاسم الكامل'), lang);
      if (!nameCheck.valid) return setError(nameCheck.error!);
      const emailCheck = validateEmailRule(email, false, lang);
      if (!emailCheck.valid) return setError(emailCheck.error!);
    }
    const strength = validatePasswordRule(password, lang);
    if (!strength.valid) return setError(strength.error!);
    const match = validatePasswordConfirmation(password, confirm, lang);
    if (!match.valid) return setError(match.error!);

    setBusy(true);
    const sessionUser = supabase ? (await supabase.auth.getSession()).data.session?.user : undefined;
    if (!supabase || !sessionUser?.phone) {
      setBusy(false);
      return setError(t('Sign-in is not available right now. Please try again later.', 'تسجيل الدخول غير متاح حاليًا. يرجى المحاولة لاحقًا.'));
    }
    const res = await completePhoneSetup(supabase, {
      password,
      phone: sessionUser.phone,
      authId: sessionUser.id,
      name: askName ? name : undefined,
      email: askName ? canonicalEmail(email) : undefined
    });
    setBusy(false);
    if ('reason' in res) return setError(phoneFailureText(res.reason, t));

    onSaved({ name: askName ? name.trim() : '', email: askName ? canonicalEmail(email) : '' });
  };

  const firstName = (welcomeName || '').trim().split(/\s+/)[0];

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-start gap-2.5" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
          <p>{error}</p>
        </div>
      )}

      {!askName && (
        <p className="p-4 rounded-xl bg-brand-sand/40 border border-brand-clay text-xs text-brand-ink leading-relaxed">
          {firstName
            ? t(`Welcome back, ${firstName}. Not you? Contact the studio.`, `مرحبًا بعودتك، ${firstName}. لست أنت؟ تواصل مع الاستوديو.`)
            : t('Welcome back. Not you? Contact the studio.', 'مرحبًا بعودتك. لست أنت؟ تواصل مع الاستوديو.')}
        </p>
      )}

      {askName && (
        <>
          <div className="space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80" htmlFor="phone-otp-name">{t('Full name', 'الاسم الكامل')} *</label>
            <input
              id="phone-otp-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={e => { setName(e.target.value); setError(null); }}
              placeholder={t('e.g. Noura Al-Amri', 'مثال: نورة العمري')}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80" htmlFor="phone-otp-email">
              {t('Email address (optional)', 'البريد الإلكتروني (اختياري)')}
            </label>
            <input
              id="phone-otp-email"
              type="text"
              inputMode="email"
              autoComplete="email"
              dir="ltr"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(null); }}
              placeholder="noura@example.com"
              className={inputClass}
            />
          </div>
        </>
      )}

      <div className="space-y-1">
        <label className="text-xs font-bold text-brand-charcoal/80">{t('New password', 'كلمة المرور الجديدة')} *</label>
        <PasswordField
          required
          placeholder="••••••••"
          autoComplete="new-password"
          value={password}
          onChange={v => { setPasswordValue(v); setError(null); }}
          className={inputClass}
        />
        <ul className="space-y-0.5 pt-0.5">
          {passwordChecklist(password, lang).map(item => (
            <li
              key={item.label}
              className={`text-[11px] font-semibold flex items-center gap-1.5 ${item.met ? 'text-brand-sage' : 'text-brand-charcoal/45'}`}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {item.met ? <Check className="h-3.5 w-3.5" /> : <span className="h-1 w-1 rounded-full bg-current opacity-60" />}
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
          autoComplete="new-password"
          value={confirm}
          onChange={v => { setConfirm(v); setError(null); }}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={busy} className={buttonClass}>
        <KeyRound className="h-4 w-4" />
        <span>{busy ? t('Saving...', 'جارٍ الحفظ...') : t('Save and continue', 'حفظ والمتابعة')}</span>
      </button>
    </form>
  );
};
