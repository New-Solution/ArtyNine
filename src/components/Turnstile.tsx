/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cloudflare Turnstile widget for Supabase Auth CAPTCHA (see utils/captcha.ts).
 *
 *   const captcha = useTurnstile();
 *   ...
 *   {captcha.widget}                       // inside the form, above the submit button
 *   await loginCustomer(id, pw, captcha.getToken);
 *
 * Inactive until VITE_TURNSTILE_SITE_KEY is set: `widget` is null, the script
 * is never loaded, and `getToken` resolves undefined straight away.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { CAPTCHA_ENABLED, TURNSTILE_SITE_KEY, TokenSlot, type CaptchaProvider } from '../utils/captcha';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Loads api.js once per page, however many widgets ask for it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load.')));
    script.onerror = () => reject(new Error('Turnstile did not load.'));
    document.head.appendChild(script);
  }).catch(error => {
    // Let a later widget try again (e.g. after the connection comes back).
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

type WidgetStatus = 'loading' | 'ready' | 'expired' | 'error' | 'timeout' | 'unavailable';

const TurnstileWidget: React.FC<{ slot: TokenSlot }> = ({ slot }) => {
  const { lang, t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<WidgetStatus>('loading');

  // Re-rendered when the language changes, so the widget's own text follows it.
  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;

    setStatus('loading');
    loadTurnstile()
      .then(loaded => {
        if (cancelled || !containerRef.current) return;
        api = loaded;
        widgetId = loaded.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          language: lang === 'ar' ? 'ar' : 'en',
          theme: 'light',
          size: 'flexible',
          callback: (token: string) => { slot.put(token); setStatus('ready'); },
          'expired-callback': () => { slot.clear(); setStatus('expired'); },
          'timeout-callback': () => { slot.clear(); setStatus('expired'); },
          'error-callback': () => { slot.clear(); setStatus('error'); }
        });
        // Single-use tokens: start on the next one as soon as this one is used.
        slot.onTaken = () => {
          if (api && widgetId !== null) api.reset(widgetId);
        };
        slot.onTimeout = () => setStatus('timeout');
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });

    return () => {
      cancelled = true;
      slot.clear();
      slot.onTaken = null;
      slot.onTimeout = null;
      if (api && widgetId !== null) api.remove(widgetId);
    };
  }, [lang, slot]);

  const message =
    status === 'expired' ? t('The security check expired. It will refresh automatically.', 'انتهت صلاحية التحقق الأمني. سيتم تحديثه تلقائيًا.')
    : status === 'error' ? t('The security check failed. Please try again.', 'فشل التحقق الأمني. يرجى المحاولة مرة أخرى.')
    : status === 'timeout' ? t('Please complete the security check, then try again.', 'يرجى إكمال التحقق الأمني ثم المحاولة مرة أخرى.')
    : status === 'unavailable' ? t('The security check could not load. Check your connection and reload the page.', 'تعذّر تحميل التحقق الأمني. تحقّق من اتصالك وأعد تحميل الصفحة.')
    : null;

  return (
    <div className="space-y-1.5">
      <div ref={containerRef} className="min-h-[65px]" />
      {message && (
        <p className="flex items-start gap-1.5 text-[11px] font-semibold text-red-600" role="alert">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{message}</span>
        </p>
      )}
    </div>
  );
};

const noToken: CaptchaProvider = async () => undefined;

/**
 * One widget and its token source. Use one per form; render `widget` where the
 * check should appear and pass `getToken` to the auth call.
 */
export function useTurnstile(): { widget: React.ReactNode; getToken: CaptchaProvider } {
  const slot = useMemo(() => new TokenSlot(), []);
  const getToken = useMemo<CaptchaProvider>(() => (CAPTCHA_ENABLED ? () => slot.take() : noToken), [slot]);
  const widget = CAPTCHA_ENABLED ? <TurnstileWidget slot={slot} /> : null;
  return { widget, getToken };
}
