/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { StudioTableConfig, CapacitySettingsConfig } from '../types';
import { Save, AlertTriangle, Plus, Trash2, Check, LayoutGrid } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';
import { tableSeatTotal } from '../utils/tableSeatingUtils';
import { useServerDraft, ServerChangedNotice } from './ui/useServerDraft';
import { SaveErrorBanner, useSaveError } from './ui/SaveErrorBanner';

const SAVE_CAPACITY = { en: 'the capacity settings', ar: 'إعدادات السعة' };
const SAVE_RESOURCES = { en: 'the studio rooms', ar: 'قاعات الاستوديو' };

const DEFAULT_TABLES: StudioTableConfig[] = Array.from({ length: 8 }, (_, i) => ({
  id: `table-${i + 1}`, number: i + 1, name: `Table ${i + 1}`, seats: 4, status: 'Active' as const
}));

export const AdminCapacitySettings: React.FC = () => {
  const {
    updateSetting,
    studioResources,
    addStudioResource,
    updateStudioResource,
    removeStudioResource,
    // Already provided by the shared data layer.
    appSettings: rawAppSettings,
    queue: rawQueue
  } = useApp();
  const { lang, t } = useLanguage();

  const [resourceToast, setResourceToast] = useState<string | null>(null);
  const showResourceToast = (msg: string) => {
    setResourceToast(msg);
    setTimeout(() => setResourceToast(null), 3500);
  };

  const capacitySave = useSaveError();
  const resourceSave = useSaveError();

  const handleAddResource = async () => {
    const roomCount = studioResources.filter(r => r.type === 'Studio Room').length;
    const ok = await resourceSave.run(() => addStudioResource({
      name: `Studio Room ${roomCount + 1}`,
      type: 'Studio Room',
      seats: 10,
      location: '',
      notes: '',
      status: 'Active',
      order: studioResources.length
    }), SAVE_RESOURCES);
    if (!ok) return;
    showResourceToast(t('Resource added. It is now selectable on the Workshop pages.', 'تمت إضافة المورد. يمكن اختياره الآن في صفحات الورش.'));
  };

  const handleSetResourceStatus = async (id: string, status: 'Active' | 'Inactive' | 'Maintenance', name: string) => {
    const ok = await resourceSave.run(() => updateStudioResource(id, { status }), SAVE_RESOURCES);
    if (!ok) return;
    showResourceToast(t(`"${name}" set to ${status}.`, `تم ضبط "${name}" على ${enumLabel('resourceStatus', status, lang)}.`));
  };

  const handleRemoveResource = async (id: string, name: string) => {
    if (!window.confirm(t(`Remove "${name}"? If it is used by existing sessions it will be set to Inactive instead.`, `إزالة "${name}"؟ إذا كان مستخدمًا في جلسات قائمة فسيتم ضبطه على «غير نشط» بدلًا من ذلك.`))) return;
    let result: Awaited<ReturnType<typeof removeStudioResource>> | undefined;
    const ok = await resourceSave.run(async () => { result = await removeStudioResource(id); }, SAVE_RESOURCES);
    if (!ok || !result) return;
    showResourceToast(result.message || t(`"${name}" removed.`, `تمت إزالة "${name}".`));
  };
  const rawConfig = rawAppSettings.find(s => s.id === 'capacitySettings')?.value as CapacitySettingsConfig | undefined;

  // One draft for the whole form. It follows the saved value until edited, and
  // a realtime update never wipes unsaved edits (useServerDraft).
  const capacity = useServerDraft<CapacitySettingsConfig>({
    defaultSeatsPerTable: rawConfig?.defaultSeatsPerTable ?? 4,
    oneGroupPerTable: rawConfig?.oneGroupPerTable ?? false,
    tables: rawConfig?.tables && rawConfig.tables.length > 0 ? rawConfig.tables : DEFAULT_TABLES
  });
  const { defaultSeatsPerTable, oneGroupPerTable } = capacity.draft;
  const tablesList = capacity.draft.tables;
  const setDraft = (patch: Partial<CapacitySettingsConfig>) => capacity.setDraft(d => ({ ...d, ...patch }));
  const setTablesList = (tables: StudioTableConfig[]) => setDraft({ tables });
  /** Replaces one table immutably (the old code edited the array in place). */
  const updateTable = (idx: number, patch: Partial<StudioTableConfig>) =>
    setTablesList(tablesList.map((tbl, i) => (i === idx ? { ...tbl, ...patch } : tbl)));

  // The seat total is always the sum of the tables' seats — never typed in.
  const totalSeats = tableSeatTotal(tablesList);

  const [warningBanner, setWarningBanner] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    // Sum active occupancy in Live Queue (In Progress or Waiting)
    const activeOccupancy = rawQueue
      .filter(q => q.status === 'In Progress' || q.status === 'Waiting')
      .reduce((sum, item) => sum + (item.participants || 1), 0);

    // Only what is read is stored: no totalSeats / totalTables / maxGroupSize.
    const updatedConfig: CapacitySettingsConfig = {
      defaultSeatsPerTable: Number(defaultSeatsPerTable) || 4,
      oneGroupPerTable,
      tables: tablesList
    };

    const ok = await capacitySave.run(() => updateSetting('capacitySettings', updatedConfig), SAVE_CAPACITY);
    if (!ok) return;
    capacity.markSaved(updatedConfig);

    if (activeOccupancy > totalSeats) {
      setWarningBanner(t(
        `Current occupancy (${activeOccupancy} seats) exceeds the tables' total (${totalSeats} seats). Active sessions are preserved, but available capacity is set to 0.`,
        `يتجاوز الإشغال الحالي (${activeOccupancy} مقعد) إجمالي مقاعد الطاولات (${totalSeats} مقعد). تُحفظ الجلسات النشطة، لكن السعة المتاحة تُضبط على 0.`
      ));
    } else {
      setWarningBanner(null);
    }

    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleAddTable = () => {
    const nextNum = tablesList.length + 1;
    setTablesList([
      ...tablesList,
      {
        id: `table-${Date.now()}`,
        number: nextNum,
        name: `Table ${nextNum}`,
        seats: defaultSeatsPerTable,
        status: 'Active'
      }
    ]);
  };

  const handleRemoveTable = (id: string) => {
    setTablesList(tablesList.filter(tbl => tbl.id !== id));
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="border-b border-brand-clay/40 pb-4">
        <h2 className="font-display text-xl font-extrabold text-brand-charcoal">{t('Studio & Queue Capacity Configuration', 'إعدادات سعة الاستوديو والطابور')}</h2>
        <p className="text-xs text-brand-charcoal/70 mt-1">
          {t('Manage live queue seat allocation, the table inventory and its seats. The studio’s seat total is the sum of the active tables’ seats.', 'إدارة تخصيص مقاعد الطابور المباشر وجرد الطاولات ومقاعدها. إجمالي مقاعد الاستوديو هو مجموع مقاعد الطاولات النشطة.')}
        </p>
      </div>

      {/* Warning banner if current occupancy exceeds total seats */}
      {warningBanner && (
        <div className="p-4 bg-amber-50 border-2 border-amber-300 rounded-2xl flex items-start gap-3 text-amber-900 shadow-sm animate-in slide-in-from-top-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed font-semibold">
            <p className="font-bold uppercase tracking-wider text-[11px] text-amber-800">{t('Capacity Warning', 'تحذير السعة')}</p>
            <p className="mt-0.5">{warningBanner}</p>
          </div>
        </div>
      )}

      <SaveErrorBanner error={capacitySave.error} onDismiss={capacitySave.clear} />
      <ServerChangedNotice show={capacity.serverChanged} onLoad={capacity.discard} />

      {savedSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-bold rounded-xl flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-600" />
          <span>{t('Capacity settings updated and applied across Live Queue & Admin modules!', 'تم تحديث إعدادات السعة وتطبيقها على الطابور المباشر ووحدات الإدارة!')}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Global capacity metrics. Tables and seats are COUNTED from the
            inventory below, not typed in; "Max Walk-in Group Size" was removed
            because nothing read it. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl space-y-1">
            <span className="text-xs font-bold text-brand-charcoal/80 block">{t('Total Tables', 'إجمالي الطاولات')}</span>
            <span className="block py-2 text-sm font-bold text-brand-charcoal font-mono">{tablesList.length}</span>
          </div>

          <div className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl space-y-1">
            <span className="text-xs font-bold text-brand-charcoal/80 block">{t('Total Studio Seats', 'إجمالي مقاعد الاستوديو')}</span>
            <span className="block py-2 text-sm font-bold text-brand-charcoal font-mono">{totalSeats}</span>
            <span className="block text-[10px] text-brand-charcoal/55">{t('Sum of the active tables’ seats', 'مجموع مقاعد الطاولات النشطة')}</span>
          </div>

          <div className="p-4 bg-brand-cream/35 border border-brand-clay rounded-2xl space-y-1">
            <label className="text-xs font-bold text-brand-charcoal/80 block">{t('Default Seats per Table', 'المقاعد الافتراضية لكل طاولة')}</label>
            <input
              type="number"
              min={1}
              value={defaultSeatsPerTable}
              onChange={e => setDraft({ defaultSeatsPerTable: parseInt(e.target.value) || 1 })}
              className="w-full bg-white border border-brand-clay rounded-xl py-2 px-3 text-sm font-bold text-brand-charcoal font-mono"
            />
          </div>
        </div>

        {/* Group per table policy */}
        <div className="p-4 bg-brand-cream/20 border border-brand-clay rounded-2xl flex items-center justify-between">
          <div>
            <span className="text-xs font-bold text-brand-charcoal block">{t('Strict Table Isolation (One Group per Table)', 'عزل صارم للطاولات (مجموعة واحدة لكل طاولة)')}</span>
            <span className="text-[11px] text-brand-charcoal/60">
              {t('When enabled, a table is locked to a single group regardless of leftover unseated chairs.', 'عند التفعيل، تُقفل الطاولة لمجموعة واحدة بغض النظر عن الكراسي المتبقية غير المشغولة.')}
            </span>
          </div>
          <input
            type="checkbox"
            checked={oneGroupPerTable}
            onChange={e => setDraft({ oneGroupPerTable: e.target.checked })}
            className="h-5 w-5 rounded border-brand-clay text-brand-terracotta focus:ring-brand-terracotta cursor-pointer"
          />
        </div>

        {/* Tables Inventory Management */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="font-display font-bold text-sm text-brand-charcoal uppercase tracking-wider">
              {t('Table Inventory & Seating Map', 'جرد الطاولات وخريطة الجلوس')} ({tablesList.length} {t('Tables', 'طاولة')})
            </h3>
            <button
              type="button"
              onClick={handleAddTable}
              className="px-3 py-1.5 bg-brand-sand hover:bg-brand-sand/80 text-brand-charcoal rounded-xl text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 text-brand-terracotta" />
              <span>{t('Add Table', 'إضافة طاولة')}</span>
            </button>
          </div>

          <div className="overflow-x-auto border border-brand-clay/60 rounded-2xl bg-white">
            <table className="w-full text-left text-xs">
              <thead className="bg-brand-cream/50 border-b border-brand-clay/60 text-[10px] uppercase font-bold text-brand-charcoal/70">
                <tr>
                  <th className="p-3">#</th>
                  <th className="p-3">{t('Table Name', 'اسم الطاولة')}</th>
                  <th className="p-3">{t('Seats', 'المقاعد')}</th>
                  <th className="p-3">{t('Status', 'الحالة')}</th>
                  <th className="p-3 text-right">{t('Actions', 'الإجراءات')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-clay/30">
                {tablesList.map((tbl, idx) => (
                  <tr key={tbl.id} className="hover:bg-brand-cream/20">
                    <td className="p-3 font-mono font-bold text-brand-charcoal/60">{tbl.number}</td>
                    <td className="p-3 font-bold text-brand-charcoal">
                      <input
                        type="text"
                        value={tbl.name}
                        onChange={e => updateTable(idx, { name: e.target.value })}
                        className="bg-transparent border border-brand-clay/40 rounded p-1 text-xs font-semibold text-brand-charcoal"
                      />
                    </td>
                    <td className="p-3 font-mono font-bold">
                      <input
                        type="number"
                        min={1}
                        value={tbl.seats}
                        onChange={e => updateTable(idx, { seats: parseInt(e.target.value) || 1 })}
                        className="w-16 bg-transparent border border-brand-clay/40 rounded p-1 text-xs font-semibold text-brand-charcoal text-center"
                      />
                    </td>
                    <td className="p-3">
                      <select
                        value={tbl.status}
                        onChange={e => updateTable(idx, { status: e.target.value as StudioTableConfig['status'] })}
                        className="bg-white border border-brand-clay/60 text-[11px] font-bold rounded-lg px-2 py-1"
                      >
                        <option value="Active">{enumLabel('resourceStatus', 'Active', lang)}</option>
                        <option value="Inactive">{enumLabel('resourceStatus', 'Inactive', lang)}</option>
                        <option value="Maintenance">{enumLabel('resourceStatus', 'Maintenance', lang)}</option>
                      </select>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemoveTable(tbl.id)}
                        className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg border border-brand-clay/30 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Save button */}
        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            className="px-6 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-2 cursor-pointer"
          >
            <Save className="h-4 w-4" />
            <span>{t('Save Capacity Settings', 'حفظ إعدادات السعة')}</span>
          </button>
        </div>
      </form>

      {/* ================================================================= */}
      {/* STUDIO ROOMS & TABLE STATIONS                                      */}
      {/* The shared resource records the workshop pages assign from.        */}
      {/* ================================================================= */}
      <div className="pt-8 mt-8 border-t border-brand-clay/40 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-extrabold text-brand-charcoal flex items-center gap-2">
              <LayoutGrid className="h-5 w-5 text-brand-terracotta" />
              <span>{t('Studio Rooms & Table Stations', 'قاعات الاستوديو ومحطات الطاولات')}</span>
            </h3>
            <p className="text-xs text-brand-charcoal/70 mt-1">
              {lang === 'ar'
                ? <>هذه هي الموارد التي تُسند إليها صفحات الورش الجلسات. لا يمكن إسناد جلسة جديدة إلا إلى الموارد <strong>النشطة</strong>؛ وتبقى الموارد غير النشطة وقيد الصيانة ظاهرة للجلسات السابقة.</>
                : <>These are the resources the Workshop pages assign sessions to. Only <strong>Active</strong> resources can take a new assignment; Inactive and Maintenance resources stay visible for historical sessions.</>}
            </p>
          </div>

          <button
            type="button"
            onClick={handleAddResource}
            className="px-4 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold shadow-sm flex items-center gap-2 cursor-pointer shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span>{t('Add Resource', 'إضافة مورد')}</span>
          </button>
        </div>

        <SaveErrorBanner error={resourceSave.error} onDismiss={resourceSave.clear} />
        {resourceToast && (
          <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-bold rounded-xl flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-600" />
            <span>{resourceToast}</span>
          </div>
        )}

        <div className="overflow-x-auto border border-brand-clay rounded-2xl bg-white">
          <table className="w-full text-xs text-left">
            <thead className="bg-brand-sand/40 text-brand-charcoal/60 uppercase tracking-wider font-bold">
              <tr>
                <th className="p-3">{t('Display Name', 'اسم العرض')}</th>
                <th className="p-3">{t('Type', 'النوع')}</th>
                <th className="p-3 text-center">{t('Seats', 'المقاعد')}</th>
                <th className="p-3">{t('Location / Notes', 'الموقع / ملاحظات')}</th>
                <th className="p-3">{t('Status', 'الحالة')}</th>
                <th className="p-3 text-right">{t('Actions', 'الإجراءات')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-clay/30">
              {studioResources.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-brand-charcoal/50 italic">
                    {t('No rooms or table stations yet. Add one so it appears in the Workshop assignment dropdowns.', 'لا توجد قاعات أو محطات طاولات بعد. أضف واحدة لتظهر في قوائم إسناد الورش.')}
                  </td>
                </tr>
              ) : (
                studioResources.map(resource => (
                  <tr
                    key={resource.id}
                    className={`hover:bg-brand-sand/15 ${resource.status !== 'Active' ? 'opacity-70' : ''}`}
                  >
                    <td className="p-2.5">
                      <input
                        type="text"
                        value={resource.name}
                        onChange={e => updateStudioResource(resource.id, { name: e.target.value })}
                        className="w-full bg-brand-cream/40 border border-brand-clay rounded-lg p-2 font-bold text-brand-charcoal"
                      />
                      <span className="text-[9px] font-mono text-brand-charcoal/35 block mt-0.5 pl-1">
                        {resource.id}
                      </span>
                    </td>

                    <td className="p-2.5">
                      <select
                        value={resource.type}
                        onChange={e => updateStudioResource(resource.id, { type: e.target.value as any })}
                        className="w-full bg-brand-cream/40 border border-brand-clay rounded-lg p-2 font-semibold text-brand-charcoal cursor-pointer"
                      >
                        <option value="Studio Room">{enumLabel('resourceType', 'Studio Room', lang)}</option>
                        <option value="Table Station">{enumLabel('resourceType', 'Table Station', lang)}</option>
                      </select>
                    </td>

                    <td className="p-2.5">
                      <input
                        type="number"
                        min={1}
                        value={resource.seats}
                        onChange={e => updateStudioResource(resource.id, { seats: Number(e.target.value) || 1 })}
                        className="w-16 bg-brand-cream/40 border border-brand-clay rounded-lg p-2 font-bold text-center text-brand-charcoal"
                      />
                    </td>

                    <td className="p-2.5">
                      <input
                        type="text"
                        placeholder={t('Optional location or notes', 'موقع أو ملاحظات اختيارية')}
                        value={resource.location || ''}
                        onChange={e => updateStudioResource(resource.id, { location: e.target.value })}
                        className="w-full bg-brand-cream/40 border border-brand-clay rounded-lg p-2 font-semibold text-brand-charcoal"
                      />
                    </td>

                    <td className="p-2.5">
                      <select
                        value={resource.status}
                        onChange={e => updateStudioResource(resource.id, { status: e.target.value as any })}
                        className={`w-full border rounded-lg p-2 font-bold cursor-pointer ${
                          resource.status === 'Active'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : resource.status === 'Maintenance'
                              ? 'bg-amber-50 border-amber-200 text-amber-800'
                              : 'bg-gray-100 border-gray-200 text-gray-600'
                        }`}
                      >
                        <option value="Active">{enumLabel('resourceStatus', 'Active', lang)}</option>
                        <option value="Inactive">{enumLabel('resourceStatus', 'Inactive', lang)}</option>
                        <option value="Maintenance">{enumLabel('resourceStatus', 'Maintenance', lang)}</option>
                      </select>
                    </td>

                    <td className="p-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {resource.status === 'Active' ? (
                          <button
                            type="button"
                            onClick={() => handleSetResourceStatus(resource.id, 'Inactive', resource.name)}
                            className="px-2.5 py-1.5 rounded-lg border border-brand-clay/60 text-brand-charcoal/70 hover:bg-brand-sand text-[11px] font-bold cursor-pointer"
                          >
                            {t('Disable', 'تعطيل')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSetResourceStatus(resource.id, 'Active', resource.name)}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-[11px] font-bold cursor-pointer"
                          >
                            {t('Reactivate', 'إعادة التفعيل')}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleRemoveResource(resource.id, resource.name)}
                          title={t('Remove — resources used by existing sessions are set to Inactive instead', 'إزالة — تُضبط الموارد المستخدمة في جلسات قائمة على «غير نشط» بدلًا من ذلك')}
                          className="p-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 cursor-pointer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-brand-charcoal/55">
          {t('Changes save immediately to the shared resource record, so the Workshop Monthly Schedule and Session Calendar pick them up without a refresh.', 'تُحفظ التغييرات فورًا في سجل الموارد المشترك، فتظهر في الجدول الشهري للورشة وتقويم الجلسات دون تحديث الصفحة.')}
        </p>
      </div>

    </div>
  );
};
