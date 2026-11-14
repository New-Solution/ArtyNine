/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * The site's page-level "Back to …" control.
 *
 * Every page that steps backwards — workshop detail, both checkout steps, the
 * birthday booking and packages pages, and the two console editors — had its
 * own copy of these classes, which had drifted apart on radius, padding and
 * icon size. They are defined once here so the control cannot drift again.
 *
 * Placement is deliberately not baked in: the call sites sit in headers, cards
 * and toolbars with their own spacing, so margins come through `className`
 * rather than being fixed here. Nothing about the button's own shape, colour or
 * type is overridable, which is the point.
 *
 * Scope note: this is for page-level back navigation only. A step-back inside a
 * wizard, a segmented view switcher and a Cancel button are different controls
 * that happen to point backwards, and they keep their own styling.
 */
export interface BackButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  /** Placement only — margins from the surrounding layout. */
  className?: string;
}

export const BackButton: React.FC<BackButtonProps> = ({ onClick, children, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-brand-clay bg-brand-cream px-4 py-2 text-xs font-semibold text-brand-terracotta transition-colors hover:bg-brand-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-sage ${className}`}
  >
    {/* flip-rtl so the arrow points back, not forward, in Arabic. */}
    <ArrowLeft className="h-4 w-4 flip-rtl" />
    <span>{children}</span>
  </button>
);
