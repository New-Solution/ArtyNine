/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import { formatDateTime } from '../../utils/calendarConfig';
import { localizeNotification } from '../../utils/notificationText';

/**
 * The customer's piece-status notifications, behind a bell in the header.
 *
 * These used to render as full-width banners stacked down My Pieces, which
 * pushed the pieces themselves below the fold once there were more than one or
 * two — and meant a "your piece is ready" notice was only findable from the page
 * it was about. In the header it is reachable from anywhere on the customer site.
 *
 * NOT SHARED WITH THE STAFF BELL. AdminSidebar builds its own inline, around a
 * hand-inlined SVG rather than the lucide icon the rest of the app uses, and
 * clears by bulk-deleting where this marks individually read. Extracting one
 * component for both is the better end state and is recorded in
 * docs/parked-work.md; it would mean editing the staff console, which this pass
 * deliberately does not.
 */
export const CustomerNotificationBell: React.FC = () => {
  const { currentUser, notifications, markNotificationAsRead } = useApp();
  const { lang, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  /**
   * The same rule My Pieces applied, carried over unchanged: customer-type,
   * unread, matched on digits-only phone.
   *
   * The phone match is weaker than the RLS policy that already scopes this table
   * to the signed-in customer, and a notification whose stored phone is
   * formatted differently will not reach them — see docs/parked-work.md. Left
   * exactly as it was rather than quietly changing who sees what in a UI pass.
   */
  const customerNotifs = useMemo(() => {
    if (!currentUser) return [];
    return notifications
      .filter(n =>
        n.type === 'customer' &&
        n.customerPhone &&
        currentUser.phone &&
        n.customerPhone.replace(/\D/g, '') === currentUser.phone.replace(/\D/g, '') &&
        !n.isRead
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [notifications, currentUser]);

  const unreadCount = customerNotifs.length;

  // Outside click and Escape. The staff dropdown implements neither, which is
  // more forgiving in a console than in a sticky header that follows the
  // customer down every page.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Nothing to notify a visitor who is not signed in.
  if (!currentUser) return null;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unreadCount > 0
            ? t(`Notifications, ${unreadCount} unread`, `الإشعارات، ${unreadCount} غير مقروء`)
            : t('Notifications', 'الإشعارات')
        }
        className="relative cursor-pointer rounded-xl p-2 text-brand-charcoal transition-colors hover:bg-brand-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sage"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-terracotta text-[9px] font-bold text-brand-cream ring-2 ring-brand-cream ltr-numerals">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        /* Below sm the panel spans the viewport under the header (86px = the
           78px bar plus a gap) rather than hanging off the bell. The previous
           cap, min(20rem, calc(100vw - 2rem)), measured from the wrong origin:
           it assumed the panel was centred, but `end-0` anchors it to the bell
           in a shrink-0 cluster at the header's right edge, so on a narrow
           phone the left edge still crossed the viewport.

           From sm it is the anchored dropdown again at a plain w-80 — the cap
           only ever mattered on screens narrower than the panel. */
        <div
          role="dialog"
          aria-label={t('Notifications', 'الإشعارات')}
          className="fixed inset-x-4 top-[86px] z-50 max-h-[70vh] overflow-y-auto rounded-2xl border border-brand-clay bg-white p-4 shadow-xl animate-in fade-in slide-in-from-top-2 duration-150 sm:absolute sm:inset-x-auto sm:end-0 sm:top-auto sm:mt-2 sm:w-80"
        >
          <div className="flex items-center justify-between border-b border-brand-clay/60 pb-2">
            <span className={`text-xs font-bold uppercase ${lang === 'ar' ? '' : 'tracking-wider '}text-brand-charcoal`}>
              {t('Notifications', 'الإشعارات')}{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </span>
          </div>

          {unreadCount === 0 ? (
            <p className="pt-3 text-xs text-brand-muted">
              {t('No new updates. We will let you know when a piece moves along.', 'لا توجد تحديثات جديدة. سنُعلمك عند تقدّم حالة قطعتك.')}
            </p>
          ) : (
            <ul className="list-none space-y-2 pt-3">
              {customerNotifs.map(n => (
                <li
                  key={n.id}
                  className={`rounded-xl border p-3 text-start ${
                    n.highlighted
                      ? 'border-brand-terracotta bg-brand-sand/40'
                      : 'border-brand-clay/70 bg-brand-cream'
                  }`}
                >
                  <h4
                    className={`text-xs font-semibold ${
                      n.highlighted ? 'text-brand-terracotta' : 'text-brand-charcoal'
                    }`}
                  >
                    {localizeNotification(n, lang).title}
                  </h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-brand-ink whitespace-pre-line">{localizeNotification(n, lang).message}</p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[9px] font-semibold text-brand-charcoal/45">
                      {formatDateTime(n.timestamp)}
                    </span>
                    {/* Marks read, which is what Dismiss always did. There is no
                        read history: once dismissed it is gone from the
                        customer's view, exactly as before. */}
                    <button
                      type="button"
                      onClick={() => markNotificationAsRead(n.id)}
                      className="shrink-0 cursor-pointer rounded-lg border border-brand-clay bg-brand-sand/50 px-2.5 py-1 text-[10px] font-semibold text-brand-sage transition-colors hover:bg-brand-sand hover:text-brand-terracotta"
                    >
                      {t('Dismiss', 'تجاهل')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default CustomerNotificationBell;
