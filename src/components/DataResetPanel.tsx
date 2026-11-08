/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings -> Data Reset. Super Admin only (the sidebar hides it and the
 * Settings page refuses to render it for anyone else).
 *
 * This deletes LIVE data in the shared database — bookings, customers, queue,
 * pieces, workshops, events, notifications — for every device, at once. So it
 * is not behind a browser confirm() any more: the Super Admin must type the
 * exact phrase DATA_RESET_PHRASE ("DELETE EVERYTHING") first.
 *
 * Server-side: the deletes run as the signed-in staff member under the
 * tables' RLS policies, which allow writes to staff generally — the database
 * does not yet restrict this to Super Admins. Hiding it here is the UI half.
 */

import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { DATA_RESET_PHRASE, isDataResetConfirmed, isSuperAdmin } from '../utils/adminAccess';

export const DataResetPanel: React.FC = () => {
  const { currentStaff, removeAllData } = useApp();
  const { t } = useLanguage();
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!isSuperAdmin(currentStaff)) {
    return (
      <p className="text-sm text-brand-charcoal/70">
        {t('Only a Super Admin can use Data Reset.', 'إعادة ضبط البيانات متاحة للمشرف العام فقط.')}
      </p>
    );
  }

  const confirmed = isDataResetConfirmed(typed);

  const run = async () => {
    if (!confirmed || running) return;
    setRunning(true);
    setResult(null);
    try {
      await removeAllData();
      setTyped('');
      setResult({ ok: true, message: t('All website data has been deleted.', 'تم حذف جميع بيانات الموقع.') });
    } catch (err: any) {
      setResult({
        ok: false,
        message: t('The reset stopped part-way: ', 'توقفت إعادة الضبط في منتصفها: ') + (err?.message || String(err))
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="border-b border-brand-clay/40 pb-4">
        <h2 className="font-display text-xl font-extrabold text-brand-charcoal">{t('Data Reset', 'إعادة ضبط البيانات')}</h2>
        <p className="text-xs text-brand-charcoal/70 mt-1">
          {t('Super Admin only. This acts on the live database, for everyone.', 'للمشرف العام فقط. يعمل على قاعدة البيانات الفعلية، لجميع المستخدمين.')}
        </p>
      </div>

      <div className="p-5 bg-red-50/50 border border-red-200 rounded-2xl space-y-4 max-w-xl">
        <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
          <Trash2 className="h-5 w-5" />
          <span>{t('Delete all website data', 'حذف جميع بيانات الموقع')}</span>
        </div>
        <p className="text-xs text-brand-charcoal/80 leading-relaxed">
          {t(
            'Permanently deletes every customer, booking, queue entry, pottery piece, workshop, session, event and notification from the live database. Staff profiles and studio configuration (pipeline stages, birthday packages, option lists, settings) are kept. This cannot be undone.',
            'يحذف نهائيًا جميع العملاء والحجوزات وإدخالات الطابور وقطع الفخار والورش والجلسات والفعاليات والإشعارات من قاعدة البيانات الفعلية. تُحفظ ملفات الموظفين وإعدادات الاستوديو (مراحل المسار وباقات أعياد الميلاد وقوائم الخيارات والإعدادات). لا يمكن التراجع عن هذا الإجراء.'
          )}
        </p>
        <label className="block text-xs font-semibold text-brand-charcoal">
          {t('To confirm, type', 'للتأكيد، اكتب')}{' '}
          <code className="px-1.5 py-0.5 rounded bg-white border border-red-200 text-red-700 font-mono">{DATA_RESET_PHRASE}</code>
          <input
            type="text"
            value={typed}
            onChange={e => { setTyped(e.target.value); setResult(null); }}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            className="mt-2 w-full bg-white border border-red-200 rounded-xl py-2.5 px-3 text-sm font-mono text-brand-charcoal focus:ring-1 focus:ring-red-500 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={run}
          disabled={!confirmed || running}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-2 cursor-pointer"
        >
          <Trash2 className="h-4 w-4" />
          <span>{running ? t('Deleting…', 'جارٍ الحذف…') : t('Delete everything', 'حذف كل شيء')}</span>
        </button>
        {result && (
          <p className={`text-xs font-semibold ${result.ok ? 'text-brand-sage' : 'text-red-600'}`}>{result.message}</p>
        )}
      </div>
    </div>
  );
};
