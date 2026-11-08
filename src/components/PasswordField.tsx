/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { CREDENTIAL_INPUT_PROPS } from '../utils/credentialInput';

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
  /** The form's own input classes, so each screen keeps its existing styling. */
  className?: string;
  /** Extra room on the right for the toggle. Set false if the caller handles it. */
  reserveToggleSpace?: boolean;
  autoComplete?: string;
  disabled?: boolean;
}

/**
 * A password input with a show/hide toggle.
 *
 * Hidden by default. The toggle affects only this field, and is a real button
 * with an aria-label so it is reachable by keyboard and announced properly.
 * Styling comes from the caller: this exists so every password field behaves
 * the same, not to impose a look.
 */
export const PasswordField: React.FC<PasswordFieldProps> = ({
  value,
  onChange,
  placeholder = '••••••••',
  required = false,
  autoFocus = false,
  id,
  className = '',
  reserveToggleSpace = true,
  autoComplete,
  disabled = false
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        {...CREDENTIAL_INPUT_PROPS}
        id={id}
        type={visible ? 'text' : 'password'}
        required={required}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${className} ${reserveToggleSpace ? 'pr-10' : ''}`}
      />

      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-charcoal/40 hover:text-brand-charcoal/70 cursor-pointer p-0.5"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
};
