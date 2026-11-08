/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings -> Pottery Logging Console: the piece types offered when logging a
 * new piece (Pottery Pieces page, AdminPiecesTrackingSection).
 *
 * This used to be a full field editor — add fields, change labels, types,
 * required, enabled, order — but the logging form is fixed in code and read
 * only one thing from that configuration: the options of the 'pieceType'
 * field. Everything else was saved and ignored, so only the piece types are
 * edited now.
 *
 * Storage is unchanged: app_settings 'potteryLoggingConsoleFields', the same
 * array as before. Only the pieceType entry's options are rewritten; the other
 * entries are kept exactly as they are.
 */

import React, { useState } from 'react';
import { Check, RotateCcw, Save } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { DEFAULT_LOGGING_FIELDS, LoggingConsoleField } from '../types';
import { LineListTextarea } from './ui/LineListTextarea';
import { useServerDraft, ServerChangedNotice } from './ui/useServerDraft';
import { SaveErrorBanner, useSaveError } from './ui/SaveErrorBanner';

const PIECE_TYPE_KEY = 'pieceType';
const DEFAULT_PIECE_TYPES = DEFAULT_LOGGING_FIELDS.find(f => f.key === PIECE_TYPE_KEY)?.options || [];
const SAVE_WHAT = { en: 'the piece types', ar: 'أنواع القطع' };

/** The piece types currently in effect (saved ones, or the defaults). */
function pieceTypesOf(fields: LoggingConsoleField[]): string[] {
  const saved = (fields.find(f => f.key === PIECE_TYPE_KEY)?.options || []).map(o => o.trim()).filter(Boolean);
  return saved.length > 0 ? saved : DEFAULT_PIECE_TYPES;
}

/** The stored array with only the pieceType options replaced. */
function withPieceTypes(fields: LoggingConsoleField[], types: string[]): LoggingConsoleField[] {
  const hasField = fields.some(f => f.key === PIECE_TYPE_KEY);
  if (hasField) {
    return fields.map(f => (f.key === PIECE_TYPE_KEY ? { ...f, options: types } : f));
  }
  // A saved configuration without the field: add the default definition back.
  const base = DEFAULT_LOGGING_FIELDS.find(f => f.key === PIECE_TYPE_KEY);
  return base ? [...fields, { ...base, options: types }] : fields;
}

export const PotteryLoggingConsoleSettings: React.FC = () => {
  const { loggingFields, updateLoggingFields } = useApp();
  const { t } = useLanguage();
  const save = useSaveError();
  const draft = useServerDraft<string[]>(pieceTypesOf(loggingFields));
  const [saved, setSaved] = useState(false);

  const types = draft.draft;
  const isEmpty = types.length === 0;

  const handleSave = async () => {
    if (isEmpty) return;
    const ok = await save.run(() => updateLoggingFields(withPieceTypes(loggingFields, types)), SAVE_WHAT);
    if (!ok) return;
    draft.markSaved(types);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      <div>
        <h2 className="font-display text-xl font-bold text-brand-charcoal">{t('Pottery Logging Console', 'لوحة تسجيل الفخار')}</h2>
        <p className="text-xs text-brand-charcoal/60 mt-1">
          {t(
            'The piece types staff can choose when logging a new piece on the Pottery Pieces page. One per line.',
            'أنواع القطع التي يمكن للموظفين اختيارها عند تسجيل قطعة جديدة في صفحة القطع الفخارية. نوع واحد في كل سطر.'
          )}
        </p>
      </div>

      <SaveErrorBanner error={save.error} onDismiss={save.clear} />
      <ServerChangedNotice show={draft.serverChanged} onLoad={draft.discard} />

      <div className="space-y-1">
        <label htmlFor="piece-types" className="text-[11px] font-bold text-brand-charcoal/80 block">{t('Piece types', 'أنواع القطع')}</label>
        <div id="piece-types">
          <LineListTextarea
            rows={8}
            value={types}
            onChange={lines => draft.setDraft(lines)}
            className="w-full max-w-md bg-white border border-brand-clay rounded-xl p-3 text-sm font-semibold text-brand-charcoal"
          />
        </div>
        {isEmpty && (
          <p className="text-[11px] font-bold text-red-600">{t('Add at least one piece type.', 'أضف نوعًا واحدًا على الأقل.')}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isEmpty || !draft.dirty}
          className="px-5 py-2.5 bg-brand-terracotta hover:bg-brand-terracotta/90 text-brand-cream rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          <span>{saved ? t('Saved', 'تم الحفظ') : t('Save piece types', 'حفظ أنواع القطع')}</span>
        </button>
        <button
          type="button"
          onClick={() => draft.setDraft(DEFAULT_PIECE_TYPES)}
          className="px-4 py-2.5 border border-brand-clay rounded-xl text-xs font-bold text-brand-charcoal hover:bg-brand-sand/40 flex items-center gap-2 cursor-pointer"
        >
          <RotateCcw className="h-4 w-4" />
          <span>{t('Restore defaults', 'استعادة الافتراضي')}</span>
        </button>
      </div>
    </div>
  );
};
