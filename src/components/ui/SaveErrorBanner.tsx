/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The red banner a Settings section shows when a save fails, plus the hook
 * that drives it. Wording comes from src/utils/saveErrors.ts.
 *
 *   const save = useSaveError();
 *   await save.run(() => updateSetting(...), { en: 'capacity', ar: 'السعة' });
 *   <SaveErrorBanner error={save.error} onDismiss={save.clear} />
 */

import React, { useCallback, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { saveErrorText, type SaveErrorText } from '../../utils/saveErrors';

export function useSaveError() {
  const [error, setError] = useState<SaveErrorText | null>(null);

  /** Runs `write`; on failure records the message and returns false. */
  const run = useCallback(async (write: () => Promise<unknown>, what?: SaveErrorText): Promise<boolean> => {
    setError(null);
    try {
      await write();
      return true;
    } catch (err) {
      console.error('Settings save failed:', err);
      setError(saveErrorText(err, what));
      return false;
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { error, run, clear };
}

export const SaveErrorBanner: React.FC<{ error: SaveErrorText | null; onDismiss?: () => void; className?: string }> = ({
  error, onDismiss, className = ''
}) => {
  const { t } = useLanguage();
  if (!error) return null;
  return (
    <div role="alert" className={`flex items-start gap-2 p-3 rounded-xl border border-red-300 bg-red-50 text-xs font-bold text-red-800 ${className}`}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
      <span className="flex-1">{t(error.en, error.ar)}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={t('Dismiss', 'إغلاق')} className="cursor-pointer text-red-700 hover:text-red-900">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};
