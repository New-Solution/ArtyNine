/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { 
  LayoutDashboard, Users, CalendarDays, Palette, ListOrdered, 
  Flame, HelpCircle, ChevronLeft, ChevronRight, ChevronDown, Menu, LogOut, ShieldAlert, Settings, Sparkles, UserCheck
, Megaphone } from 'lucide-react';
import { SETTINGS_SECTIONS, getPageLabel, getSettingsSectionLabel } from '../utils/adminAccess';
import { formatTime, RIYADH_TIME_ZONE } from '../utils/calendarConfig';
import { LanguageToggle } from './LanguageToggle';
import { useLanguage } from '../context/LanguageContext';
import { enumLabel } from '../utils/enumLabels';
import { displayPosition } from '../utils/staffPosition';
import { localizeStaffNotification } from '../utils/staffNotificationText';

export const AdminSidebar: React.FC = () => {
  const {
    adminTab, setAdminTab, viewCustomerSite, currentStaff, canAccessAdminPage, logoutStaff,
    settingsSection, setSettingsSection
  } = useApp();
  const { lang, t } = useLanguage();
  const [collapsed, setCollapsed] = useState(false);
  // Settings is a parent item; its subsections live in this submenu.
  const [settingsOpen, setSettingsOpen] = useState(adminTab === 'settings');
  const collapseLabel = collapsed ? t('Expand sidebar', 'توسيع الشريط الجانبي') : t('Collapse sidebar', 'طيّ الشريط الجانبي');

  const allSidebarItems = [
    { id: 'dashboard', icon: LayoutDashboard },
    { id: 'queue', icon: ListOrdered },
    { id: 'customers', icon: Users },
    { id: 'staff', icon: UserCheck },
    { id: 'bookings', icon: CalendarDays },
    { id: 'workshops-admin', icon: Palette },
    { id: 'events-admin', icon: Sparkles },
    { id: 'pieces-admin', icon: Flame },
    { id: 'system-health', icon: ShieldAlert },
    { id: 'settings', icon: Settings },
  ] as const;

  // Only pages this account is authorized for are listed. The router enforces
  // the same rule, so hiding a button is not the security boundary.
  const sidebarItems = useMemo(
    () => allSidebarItems.filter(item => canAccessAdminPage(item.id)),
    [currentStaff]
  );

  return (
    <aside 
      className={`bg-brand-charcoal text-brand-cream border-r border-brand-clay/10 flex flex-col justify-between transition-all duration-300 shrink-0 overflow-hidden ${
        collapsed ? 'w-20' : 'w-16 lg:w-64'
      }`}
    >
      <div className="flex-1">
        {/* Header Branding */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-brand-clay/15">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-terracotta text-brand-cream">
              <Palette className="h-4.5 w-4.5" />
            </div>
            {!collapsed && (
              <div className="hidden lg:block text-left animate-in fade-in duration-200">
                <span className="font-display text-sm font-bold block">Arty Portal</span>
                <span className="text-[9px] text-brand-sage uppercase font-bold tracking-wider block">{t('Staff Console', 'لوحة تحكم الموظفين')}</span>
              </div>
            )}
          </div>

          <button 
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapseLabel}
            title={collapseLabel}
            className="p-1.5 hover:bg-brand-sand/15 rounded-lg text-brand-cream/60 hover:text-brand-cream focus:outline-none"
          >
            {collapsed ? <ChevronRight className="h-4.5 w-4.5" /> : <ChevronLeft className="h-4.5 w-4.5" />}
          </button>
        </div>

        {/* Navigation list */}
        <nav className="p-3 space-y-1">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            const isActive = adminTab === item.id;

            // Settings is a parent item with a submenu of its sections.
            if (item.id === 'settings') {
              return (
                <div key={item.id} className="space-y-1">
                  <button
                    onClick={() => {
                      if (collapsed) {
                        setAdminTab('settings');
                        return;
                      }
                      setSettingsOpen(open => !open);
                    }}
                    className={`flex items-center w-full rounded-xl p-3 text-sm font-semibold transition-all duration-150 cursor-pointer ${
                      isActive
                        ? 'bg-brand-terracotta text-brand-cream shadow-sm'
                        : 'text-brand-cream/70 hover:text-brand-cream hover:bg-brand-sand/10'
                    }`}
                  >
                    <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-brand-cream' : 'text-brand-sage'}`} />
                    {!collapsed && (
                      <span className="hidden lg:flex items-center flex-1">
                        <span className="ml-3 text-left leading-none flex-1">{getPageLabel(item.id, lang)}</span>
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 transition-transform ${settingsOpen ? 'rotate-180' : ''}`}
                        />
                      </span>
                    )}
                  </button>

                  {!collapsed && settingsOpen && (
                    <div className="hidden lg:block ml-4 pl-3 border-l border-brand-cream/15 space-y-0.5">
                      {SETTINGS_SECTIONS.map(section => {
                        const isSectionActive = isActive && settingsSection === section.id;
                        return (
                          <button
                            key={section.id}
                            onClick={() => {
                              setSettingsSection(section.id);
                              setAdminTab('settings');
                            }}
                            className={`flex items-center w-full rounded-lg px-3 py-2 text-xs font-semibold text-left transition-all cursor-pointer ${
                              isSectionActive
                                ? 'bg-brand-sand/20 text-brand-cream'
                                : 'text-brand-cream/55 hover:text-brand-cream hover:bg-brand-sand/10'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full mr-2.5 shrink-0 ${
                                isSectionActive ? 'bg-brand-terracotta' : 'bg-brand-cream/25'
                              }`}
                            />
                            <span className="leading-tight">{getSettingsSectionLabel(section.id, lang)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <button
                key={item.id}
                onClick={() => setAdminTab(item.id)}
                className={`flex items-center w-full rounded-xl p-3 text-sm font-semibold transition-all duration-150 cursor-pointer ${
                  isActive 
                    ? 'bg-brand-terracotta text-brand-cream shadow-sm' 
                    : 'text-brand-cream/70 hover:text-brand-cream hover:bg-brand-sand/10'
                }`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-brand-cream' : 'text-brand-sage'}`} />
                {!collapsed && <span className="hidden lg:inline ml-3 text-left leading-none">{getPageLabel(item.id, lang)}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Signed-in account, then sign out / back to the customer site */}
      <div className="p-3 border-t border-brand-clay/10 space-y-1">
        {currentStaff && !collapsed && (
          <div className="hidden lg:block px-3 py-2 mb-1">
            <p className="text-xs font-bold text-brand-cream truncate">{currentStaff.name}</p>
            <p className="text-[10px] font-semibold text-brand-sage">{enumLabel('staffRole', currentStaff.role || 'Staff', lang)}</p>
          </div>
        )}

        <button
          onClick={() => viewCustomerSite()}
          className="flex items-center w-full rounded-xl p-3 text-xs font-bold text-brand-cream/70 hover:text-brand-cream hover:bg-brand-terracotta/20 transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4 shrink-0 text-brand-terracotta" />
          {!collapsed && <span className="hidden lg:inline ml-3 text-left">{t('Customer Site', 'موقع العملاء')}</span>}
        </button>

        <button
          onClick={() => logoutStaff()}
          className="flex items-center w-full rounded-xl p-3 text-xs font-bold text-brand-cream/70 hover:text-brand-cream hover:bg-red-500/20 transition-all cursor-pointer"
        >
          <LogOut className="h-4 w-4 shrink-0 text-red-400" />
          {!collapsed && <span className="hidden lg:inline ml-3 text-left">{t('Sign Out', 'تسجيل الخروج')}</span>}
        </button>
      </div>
    </aside>
  );
};

export const AdminTopBar: React.FC = () => {
  const { currentStaff, notifications, clearAllNotifications, formattedTodayDate } = useApp();
  const { lang, t } = useLanguage();
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);

  // The date line. English is AppContext's string, untouched. Arabic is formatted here: Riyadh
  // time, Gregorian calendar, Latin digits like the rest of the console. Recomputed when the
  // language changes and when AppContext rolls formattedTodayDate over at midnight.
  const dateText = useMemo(() => lang === 'ar'
    ? new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
        timeZone: RIYADH_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      }).format(new Date())
    : formattedTodayDate, [lang, formattedTodayDate]);

  const staffNotifs = useMemo(() => {
    return notifications
      .filter(n => n.type === 'staff')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [notifications]);

  const unreadCount = staffNotifs.length;

  return (
    <header className="h-16 border-b border-brand-clay bg-brand-cream flex items-center justify-between px-6 shrink-0 text-left relative">
      {/* Current date and quick search */}
      <div className="flex items-center gap-6">
        <div className="hidden sm:block">
          <p className="text-xs font-bold text-brand-sage uppercase tracking-wider">{t("Today's Timeline", 'جدول اليوم')}</p>
          <p className="text-sm font-bold text-brand-charcoal">{dateText}</p>
        </div>
        
        {/* Quick Admin Search Bar */}
        <div className="relative max-w-xs">
          <input
            type="search"
            placeholder={t('Search bookings, pieces, phone...', 'ابحث في الحجوزات والقطع والهاتف...')}
            className="w-48 sm:w-64 bg-brand-sand/50 border border-brand-clay rounded-xl py-1.5 pl-3 pr-8 text-xs font-semibold text-brand-charcoal placeholder-brand-charcoal/40"
          />
        </div>
      </div>

      {/* Right User block */}
      <div className="flex items-center gap-4">
        {/* Console-scoped: reads the console's own language, never the customer
            site's, and the console stays left-to-right either way. */}
        <LanguageToggle />

        {/* Notification indicator */}
        <div className="relative">
          <button 
            onClick={() => setShowNotifDropdown(!showNotifDropdown)}
            aria-label={t('Notifications', 'الإشعارات')}
            className="p-1.5 text-brand-charcoal/70 hover:text-brand-terracotta hover:bg-brand-sand rounded-xl relative focus:outline-none cursor-pointer"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-brand-terracotta text-brand-cream text-[9px] font-bold flex items-center justify-center ring-2 ring-brand-cream">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Dropdown panel */}
          {showNotifDropdown && (
            <div className="absolute right-0 mt-2 w-80 bg-white border border-brand-clay rounded-2xl shadow-xl z-50 p-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex items-center justify-between border-b border-brand-clay/60 pb-2">
                <span className={`text-xs font-bold text-brand-charcoal uppercase${lang === 'ar' ? '' : ' tracking-wider'}`}>{t('Staff Activity Log', 'سجل نشاط الموظفين')} ({unreadCount})</span>
                {unreadCount > 0 && (
                  <button 
                    onClick={async () => {
                      await clearAllNotifications('staff');
                    }}
                    className="text-[10px] font-bold text-brand-terracotta hover:underline cursor-pointer"
                  >
                    {t('Clear All', 'مسح الكل')}
                  </button>
                )}
              </div>

              <div className="max-h-64 overflow-y-auto space-y-2.5 no-scrollbar">
                {staffNotifs.length === 0 ? (
                  <p className="text-[11px] text-brand-charcoal/40 text-center py-6 italic font-medium">{t('No recent piece status updates.', 'لا توجد تحديثات حديثة لحالة القطع.')}</p>
                ) : (
                  staffNotifs.map(n => (
                    <div 
                      key={n.id} 
                      className={`p-2.5 rounded-xl text-[11px] leading-snug border transition-all ${
                        n.highlighted 
                          ? 'bg-amber-50/75 border-amber-300 text-amber-900 ring-2 ring-amber-400/20 shadow-xs' 
                          : 'bg-brand-cream/35 border-brand-clay/60 text-brand-charcoal'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-bold text-brand-terracotta font-mono text-[9px]">{n.pieceId}</span>
                        <span className="text-[9px] text-brand-charcoal/45 font-semibold">
                          {formatTime(n.timestamp)}
                        </span>
                      </div>
                      <p dir="auto" className="font-semibold text-brand-charcoal/90 whitespace-pre-line">{localizeStaffNotification(n, lang).message}</p>
                      {n.highlighted && (
                        <span className="inline-block mt-1 text-[9px] uppercase font-bold text-brand-terracotta bg-brand-terracotta/10 px-1.5 py-0.5 rounded">
                          <Megaphone className="inline h-3 w-3 me-1 align-[-2px]" />
                          {t('Pickup Alert Dispatched', 'تم إرسال تنبيه الاستلام')}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Whoever is actually signed in. The name, the role and the initial
            all come from the session's staff record — the block used to be a
            stock photograph and a hardcoded name, which read as "Lina" to every
            member of staff. */}
        {currentStaff && (
          <div className="flex items-center gap-2 border-l border-brand-clay pl-4">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-terracotta text-xs font-bold text-brand-cream"
            >
              {(currentStaff.name || '?').trim().charAt(0).toUpperCase()}
            </span>
            <div className="hidden md:block">
              <p className="text-xs font-bold text-brand-charcoal">{currentStaff.name}</p>
              {/* Their job title — "Instructor", not the console permission
                  level, which is what `role` holds. */}
              {(currentStaff.position || currentStaff.role) && (
                <p className="text-[9px] font-bold text-brand-sage uppercase tracking-wider">
                  {currentStaff.position ? displayPosition(currentStaff.position, lang) : enumLabel('staffRole', currentStaff.role, lang)}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
};
