/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A form draft that follows a live server value until the user edits it.
 *
 * Settings arrive through a realtime subscription, so another admin's save
 * (or this admin's own save in another tab) changes the value under an open
 * form. Copying it into the form unconditionally wiped whatever was being
 * typed. Now:
 *   - not edited  -> the draft follows the server value as before;
 *   - edited      -> the draft is kept; if the server value changes meanwhile,
 *                    `serverChanged` turns true and <ServerChangedNotice> lets
 *                    the user load the newer version or keep editing (a save
 *                    then replaces it, knowingly).
 * Values are compared with stableKey(), since jsonb reorders keys.
 */

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { stableKey } from '../../utils/stableKey';

export function useServerDraft<T>(server: T) {
  const serverKey = stableKey(server);
  const [draft, setDraftState] = useState<T>(server);
  const [dirty, setDirty] = useState(false);
  // The server version the current draft started from.
  const [baseKey, setBaseKey] = useState(serverKey);
  const serverRef = useRef(server);
  serverRef.current = server;

  useEffect(() => {
    if (!dirty) {
      setDraftState(serverRef.current);
      setBaseKey(serverKey);
    }
    // Only a real change of the server value matters, not a new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const setDraft = (update: T | ((current: T) => T)) => {
    setDraftState(current => (typeof update === 'function' ? (update as (c: T) => T)(current) : update));
    setDirty(true);
  };

  /** Throw the edits away and take the current server value. */
  const discard = () => {
    setDraftState(serverRef.current);
    setBaseKey(stableKey(serverRef.current));
    setDirty(false);
  };

  /** After a successful save of `saved`: the draft IS the server value now. */
  const markSaved = (saved: T) => {
    setDraftState(saved);
    setBaseKey(stableKey(saved));
    setDirty(false);
  };

  return {
    draft,
    setDraft,
    dirty,
    /** Edited here AND changed on the server since editing began. */
    serverChanged: dirty && serverKey !== baseKey,
    discard,
    markSaved
  };
}

export const ServerChangedNotice: React.FC<{ show: boolean; onLoad: () => void }> = ({ show, onLoad }) => {
  const { t } = useLanguage();
  if (!show) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-amber-300 bg-amber-50 text-xs font-bold text-amber-900">
      <span className="flex-1">
        {t(
          'Someone saved changes to this section while you were editing. Your edits are kept; saving will replace their version.',
          'حفظ شخص آخر تغييرات على هذا القسم أثناء تعديلك. تم الإبقاء على تعديلاتك، وسيؤدي الحفظ إلى استبدال نسخته.'
        )}
      </span>
      <button
        type="button"
        onClick={onLoad}
        className="cursor-pointer inline-flex items-center gap-1 rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-amber-900 hover:bg-amber-100"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t('Load their version', 'تحميل نسختهم')}
      </button>
    </div>
  );
};
