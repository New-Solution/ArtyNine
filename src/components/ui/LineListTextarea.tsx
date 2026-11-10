/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';

interface Props {
  /** The stored lines. */
  value: string[];
  /** Receives the parsed lines — trimmed, blanks dropped, exactly as before. */
  onChange: (lines: string[]) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Called when the field loses focus, after the draft is dropped — e.g. to save. */
  onBlur?: () => void;
}

/**
 * A textarea over a string[] where one line is one entry.
 *
 * These fields all shared a bug: the value was `lines.join('\n')` while every
 * keystroke parsed with `.filter(Boolean)`. Pressing Enter makes a trailing
 * empty line, the filter dropped it, and the re-render put the caret back at
 * the end of the previous line — so a new line was impossible to type, and a
 * blank line between entries could never be held long enough to type into.
 *
 * The fix is to keep what was typed verbatim in local state while the field has
 * focus, and to report the parsed lines separately. What gets stored is
 * unchanged; only the text on screen is now allowed to be mid-edit. Blur clears
 * the draft so the field re-syncs with whatever was actually saved.
 */
export const LineListTextarea: React.FC<Props> = ({
  value, onChange, rows = 3, placeholder, className = '', disabled, onBlur
}) => {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <textarea
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      value={draft ?? value.join('\n')}
      onChange={e => {
        const raw = e.target.value;
        setDraft(raw);
        onChange(raw.split('\n').map(line => line.trim()).filter(Boolean));
      }}
      onBlur={() => { setDraft(null); onBlur?.(); }}
    />
  );
};
