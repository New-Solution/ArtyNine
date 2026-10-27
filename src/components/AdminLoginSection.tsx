/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin Console sign-in for Super Admin, Admin and staff accounts.
 *
 * One screen for all console roles: the role and permissions are read from the
 * authenticated staff record after sign-in, never chosen here. Sign-in accepts
 * an email address or a phone number in any format, normalized before lookup.
 */

import React, { useState } from 'react';
import { PasswordField } from './PasswordField';
import { useApp } from '../context/AppContext';
import { Lock, LogIn, ShieldAlert, AlertCircle, Mail } from 'lucide-react';
import { useTurnstile } from './Turnstile';

export const AdminLoginSection: React.FC = () => {
  const { loginStaff, requestPasswordReset, viewCustomerSite, staff } = useApp();

  // Accounts that can actually sign in, so staff are never left guessing.
  const consoleAccounts = staff.filter(
    m => m.hasConsoleAccess && m.status !== 'Inactive' && m.status !== 'Former Staff'
  );

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [isSendingReset, setIsSendingReset] = useState(false);
  // Supabase Auth CAPTCHA (inactive without VITE_TURNSTILE_SITE_KEY). Both
  // panels can be open at once, so each has its own widget.
  const loginCaptcha = useTurnstile();
  const resetCaptcha = useTurnstile();

  /** Sends a reset link. Wording never reveals whether the address exists. */
  const handleForgotPassword = async () => {
    if (isSendingReset) return;
    setError(null);
    setResetSent(null);

    if (!forgotEmail.trim()) {
      setError('Enter your work email address.');
      return;
    }

    setIsSendingReset(true);
    const res = await requestPasswordReset(forgotEmail, resetCaptcha.getToken);
    setIsSendingReset(false);

    if (!res.success) {
      setError(res.error || 'Could not send the reset link.');
      return;
    }
    setResetSent(res.message || 'If an account exists for that address, a reset link is on its way.');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setError(null);
    setIsSubmitting(true);

    const result = await loginStaff(identifier, password, loginCaptcha.getToken);
    if (!result.success) {
      setError(result.error || 'Sign in failed.');
      setIsSubmitting(false);
      return;
    }

    // A provisioned account is sent to the password-change screen by the
    // routing guard in App.tsx, not from here.
    setPassword('');
    setIsSubmitting(false);
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-6 bg-brand-cream">
      <div className="w-full max-w-md bg-white border border-brand-clay rounded-3xl shadow-xl p-8 space-y-6 text-left">

        <div className="space-y-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-charcoal text-brand-cream">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-brand-charcoal">Admin Console Sign In</h1>
            <p className="text-xs text-brand-charcoal/60 mt-1">
              Sign in with your staff email address or phone number.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80 block">
              Email or Phone Number
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/35" />
              <input
                type="text"
                autoFocus
                value={identifier}
                onChange={e => { setIdentifier(e.target.value); setError(null); }}
                placeholder="name@artycafe.com or 0501234567"
                className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl py-3 pl-9 pr-3 text-sm font-semibold text-brand-charcoal focus:outline-none focus:ring-2 focus:ring-brand-terracotta/30"
              />
            </div>
            <p className="text-[10px] text-brand-charcoal/45">
              Any phone format works — 0501234567, 966501234567 or +966501234567.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80 block">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/35" />
              <PasswordField
                value={password}
                onChange={ v => { setPassword(v); setError(null); }}
                placeholder="••••••••"
                className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl py-3 pl-9 pr-3 text-sm font-semibold text-brand-charcoal focus:outline-none focus:ring-2 focus:ring-brand-terracotta/30"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
              <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <p className="text-[11px] font-bold text-red-700">{error}</p>
            </div>
          )}

          {loginCaptcha.widget}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 bg-brand-terracotta hover:bg-brand-terracotta/90 disabled:opacity-60 text-brand-cream rounded-xl text-sm font-bold shadow-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogIn className="h-4 w-4" />
            <span>{isSubmitting ? 'Signing in…' : 'Sign In'}</span>
          </button>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => setShowForgot(v => !v)}
              className="text-[11px] font-bold text-brand-charcoal/60 hover:text-brand-terracotta cursor-pointer"
            >
              Forgot password?
            </button>
            <button
              type="button"
              onClick={() => viewCustomerSite()}
              className="text-[11px] font-bold text-brand-charcoal/60 hover:text-brand-terracotta cursor-pointer"
            >
              Back to Customer Site
            </button>
          </div>

          {consoleAccounts.length > 0 && (
            <p className="text-[11px] text-brand-charcoal/50">
              {consoleAccounts.length} staff account{consoleAccounts.length === 1 ? '' : 's'} can sign in to the console.
            </p>
          )}

        </form>

        {showForgot && (
          <div className="space-y-2 bg-brand-cream/60 border border-brand-clay/50 rounded-xl p-3 mt-4">
            <p className="text-[11px] text-brand-charcoal/70 leading-relaxed">
              Enter your work email and we will send a link to set a new password.
            </p>
            <input
              type="email"
              placeholder="you@artycafe.sa"
              value={forgotEmail}
              onChange={e => { setForgotEmail(e.target.value); setResetSent(null); setError(null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleForgotPassword();
                }
              }}
              className="w-full bg-white border border-brand-clay rounded-xl py-2.5 px-3 text-xs font-semibold text-brand-charcoal"
            />
            {resetCaptcha.widget}
            <button
              type="button"
              disabled={isSendingReset}
              onClick={handleForgotPassword}
              className="w-full bg-brand-charcoal text-brand-cream py-2.5 rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              {isSendingReset ? 'Sending...' : 'Email me a reset link'}
            </button>
            {/* Same wording whether or not the address exists. */}
            {resetSent && (
              <p className="text-[11px] font-semibold text-brand-sage leading-relaxed">{resetSent}</p>
            )}
            <p className="text-[10px] text-brand-charcoal/50 leading-relaxed">
              A Super Admin can also set one for you in Settings → Staff Registry.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
