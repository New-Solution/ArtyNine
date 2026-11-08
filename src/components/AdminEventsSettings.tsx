/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import {
  EventsSettingsConfig, BirthdayFormField, BirthdayTermsConfig,
  DEFAULT_BIRTHDAY_TERMS, renderTermsLine, fixCancellationTerms, REFUND_NOTICE_HOURS
} from '../types';
import {
  Save, Check, Gift, Info, Plus, Trash2, ChevronUp, ChevronDown, ListChecks, ShieldAlert
} from 'lucide-react';
import { LineListTextarea } from './ui/LineListTextarea';
import { ContentLanguageTabs, ContentLang } from './ui/ContentLanguageTabs';
import { useLanguage } from '../context/LanguageContext';
import { BIRTHDAY_DAILY_MAX, BIRTHDAY_SAME_SLOT_MAX } from '../utils/queueUtils';
import { useServerDraft, ServerChangedNotice } from './ui/useServerDraft';
import { SaveErrorBanner, useSaveError } from './ui/SaveErrorBanner';

const SAVE_TERMS = { en: 'the birthday terms', ar: 'شروط أعياد الميلاد' };
const SAVE_FIELDS = { en: 'the birthday form fields', ar: 'حقول نموذج عيد الميلاد' };

/**
 * Settings -> Events / Birthday.
 *
 * Two things are edited here: the birthday terms customers accept, and the
 * fields of the birthday booking form. The booking RULES (notice, party caps,
 * cancellation) are fixed in code and the database and are only shown,
 * read-only: the inputs that used to sit here were saved but never read.
 *
 * Both editors keep a local draft (useServerDraft): a realtime update never
 * wipes unsaved edits, and text is saved when a field loses focus, not on
 * every keystroke.
 */
export const AdminEventsSettings: React.FC = () => {
  const {
    updateSetting, birthdayFormFields, updateBirthdayFormFields,
    // Already provided by the shared data layer.
    appSettings: rawAppSettings
  } = useApp();
  const { lang, t } = useLanguage();

  const rawConfig = rawAppSettings.find(s => s.id === 'eventsSettings')?.value as EventsSettingsConfig | undefined;

  const termsSave = useSaveError();
  const fieldsSave = useSaveError();

  // ---- Editable birthday terms (customer-facing) ----
  // Old wording with {cancellationDays} is rewritten to the 24-hour rule here,
  // so the editor shows (and the next save stores) what the system does.
  const termsDraft = useServerDraft<BirthdayTermsConfig>(
    fixCancellationTerms(rawConfig?.birthdayTerms || DEFAULT_BIRTHDAY_TERMS)
  );
  const terms = termsDraft.draft;
  const setTerms = termsDraft.setDraft;
  const savedVersion = rawConfig?.birthdayTerms?.version || DEFAULT_BIRTHDAY_TERMS.version;
  const [termsSaved, setTermsSaved] = useState(false);
  const [termsLang, setTermsLang] = useState<ContentLang>('en');

  /**
   * The ONLY way the terms change. Every save gets a new version stamp, so
   * each acceptance records the wording that was agreed to. Nothing else in
   * this section writes birthdayTerms.
   */
  const handleSaveTerms = async () => {
    const updated: BirthdayTermsConfig = {
      ...terms,
      version: `${new Date().toISOString().split('T')[0]}-${Date.now().toString().slice(-4)}`,
      updatedAt: new Date().toISOString()
    };
    const ok = await termsSave.run(
      () => updateSetting('eventsSettings', { ...(rawConfig || {}), birthdayTerms: updated }),
      SAVE_TERMS
    );
    if (!ok) return;
    termsDraft.markSaved(updated);
    setTermsSaved(true);
    setTimeout(() => setTermsSaved(false), 2500);
  };

  // Preview follows the active tab. Mirrors the customer page: the Arabic set is
  // "present" only when its body (opening lines or supplies) has content.
  const termsArabicFilled = !!(
    terms.titleAr?.trim() || terms.suppliesIntroAr?.trim() ||
    terms.leadingItemsAr?.length || terms.suppliesAr?.length || terms.trailingItemsAr?.length
  );
  const previewIsAr = termsLang === 'ar';
  const previewArEmpty = previewIsAr && !(terms.leadingItemsAr?.length || terms.suppliesAr?.length);
  const pv = previewIsAr
    ? {
        title: terms.titleAr ?? '',
        leadingItems: terms.leadingItemsAr ?? [],
        suppliesIntro: terms.suppliesIntroAr ?? '',
        supplies: terms.suppliesAr ?? [],
        trailingItems: terms.trailingItemsAr ?? []
      }
    : terms;

  // ---- Birthday booking-form field editor (managed here only) ----
  const fieldsDraft = useServerDraft<BirthdayFormField[]>(birthdayFormFields);
  const fields = fieldsDraft.draft;
  const [fieldsSaved, setFieldsSaved] = useState(false);

  /** Saves the given list (or the current draft) as the booking form. */
  const commitFields = async (next: BirthdayFormField[] = fieldsDraft.draft) => {
    const ordered = next.map((f, idx) => ({ ...f, order: idx }));
    const ok = await fieldsSave.run(() => updateBirthdayFormFields(ordered), SAVE_FIELDS);
    if (!ok) return;
    fieldsDraft.markSaved(ordered);
    setFieldsSaved(true);
    setTimeout(() => setFieldsSaved(false), 2500);
  };

  /** Text edits stay local until the field loses focus (then commitFields()). */
  const editFieldLocal = (id: string, updates: Partial<BirthdayFormField>) => {
    fieldsDraft.setDraft(current => current.map(f => (f.id === id ? { ...f, ...updates } : f)));
  };

  /** Saves on blur, but only when something was actually edited. */
  const commitIfEdited = () => {
    if (fieldsDraft.dirty) commitFields();
  };

  /** Discrete changes (toggle, type, required) save straight away. */
  const handleFieldChange = (id: string, updates: Partial<BirthdayFormField>) => {
    commitFields(fields.map(f => (f.id === id ? { ...f, ...updates } : f)));
  };

  const handleToggleField = (id: string) => {
    const field = fields.find(f => f.id === id);
    if (!field) return;
    handleFieldChange(id, { enabled: !field.enabled });
  };

  const handleMoveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    commitFields(next);
  };

  const handleRemoveField = (id: string) => {
    const field = fields.find(f => f.id === id);
    if (!field || field.system) return;
    if (!window.confirm(t(`Remove the "${field.label}" field from the birthday booking form?`, `إزالة الحقل "${field.label}" من نموذج حجز عيد الميلاد؟`))) return;
    commitFields(fields.filter(f => f.id !== id));
  };

  const handleAddField = () => {
    const id = `bf-${Date.now()}`;
    commitFields([
      ...fields,
      {
        id,
        key: `custom_${Date.now()}`,
        label: 'New Field',
        type: 'short_text',
        required: false,
        enabled: true,
        order: fields.length
      }
    ]);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* The page keeps the System Settings header above; this section's own
          title lives on the first card, so it is not repeated here. */}

      {/* The booking rules, read-only. They used to be inputs here, saved to
          eventsSettings and never read: notice days and party caps are fixed in
          src/utils/queueUtils.ts and book_birthday_slot (0027), the cancellation
          rule in cancel_own_booking (0048), and the deposit comes from each
          package (or from Online Payments). */}
      <div className="space-y-4 bg-white border border-brand-clay/70 rounded-3xl p-5 sm:p-6 shadow-2xs">
        <div className="border-b border-brand-clay/50 pb-3">
          <h3 className="font-display text-lg font-extrabold text-brand-charcoal flex items-center gap-2">
            <Gift className="h-5 w-5 text-brand-terracotta" />
            <span>{t('Birthday Booking Rules', 'قواعد حجز أعياد الميلاد')}</span>
          </h3>
          <p className="text-xs text-brand-charcoal/70 mt-1">
            {t('These rules are fixed by the booking system and cannot be changed here.', 'هذه القواعد ثابتة في نظام الحجز ولا يمكن تغييرها من هنا.')}
          </p>
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-brand-charcoal/80">
          <li className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl">
            <span className="block font-bold text-brand-charcoal">{t('Booking notice', 'مدة الإشعار المسبق')}</span>
            {t('1 day for 3–4 people; 4 days for 5 or more.', 'يوم واحد لعدد 3–4 أشخاص، و4 أيام لعدد 5 أشخاص أو أكثر.')}
          </li>
          <li className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl">
            <span className="block font-bold text-brand-charcoal">{t('Parties per day', 'عدد الحفلات في اليوم')}</span>
            {t(`At most ${BIRTHDAY_DAILY_MAX} a day, and ${BIRTHDAY_SAME_SLOT_MAX} at the same time.`, `بحد أقصى ${BIRTHDAY_DAILY_MAX} في اليوم، و${BIRTHDAY_SAME_SLOT_MAX} في الوقت نفسه.`)}
          </li>
          <li className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl">
            <span className="block font-bold text-brand-charcoal">{t('Cancellation', 'الإلغاء')}</span>
            {t(`A paid booking cancelled more than ${REFUND_NOTICE_HOURS} hours before the start is refunded; within ${REFUND_NOTICE_HOURS} hours, no refund.`, `يُسترد الحجز المدفوع عند إلغائه قبل أكثر من ${REFUND_NOTICE_HOURS} ساعة من موعد البدء، ولا يوجد استرداد خلال ${REFUND_NOTICE_HOURS} ساعة.`)}
          </li>
          <li className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl">
            <span className="block font-bold text-brand-charcoal">{t('Deposit and guests', 'العربون وعدد الضيوف')}</span>
            {t('Set per package on the Birthday Event page; online payment amounts in Settings → Online Payments.', 'تُضبط لكل باقة في صفحة باقات أعياد الميلاد، ومبالغ الدفع الإلكتروني في الإعدادات ← الدفع الإلكتروني.')}
          </li>
        </ul>
      </div>


      {/* ================================================================= */}
      {/* BIRTHDAY TERMS & GUIDELINES — the customer-facing text, editable   */}
      {/* here rather than hardcoded on the Customer Site.                   */}
      {/* ================================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-5 sm:p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-3">
          <div>
            <h3 className="font-display text-lg font-extrabold text-brand-charcoal flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-brand-terracotta" />
              <span>{t('Birthday Terms & Guidelines', 'شروط وإرشادات أعياد الميلاد')}</span>
            </h3>
            <p className="text-xs text-brand-charcoal/70 mt-1">
              {lang === 'ar'
                ? <>تُعرض للعميل قبل تقديم حجز عيد الميلاد، ويجب أن يوافق عليها. استخدم <span className="font-mono font-bold">{'{deposit}'}</span> ليتبع النص عربون الباقة. قاعدة الإلغاء ثابتة: {REFUND_NOTICE_HOURS} ساعة.</>
                : <>Shown to the customer before they submit a birthday reservation, and they must accept it. Use <span className="font-mono font-bold">{'{deposit}'}</span> so the wording follows the package's deposit. The cancellation rule is fixed: {REFUND_NOTICE_HOURS} hours.</>}
            </p>
            <p className="text-[10px] font-mono font-bold text-brand-charcoal/45 mt-1">
              {t('Current version:', 'النسخة الحالية:')} {savedVersion}
              {termsDraft.dirty && <span className="ms-2 text-amber-700">{t('(unsaved changes)', '(تغييرات غير محفوظة)')}</span>}
            </p>
          </div>

          <button
            type="button"
            onClick={handleSaveTerms}
            className="px-5 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold shadow-sm flex items-center gap-2 cursor-pointer shrink-0"
          >
            <Save className="h-4 w-4" />
            <span>{t('Save Terms', 'حفظ الشروط')}</span>
          </button>
        </div>

        <SaveErrorBanner error={termsSave.error} onDismiss={termsSave.clear} />
        <ServerChangedNotice show={termsDraft.serverChanged} onLoad={termsDraft.discard} />
        {termsSaved && (
          <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-bold rounded-xl flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600" />
            <span>{t('Terms saved. New reservations will record this version on acceptance.', 'تم حفظ الشروط. ستسجّل الحجوزات الجديدة هذه النسخة عند الموافقة.')}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <ContentLanguageTabs value={termsLang} onChange={setTermsLang} arabicFilled={termsArabicFilled} />

            {termsLang === 'en' ? (
              <>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Section Title', 'عنوان القسم')} {t('(English)', '(بالإنجليزية)')}</label>
              <input
                type="text"
                value={terms.title}
                onChange={e => setTerms({ ...terms, title: e.target.value })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-bold text-brand-charcoal"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Opening Lines (one per line)', 'الأسطر الافتتاحية (واحد في كل سطر)')} {t('(English)', '(بالإنجليزية)')}</label>
              <LineListTextarea
                rows={2}
                value={terms.leadingItems}
                onChange={lines => setTerms({ ...terms, leadingItems: lines })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Supplies Intro', 'مقدمة المستلزمات')} {t('(English)', '(بالإنجليزية)')}</label>
              <input
                type="text"
                value={terms.suppliesIntro}
                onChange={e => setTerms({ ...terms, suppliesIntro: e.target.value })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Supplies List (one per line, shown numbered)', 'قائمة المستلزمات (واحد في كل سطر، تُعرض مرقّمة)')} {t('(English)', '(بالإنجليزية)')}</label>
              <LineListTextarea
                rows={4}
                value={terms.supplies}
                onChange={lines => setTerms({ ...terms, supplies: lines })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Closing Lines (one per line)', 'الأسطر الختامية (واحد في كل سطر)')} {t('(English)', '(بالإنجليزية)')}</label>
              <LineListTextarea
                rows={4}
                value={terms.trailingItems}
                onChange={lines => setTerms({ ...terms, trailingItems: lines })}
                className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal"
              />
            </div>
              </>
            ) : (
              <>
                <p className="text-[11px] text-brand-charcoal/60 leading-relaxed">
                  {t(
                    'Shown to customers browsing in Arabic only once the Arabic opening lines or supplies list has content; otherwise they see the English terms. The whole set switches together — languages are never mixed. Include {deposit} and {cancellationDays} in the Arabic text too.',
                    'تظهر الشروط العربية للعملاء الذين يتصفحون بالعربية فقط عند تعبئة الأسطر الافتتاحية أو قائمة المستلزمات بالعربية؛ وإلا تظهر لهم الشروط الإنجليزية. وتتبدّل المجموعة كاملةً معًا ولا تُخلط اللغتان. أدرج {deposit} و{cancellationDays} في النص العربي أيضًا.'
                  )}
                </p>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Section Title', 'عنوان القسم')} {t('(Arabic)', '(بالعربية)')}</label>
                  <input
                    type="text" dir="rtl" lang="ar"
                    value={terms.titleAr ?? ''}
                    onChange={e => setTerms({ ...terms, titleAr: e.target.value })}
                    className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-bold text-brand-charcoal text-start"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Opening Lines (one per line)', 'الأسطر الافتتاحية (واحد في كل سطر)')} {t('(Arabic)', '(بالعربية)')}</label>
                  <div dir="rtl" lang="ar">
                    <LineListTextarea
                      rows={2}
                      value={terms.leadingItemsAr ?? []}
                      onChange={lines => setTerms({ ...terms, leadingItemsAr: lines })}
                      className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal text-start"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Supplies Intro', 'مقدمة المستلزمات')} {t('(Arabic)', '(بالعربية)')}</label>
                  <input
                    type="text" dir="rtl" lang="ar"
                    value={terms.suppliesIntroAr ?? ''}
                    onChange={e => setTerms({ ...terms, suppliesIntroAr: e.target.value })}
                    className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal text-start"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Supplies List (one per line, shown numbered)', 'قائمة المستلزمات (واحد في كل سطر، تُعرض مرقّمة)')} {t('(Arabic)', '(بالعربية)')}</label>
                  <div dir="rtl" lang="ar">
                    <LineListTextarea
                      rows={4}
                      value={terms.suppliesAr ?? []}
                      onChange={lines => setTerms({ ...terms, suppliesAr: lines })}
                      className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal text-start"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-charcoal/70 uppercase block">{t('Closing Lines (one per line)', 'الأسطر الختامية (واحد في كل سطر)')} {t('(Arabic)', '(بالعربية)')}</label>
                  <div dir="rtl" lang="ar">
                    <LineListTextarea
                      rows={4}
                      value={terms.trailingItemsAr ?? []}
                      onChange={lines => setTerms({ ...terms, trailingItemsAr: lines })}
                      className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-xs font-semibold text-brand-charcoal text-start"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Live preview with the placeholders resolved */}
          <div dir={previewIsAr ? 'rtl' : undefined} lang={previewIsAr ? 'ar' : undefined}
               className="p-5 bg-brand-cream/50 border border-brand-clay rounded-2xl space-y-3">
            <p className="text-[10px] font-bold text-brand-charcoal/50 uppercase tracking-wider">
              {t('Customer Preview', 'معاينة العميل')}
            </p>
            {previewArEmpty && (
              <p className="text-xs italic text-brand-charcoal/55" dir="ltr">
                {t(
                  'No Arabic terms yet — customers browsing in Arabic currently see the English terms.',
                  'لا توجد شروط عربية بعد — يرى العملاء الذين يتصفحون بالعربية الشروط الإنجليزية حاليًا.'
                )}
              </p>
            )}
            {(!previewIsAr || pv.title) && (
              <h4 className="font-display text-base font-bold text-brand-terracotta">{pv.title}</h4>
            )}
            <div className="text-xs space-y-2 text-brand-charcoal/85 leading-relaxed">
              {pv.leadingItems.map((line, idx) => (
                <p key={idx} className="font-semibold">
                  {renderTermsLine(line, { deposit: 500 })}
                </p>
              ))}
              {pv.supplies.length > 0 && (
                <div>
                  {(!previewIsAr || pv.suppliesIntro) && <p className="font-semibold">{pv.suppliesIntro}</p>}
                  <ol className="list-decimal ps-5 space-y-0.5 font-medium text-brand-charcoal/75">
                    {pv.supplies.map((item, idx) => <li key={idx}>{item}</li>)}
                  </ol>
                </div>
              )}
              {pv.trailingItems.map((line, idx) => (
                <p key={idx} className="font-medium">
                  {renderTermsLine(line, { deposit: 500 })}
                </p>
              ))}
            </div>
            <p className="text-[10px] text-brand-charcoal/45 pt-2 border-t border-brand-clay/40">
              {t("Deposit shown here uses 500 SAR as an example; the reservation page uses the selected package's deposit.", 'يستخدم العربون المعروض هنا مبلغ 500 ريال كمثال؛ تستخدم صفحة الحجز عربون الباقة المختارة.')}
            </p>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* BIRTHDAY BOOKING FORM FIELDS — configured here, not on the        */}
      {/* Birthday Event page (which edits package details only).           */}
      {/* ================================================================= */}
      <div className="bg-white border border-brand-clay/70 rounded-3xl p-5 sm:p-6 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-clay/50 pb-3">
          <div>
            <h3 className="font-display text-lg font-extrabold text-brand-charcoal flex items-center gap-2">
              <ListChecks className="h-5 w-5 text-brand-terracotta" />
              <span>{t('Birthday Booking Form Fields', 'حقول نموذج حجز عيد الميلاد')}</span>
            </h3>
            <p className="text-xs text-brand-charcoal/70 mt-1">
              {t('Add, edit, remove, enable, disable and reorder the fields customers fill in when booking a birthday package. Package details themselves are edited in the Birthday Event page.', 'أضف الحقول التي يملؤها العملاء عند حجز باقة عيد ميلاد وعدّلها وأزلها وفعّلها وعطّلها ورتّبها. تُعدَّل تفاصيل الباقات نفسها في صفحة إدارة باقات أعياد الميلاد.')}
            </p>
          </div>

          <button
            type="button"
            onClick={handleAddField}
            className="px-4 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold shadow-sm flex items-center gap-2 cursor-pointer shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>{t('Add Field', 'إضافة حقل')}</span>
          </button>
        </div>

        <SaveErrorBanner error={fieldsSave.error} onDismiss={fieldsSave.clear} />
        <ServerChangedNotice show={fieldsDraft.serverChanged} onLoad={fieldsDraft.discard} />
        {fieldsSaved && (
          <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-bold rounded-xl flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600" />
            <span>{t('Booking form updated. The customer birthday form now uses these fields.', 'تم تحديث نموذج الحجز. يستخدم نموذج عيد الميلاد للعملاء هذه الحقول الآن.')}</span>
          </div>
        )}

        <div className="space-y-3">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className={`border rounded-2xl p-4 space-y-3 ${
                field.enabled ? 'border-brand-clay bg-white' : 'border-brand-clay/50 bg-brand-sand/20 opacity-70'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] font-mono font-bold text-brand-charcoal/40">#{index + 1}</span>
                  <span className="text-sm font-bold text-brand-charcoal truncate">{field.label}</span>
                  {field.system && (
                    <span className="text-[9px] font-bold uppercase bg-brand-sand text-brand-charcoal/70 px-1.5 py-0.5 rounded">{t('Core', 'أساسي')}</span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleField(field.id)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border cursor-pointer ${
                      field.enabled
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        : 'bg-gray-100 border-gray-200 text-gray-600'
                    }`}
                  >
                    {field.enabled ? t('Enabled', 'مفعّل') : t('Disabled', 'معطّل')}
                  </button>
                  <button
                    type="button"
                    title={t('Move up', 'نقل للأعلى')}
                    disabled={index === 0}
                    onClick={() => handleMoveField(index, -1)}
                    className="p-1.5 rounded-lg border border-brand-clay/60 text-brand-charcoal/60 hover:bg-brand-sand disabled:opacity-30 cursor-pointer"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t('Move down', 'نقل للأسفل')}
                    disabled={index === fields.length - 1}
                    onClick={() => handleMoveField(index, 1)}
                    className="p-1.5 rounded-lg border border-brand-clay/60 text-brand-charcoal/60 hover:bg-brand-sand disabled:opacity-30 cursor-pointer"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={field.system ? t('Core fields cannot be removed — disable instead', 'لا يمكن إزالة الحقول الأساسية — عطّلها بدلًا من ذلك') : t('Remove field', 'إزالة الحقل')}
                    disabled={field.system}
                    onClick={() => handleRemoveField(field.id)}
                    className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/70 block">{t('Label', 'التسمية')}</label>
                  <input
                    type="text"
                    value={field.label}
                    onChange={e => editFieldLocal(field.id, { label: e.target.value })}
                    onBlur={commitIfEdited}
                    className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/70 block">{t('Type', 'النوع')}</label>
                  <select
                    value={field.type}
                    disabled={field.system}
                    onChange={e => handleFieldChange(field.id, { type: e.target.value as BirthdayFormField['type'] })}
                    className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold disabled:opacity-60"
                  >
                    <option value="short_text">{t('Short text', 'نص قصير')}</option>
                    <option value="long_text">{t('Long text', 'نص طويل')}</option>
                    <option value="number">{t('Number', 'رقم')}</option>
                    <option value="date">{t('Date', 'تاريخ')}</option>
                    <option value="time">{t('Time', 'وقت')}</option>
                    <option value="phone">{t('Phone', 'هاتف')}</option>
                    <option value="dropdown">{t('Dropdown', 'قائمة منسدلة')}</option>
                    <option value="package">{t('Package selector', 'محدد الباقة')}</option>
                    <option value="image">{t('Image upload', 'رفع صورة')}</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-brand-charcoal/70 block">{t('Required', 'إلزامي')}</label>
                  <button
                    type="button"
                    onClick={() => handleFieldChange(field.id, { required: !field.required })}
                    className={`w-full py-2 rounded-xl text-[11px] font-bold border cursor-pointer ${
                      field.required
                        ? 'bg-brand-terracotta/10 border-brand-terracotta/40 text-brand-terracotta'
                        : 'bg-brand-cream/40 border-brand-clay text-brand-charcoal/60'
                    }`}
                  >
                    {field.required ? t('Required', 'إلزامي') : t('Optional', 'اختياري')}
                  </button>
                </div>

                <div className="sm:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block">{t('Placeholder', 'النص التوضيحي')}</label>
                    <input
                      type="text"
                      value={field.placeholder || ''}
                      onChange={e => editFieldLocal(field.id, { placeholder: e.target.value })}
                      onBlur={commitIfEdited}
                      className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block">{t('Help Text', 'نص المساعدة')}</label>
                    <input
                      type="text"
                      value={field.helpText || ''}
                      onChange={e => editFieldLocal(field.id, { helpText: e.target.value })}
                      onBlur={commitIfEdited}
                      className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold"
                    />
                  </div>
                </div>

                {field.type === 'dropdown' && (
                  <div className="sm:col-span-3 space-y-1">
                    <label className="font-bold text-brand-charcoal/70 block">{t('Options (one per line)', 'الخيارات (واحد في كل سطر)')}</label>
                    <LineListTextarea
                      rows={4}
                      value={field.options || []}
                      onChange={options => editFieldLocal(field.id, { options })}
                      onBlur={commitIfEdited}
                      className="w-full bg-brand-cream/40 border border-brand-clay rounded-xl p-2 font-semibold"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
