/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * Two panels, brown and then charcoal, that sweep up off the screen each time
 * the customer page changes.
 *
 * Presentation only: it watches the page key it is given and nothing else. It
 * does not navigate, scroll or hold anything back. The new page is already
 * mounted underneath, and the panels ignore the pointer the whole time. It is
 * skipped on first load (so a deep link opens straight onto its page) and
 * when the visitor prefers reduced motion.
 */
export const PageCurtain: React.FC<{ pageKey: string }> = ({ pageKey }) => {
  const reduce = useReducedMotion();
  // Compared with the last key rather than a "first render" flag, so React's
  // StrictMode double-run in development cannot play it on first load.
  const lastKey = useRef(pageKey);
  const [run, setRun] = useState(0);

  // Layout effect: the panels are in place before the new page is painted, so
  // the page never flashes for a frame before the curtain covers it.
  useLayoutEffect(() => {
    if (lastKey.current === pageKey) return;
    lastKey.current = pageKey;
    setRun(n => n + 1);
  }, [pageKey]);

  if (reduce || run === 0) return null;

  return (
    <div key={run} aria-hidden="true" className="pointer-events-none fixed inset-0 z-[80]">
      <motion.div
        className="absolute inset-0 origin-top bg-brand-terracotta"
        initial={{ scaleY: 1 }}
        animate={{ scaleY: 0 }}
        transition={{ duration: 0.75, ease: [0.76, 0, 0.24, 1] }}
      />
      <motion.div
        className="absolute inset-0 origin-top bg-brand-charcoal"
        initial={{ scaleY: 1 }}
        animate={{ scaleY: 0 }}
        transition={{ duration: 0.6, ease: [0.76, 0, 0.24, 1] }}
      />
    </div>
  );
};
