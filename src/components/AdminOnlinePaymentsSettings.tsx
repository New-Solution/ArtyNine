/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings -> Online Payments.
 *
 * Edits app_settings 'onlinePayments'. The database reads the same row
 * (online_payments_config(), migration 0046) and enforces it: the amount a
 * customer is charged is computed there, so nothing on this card can be
 * bypassed from a browser. What this card controls:
 *   - the master switch (refused while this build has no payment step),
 *   - how long an unpaid booking holds its place,
 *   - per booking type: deposit (non-refundable) or full price, and the deposit.
 */

import React, { useEffect, useState } from 'react';
import { CreditCard, Save, Check, AlertTriangle, Clock, Gift, Palette } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import {
  ONLINE_PAYMENTS_SETTING_ID,
  normalizeOnlinePayments,
  OnlinePaymentsConfig,
  OnlinePaymentKindConfig,
  HOLD_MINUTES_MIN,
  HOLD_MINUTES_MAX
} from '../utils/onlinePayments';
import { ONLINE_PAYMENTS_AVAILABLE, ONLINE_CHECKOUT_SHIPPED, MOYASAR_PUBLISHABLE_KEY } from '../utils/featureFlags';

type Kind = 'workshop' | 'birthday';

export const AdminOnlinePaymentsSettings: React.FC = () => {
  const { appSettings, updateSetting } = useApp();
  const { t } = useLanguage();

  const stored = appSettings.find(s => s.id === ONLINE_PAYMENTS_SETTING_ID)?.value;
  const [draft, setDraft] = useState<OnlinePaymentsConfig>(() => normalizeOnlinePayments(stored));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Follow a save made elsewhere (another admin, another tab).
  useEffect(() => {
    setDraft(normalizeOnlinePayments(stored));
  }, [JSON.stringify(stored)]);

  const keyMode = MOYASAR_PUBLISHABLE_KEY.startsWith('pk_live_')
    ? 'live'
    : MOYASAR_PUBLISHABLE_KEY.startsWith('pk_test_') ? 'test' : null;

  // Switching ON needs a build with the payment step; switching OFF never waits.
  const canEnable = ONLINE_PAYMENTS_AVAILABLE;
  const wasEnabled = normalizeOnlinePayments(stored).enabled;

  const setKind = (kind: Kind, patch: Partial<OnlinePaymentKindConfig>) =>
    setDraft(d => ({ ...d, [kind]: { ...d[kind], ...patch } }));

  const validate = (c: OnlinePaymentsConfig): string | null => {
    if (!Number.isFinite(c.holdMinutes) || c.holdMinutes < HOLD_MINUTES_MIN || c.holdMinutes > HOLD_MINUTES_MAX) {
      return t(
        `The hold must be between ${HOLD_MINUTES_MIN} and ${HOLD_MINUTES_MAX} minutes.`,
        `يجب أن تكون مدة الحجز المؤقت بين ${HOLD_MINUTES_MIN} و${HOLD_MINUTES_MAX} دقيقة.`
      );
    }
    for (const kind of ['workshop', 'birthday'] as Kind[]) {
      const k = c[kind];
      if (k.mode === 'deposit' && (!Number.isFinite(k.depositAmount) || k.depositAmount < 1)) {
        return t('A deposit must be at least 1 SAR.', 'يجب ألا يقل العربون عن 1 ريال.');
      }
    }
    if (c.enabled && !wasEnabled && !canEnable) {
      return t(
        'Online payments cannot be turned on in this version of the site yet.',
        'لا يمكن تفعيل الدفع الإلكتروني في هذا الإصدار من الموقع بعد.'
      );
    }
    return null;
  };

  const handleSave = async () => {
    setError(null);
    const problem = validate(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      // Saved in the normalised shape, so what is stored is exactly what the
      // database will read.
      await updateSetting(ONLINE_PAYMENTS_SETTING_ID, normalizeOnlinePayments({
        ...draft,
        holdMinutes: Math.floor(draft.holdMinutes)
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err?.message || t('Could not save the setting.', 'تعذّر حفظ الإعداد.'));
    } finally {
      setSaving(false);
    }
  };

  const kindCard = (kind: Kind, icon: React.ReactNode, title: string) => {
    const k = draft[kind];
    return (
      <div className="p-5 bg-brand-cream/35 border border-brand-clay rounded-2xl space-y-3">
        <div className="flex items-center gap-2 text-brand-terracotta">
          {icon}
          <h3 className="font-display font-bold text-sm text-brand-charcoal">{title}</h3>
        </div>

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={title}>
          {(['deposit', 'full'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={k.mode === mode}
              onClick={() => setKind(kind, { mode })}
              className={`px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer text-start ${
                k.mode === mode
                  ? 'border-2 border-brand-terracotta bg-brand-terracotta/5 text-brand-terracotta'
                  : 'border-brand-clay bg-white text-brand-charcoal/70 hover:border-brand-terracotta/50'
              }`}
            >
              {mode === 'deposit' ? t('Deposit', 'عربون') : t('Full price', 'السعر كاملًا')}
            </button>
          ))}
        </div>

        {k.mode === 'deposit' ? (
          <>
            <div className="space-y-1">
              <label htmlFor={`deposit-${kind}`} className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">
                {t('Deposit (SAR)', 'العربون (ريال)')}
              </label>
              <input
                id={`deposit-${kind}`}
                type="number"
                min={1}
                step="0.01"
                value={Number.isFinite(k.depositAmount) ? k.depositAmount : ''}
                onChange={e => setKind(kind, { depositAmount: e.target.value === '' ? NaN : Number(e.target.value) })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-sm font-bold text-brand-charcoal font-mono"
              />
            </div>
            <p className="text-xs text-brand-charcoal/60 leading-relaxed">
              {t(
                'Charged online when booking (never more than the booking’s price). Non-refundable: a customer cancellation never refunds it. The balance is paid at the studio.',
                'يُدفع إلكترونيًا عند الحجز (ولا يتجاوز سعر الحجز). غير قابل للاسترداد: لا يُسترد عند إلغاء العميل. يُدفع باقي المبلغ في الاستوديو.'
              )}
            </p>
          </>
        ) : (
          <p className="text-xs text-brand-charcoal/60 leading-relaxed">
            {t(
              'The full price is charged online when booking. A customer who cancels more than 24 hours ahead is marked refunded; staff issue the refund in the Moyasar dashboard.',
              'يُدفع السعر كاملًا إلكترونيًا عند الحجز. إذا ألغى العميل قبل أكثر من 24 ساعة يُسجَّل الحجز كمُسترد، ويُصدر الموظفون الاسترداد من لوحة تحكم Moyasar.'
            )}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <div>
        <h2 className="font-display text-xl font-bold text-brand-charcoal flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-brand-terracotta" />
          <span>{t('Online Payments', 'الدفع الإلكتروني')}</span>
        </h2>
        <p className="text-xs text-brand-charcoal/60 mt-1">
          {t(
            'How customers pay on the website. The amounts are enforced by the database: the price is always calculated by the studio’s system, never by the customer’s browser.',
            'طريقة دفع العملاء عبر الموقع. تُطبَّق المبالغ من قاعدة البيانات: يُحسب السعر دائمًا بواسطة نظام الاستوديو وليس متصفح العميل.'
          )}
        </p>
      </div>

      {/* Master switch */}
      <div className="p-5 border border-brand-clay rounded-2xl space-y-3 bg-white">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!draft.enabled && !canEnable}
            onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
            className="h-4 w-4 accent-brand-terracotta mt-0.5 cursor-pointer disabled:cursor-not-allowed"
          />
          <span>
            <span className="block text-sm font-bold text-brand-charcoal">
              {t('Take payment online at checkout', 'تحصيل الدفع إلكترونيًا عند إتمام الحجز')}
            </span>
            <span className="block text-xs text-brand-charcoal/60 mt-0.5">
              {t(
                'When on, a website booking holds its place while the customer pays with Moyasar, and is confirmed only once the payment is verified.',
                'عند التفعيل، يحجز طلب الموقع مكانه مؤقتًا أثناء الدفع عبر Moyasar، ولا يُؤكَّد إلا بعد التحقق من الدفع.'
              )}
            </span>
          </span>
        </label>

        {!canEnable && (
          <p className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {!ONLINE_CHECKOUT_SHIPPED
                ? t(
                    'This version of the site does not include the payment step yet, so online payments cannot be turned on.',
                    'لا يتضمن هذا الإصدار من الموقع خطوة الدفع بعد، لذا لا يمكن تفعيل الدفع الإلكتروني.'
                  )
                : t(
                    'No Moyasar publishable key is configured for this site, so online payments cannot be turned on.',
                    'لم يتم ضبط مفتاح Moyasar العام لهذا الموقع، لذا لا يمكن تفعيل الدفع الإلكتروني.'
                  )}
            </span>
          </p>
        )}

        {keyMode && (
          <p className={`text-[11px] font-bold ${keyMode === 'live' ? 'text-emerald-700' : 'text-amber-700'}`}>
            {keyMode === 'live'
              ? t('Moyasar: LIVE key — real cards are charged.', 'Moyasar: مفتاح حقيقي — تُخصم المبالغ من البطاقات فعليًا.')
              : t('Moyasar: TEST key — no real money moves.', 'Moyasar: مفتاح تجريبي — لا تُخصم أي مبالغ حقيقية.')}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {kindCard('workshop', <Palette className="h-5 w-5" />, t('Workshop bookings', 'حجوزات الورش'))}
        {kindCard('birthday', <Gift className="h-5 w-5" />, t('Birthday bookings', 'حجوزات أعياد الميلاد'))}

        <div className="p-5 bg-brand-cream/35 border border-brand-clay rounded-2xl space-y-3">
          <div className="flex items-center gap-2 text-brand-terracotta">
            <Clock className="h-5 w-5" />
            <h3 className="font-display font-bold text-sm text-brand-charcoal">{t('Payment hold', 'مهلة الدفع')}</h3>
          </div>
          <div className="space-y-1">
            <label htmlFor="hold-minutes" className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">
              {t('Minutes', 'دقائق')}
            </label>
            <input
              id="hold-minutes"
              type="number"
              min={HOLD_MINUTES_MIN}
              max={HOLD_MINUTES_MAX}
              step={1}
              value={Number.isFinite(draft.holdMinutes) ? draft.holdMinutes : ''}
              onChange={e => setDraft(d => ({ ...d, holdMinutes: e.target.value === '' ? NaN : Number(e.target.value) }))}
              className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-sm font-bold text-brand-charcoal font-mono"
            />
          </div>
          <p className="text-xs text-brand-charcoal/60 leading-relaxed">
            {t(
              'How long an unpaid booking keeps its seat or slot. After that the place is released straight away and the booking is marked expired.',
              'المدة التي يحتفظ فيها الحجز غير المدفوع بمقعده أو موعده. بعدها يُحرَّر المكان فورًا ويُسجَّل الحجز كمنتهي المهلة.'
            )}
          </p>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 font-semibold">{error}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50"
        >
          {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          <span>{saved ? t('Saved', 'تم الحفظ') : t('Save Online Payments', 'حفظ إعدادات الدفع الإلكتروني')}</span>
        </button>
      </div>
    </div>
  );
};
