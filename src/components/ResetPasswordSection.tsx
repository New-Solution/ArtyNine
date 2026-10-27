/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { KeyRound, CheckCircle2, AlertCircle , Check } from 'lucide-react';
import { PasswordField } from './PasswordField';
import { passwordChecklist, validatePasswordRule, validatePasswordConfirmation } from '../utils/validation';
import { useTurnstile } from './Turnstile';

/**
 * The screen the emailed reset link lands on.
 *
 * Supabase establishes a short-lived recovery session from the link before this
 * renders; `completePasswordReset` uses it. Opening this screen without that
 * session — an expired or already-used link — is reported plainly with a way to
 * request a new one.
 */
export const ResetPasswordSection: React.FC = () => {
  const {
    completePasswordReset, requestPasswordReset, hasRecoverySession, recoveryLinkError,
    logoutCustomer, setCustomerTab, setAuthScreen
  } = useApp();
  const { lang } = useLanguage();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [done, setDone] = useState(false);

  // Requesting a fresh link from here, when the old one has expired.
  const [resendEmail, setResendEmail] = useState('');
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  // Supabase Auth CAPTCHA for the new-link request (inactive without VITE_TURNSTILE_SITE_KEY).
  const resendCaptcha = useTurnstile();

  /**
   * Reading the token out of the URL is asynchronous. Waiting for it before
   * enabling the form stops a perfectly good link being reported as expired
   * simply because the page rendered first.
   */
  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'invalid'>('checking');

  useEffect(() => {
    let cancelled = false;

    const waitForSession = async () => {
      // Supabase already told us the link was bad; do not wait on it.
      if (recoveryLinkError) {
        setLinkState('invalid');
        setExpired(true);
        setError(recoveryLinkError);
        return;
      }

      for (let attempt = 0; attempt < 20; attempt++) {      // ~5 seconds
        if (cancelled) return;
        if (await hasRecoverySession()) {
          if (!cancelled) setLinkState('ready');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!cancelled) {
        setLinkState('invalid');
        setExpired(true);
        setError('This reset link has expired or has already been used. Request a new one.');
      }
    };

    waitForSession();
    return () => { cancelled = true; };
  }, []);

  const inputClass =
    'w-full bg-brand-cream border border-brand-clay rounded-xl py-3.5 px-4 text-sm font-semibold text-brand-charcoal shadow-2xs';

  const goToLogin = () => {
    setAuthScreen('login');
    setCustomerTab('auth');
    // Clear the recovery fragment so a refresh does not reopen this screen.
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setError(null);

    const strength = validatePasswordRule(password, lang);
    if (!strength.valid) {
      setError(strength.error!);
      return;
    }
    const match = validatePasswordConfirmation(password, confirmPassword, lang);
    if (!match.valid) {
      setError(match.error!);
      return;
    }

    setIsSaving(true);
    try {
      const result = await completePasswordReset(password);
      if (!result.success) {
        setExpired(result.expired === true);
        setError(result.error || 'Could not set your new password.');
        return;
      }
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'Could not reach the authentication service.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendMessage(null);
    const result = await requestPasswordReset(resendEmail, resendCaptcha.getToken);
    // Same message either way — see requestPasswordReset.
    setResendMessage(result.message || result.error || null);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <div className="bg-white border border-brand-clay rounded-[28px] p-8 shadow-card-sm text-left space-y-5">

        {done ? (
          <>
            <div className="h-12 w-12 rounded-2xl bg-green-50 text-green-600 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-brand-charcoal">Password updated</h1>
              <p className="text-xs text-brand-charcoal/65 mt-1.5 leading-relaxed">
                You can now sign in with your new password.
              </p>
            </div>
            <button
              type="button"
              onClick={async () => { await logoutCustomer(); goToLogin(); }}
              className="w-full cursor-pointer rounded-xl bg-brand-terracotta py-3.5 text-sm font-bold text-brand-cream hover:bg-brand-terracotta-hover transition-colors"
            >
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <div className="h-12 w-12 rounded-2xl bg-brand-charcoal text-brand-cream flex items-center justify-center">
              <KeyRound className="h-6 w-6" />
            </div>

            <div>
              <h1 className="font-display text-2xl font-bold text-brand-charcoal">Set a new password</h1>
              <p className="text-xs text-brand-charcoal/65 mt-1.5 leading-relaxed">
                Choose a new password for your Arty Café account.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-brand-charcoal/80">New password *</label>
                <PasswordField
                  required
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={v => { setPassword(v); setError(null); }}
                  className={inputClass}
                />
                <ul className="space-y-0.5 pt-1">
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
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-brand-charcoal/80">Confirm password *</label>
                <PasswordField
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={v => { setConfirmPassword(v); setError(null); }}
                  className={inputClass}
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-semibold flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isSaving || linkState === 'checking'}
                className="w-full cursor-pointer rounded-xl bg-brand-terracotta py-3.5 text-sm font-bold text-brand-cream hover:bg-brand-terracotta-hover transition-colors disabled:opacity-50"
              >
                {linkState === 'checking' ? 'Checking your link...' : isSaving ? 'Saving...' : 'Save new password'}
              </button>
            </form>

            {/* The link has expired or was already used: offer a fresh one. */}
            {expired && (
              <form onSubmit={handleResend} className="space-y-2 pt-3 border-t border-brand-clay/60">
                <label className="text-xs font-bold text-brand-charcoal/80">Send a new link</label>
                <input
                  type="email"
                  required
                  placeholder="you@example.com"
                  value={resendEmail}
                  onChange={e => { setResendEmail(e.target.value); setResendMessage(null); }}
                  className={inputClass}
                />
                {resendCaptcha.widget}
                <button
                  type="submit"
                  className="w-full cursor-pointer rounded-xl border border-brand-clay bg-brand-cream py-2.5 text-xs font-bold text-brand-charcoal hover:bg-brand-sand/40"
                >
                  Email me a new reset link
                </button>
                {resendMessage && (
                  <p className="text-[11px] font-semibold text-brand-charcoal/70 leading-relaxed">{resendMessage}</p>
                )}
              </form>
            )}

            <button
              type="button"
              onClick={goToLogin}
              className="text-[11px] font-bold text-brand-charcoal/55 hover:text-brand-terracotta cursor-pointer"
            >
              Back to sign in
            </button>
          </>
        )}

      </div>
    </div>
  );
};
