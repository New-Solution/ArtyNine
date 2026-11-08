/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin Console pages and the permission rules that guard them.
 *
 * The page list mirrors the Admin Console routes exactly — the same ids the
 * sidebar and App router use — so a permission can never name a page that does
 * not exist. There is one permission system, stored on the staff record.
 */

import { StaffMember, StaffRole } from '../types';
import type { Lang } from '../context/LanguageContext';

export type AdminPageId =
  | 'dashboard'
  | 'queue'
  | 'customers'
  | 'staff'
  | 'bookings'
  | 'workshops-admin'
  | 'events-admin'
  | 'pieces-admin'
  | 'system-health'
  | 'settings';

export interface AdminPage {
  id: AdminPageId;
  label: string;
  /** Arabic wording. These labels are fixed in code, not staff-editable. */
  labelAr: string;
}

/** The real Admin Console pages, in sidebar order. */
export const ADMIN_PAGES: AdminPage[] = [
  { id: 'dashboard', label: 'Dashboard', labelAr: 'لوحة المعلومات' },
  { id: 'queue', label: 'Live Queue', labelAr: 'الطابور المباشر' },
  { id: 'customers', label: 'Customers', labelAr: 'العملاء' },
  { id: 'staff', label: 'Staff Management', labelAr: 'إدارة الموظفين' },
  { id: 'bookings', label: 'Bookings', labelAr: 'الحجوزات' },
  { id: 'workshops-admin', label: 'Workshops', labelAr: 'الورش' },
  { id: 'events-admin', label: 'Events & Socials', labelAr: 'الفعاليات والمناسبات' },
  { id: 'pieces-admin', label: 'Pottery Pieces', labelAr: 'قطع الفخار' },
  { id: 'system-health', label: 'System Health', labelAr: 'حالة النظام' },
  { id: 'settings', label: 'Settings', labelAr: 'الإعدادات' }
];

export const ADMIN_PAGE_IDS: AdminPageId[] = ADMIN_PAGES.map(p => p.id);

export function getPageLabel(id: string, lang: Lang = 'en'): string {
  const page = ADMIN_PAGES.find(p => p.id === id);
  if (!page) return id;
  return lang === 'ar' ? page.labelAr : page.label;
}

/**
 * Pages only a Super Admin may open, whatever permissions are stored on the
 * account. The developer/testing area lives here, so it never appears for a
 * customer or a regular admin and cannot be reached by navigating to it.
 */
export const SUPER_ADMIN_ONLY_PAGES: AdminPageId[] = ['system-health'];

export function isSuperAdminOnlyPage(pageId: string): boolean {
  return SUPER_ADMIN_ONLY_PAGES.includes(pageId as AdminPageId);
}

/** The role itself grants unrestricted access; no page needs selecting. */
export function isSuperAdmin(staff?: StaffMember | null): boolean {
  return staff?.role === 'Super Admin';
}

/** Can this staff member sign in to the console at all? */
export function hasConsoleAccount(staff?: StaffMember | null): boolean {
  if (!staff) return false;
  if (staff.status === 'Inactive' || staff.status === 'Former Staff') return false;
  return staff.hasConsoleAccess === true;
}

/**
 * Page-level authorization. Checked before rendering a protected page and
 * before protected writes — not only when drawing the sidebar.
 */
export function canAccessPage(staff: StaffMember | null | undefined, pageId: string): boolean {
  if (!staff) return false;
  if (!hasConsoleAccount(staff)) return false;
  if (isSuperAdmin(staff)) return true;
  // Super-Admin-only pages are refused even when the id was granted.
  if (isSuperAdminOnlyPage(pageId)) return false;
  return (staff.permissions || []).includes(pageId);
}

/** Every page this staff member may open, in console order. */
export function allowedPages(staff: StaffMember | null | undefined): AdminPage[] {
  if (!staff) return [];
  if (isSuperAdmin(staff)) return ADMIN_PAGES;
  return ADMIN_PAGES.filter(page => canAccessPage(staff, page.id));
}

/** Where to land after signing in. Null when the account has no pages at all. */
export function firstAllowedPage(staff: StaffMember | null | undefined): AdminPageId | null {
  return allowedPages(staff)[0]?.id ?? null;
}

/** Default page set for a newly granted console account. */
export function defaultPermissionsForRole(role: StaffRole): string[] {
  if (role === 'Super Admin') return [...ADMIN_PAGE_IDS];
  if (role === 'Admin') {
    return ADMIN_PAGE_IDS.filter(id => id !== 'settings' && !isSuperAdminOnlyPage(id));
  }
  return ['dashboard', 'queue'];
}

/** Keeps only ids that are real console pages. */
export function sanitizePermissions(permissions?: string[]): string[] {
  if (!permissions) return [];
  // A Super-Admin-only page is never stored as a granted permission.
  return permissions.filter(
    id => ADMIN_PAGE_IDS.includes(id as AdminPageId) && !isSuperAdminOnlyPage(id));
}


/**
 * Settings subsections, shown as a submenu under Settings in the sidebar.
 * These are the sections that already exist on the Settings page — the ids match
 * what the page renders, so navigation and content can never drift apart.
 */
export type SettingsSectionId =
  | 'settings-stages'
  | 'settings-workshop-lists'
  | 'settings-popup'
  | 'settings-staff-registry'
  | 'settings-pottery-logging'
  | 'settings-capacity'
  | 'settings-events'
  | 'settings-payments'
  | 'settings-data-reset';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  /** Arabic wording. These labels are fixed in code, not staff-editable. */
  labelAr: string;
}

/**
 * Ids are namespaced so they can never collide with an Admin Console page id —
 * "staff" is the Staff Management page, "settings-staff-registry" is a section.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'settings-stages', label: 'Piece Pipeline Stages', labelAr: 'مراحل مسار القطعة' },
  { id: 'settings-workshop-lists', label: 'Workshop Detail Lists', labelAr: 'قوائم تفاصيل الورشة' },
  { id: 'settings-popup', label: 'Booking Pop-up', labelAr: 'نافذة الحجز المنبثقة' },
  { id: 'settings-staff-registry', label: 'Staff Registry', labelAr: 'سجل الموظفين' },
  { id: 'settings-pottery-logging', label: 'Pottery Logging Console', labelAr: 'لوحة تسجيل الفخار' },
  { id: 'settings-capacity', label: 'Capacity', labelAr: 'السعة' },
  { id: 'settings-events', label: 'Events / Birthday', labelAr: 'الفعاليات / أعياد الميلاد' },
  { id: 'settings-payments', label: 'Online Payments', labelAr: 'الدفع الإلكتروني' },
  { id: 'settings-data-reset', label: 'Data Reset', labelAr: 'إعادة ضبط البيانات' }
];

/**
 * Settings sections only a Super Admin may see, hidden from every other role
 * (the page also refuses to render them):
 *   - Data Reset deletes live data for everyone.
 *   - Online Payments switches payment on and sets what the database charges.
 *     Migration 0053 lets only a Super Admin write the onlinePayments setting.
 */
export const SUPER_ADMIN_ONLY_SETTINGS_SECTIONS: SettingsSectionId[] = ['settings-data-reset', 'settings-payments'];

/** Whether this staff member may see a Settings section. */
export function canSeeSettingsSection(id: SettingsSectionId, staff?: StaffMember | null): boolean {
  return !SUPER_ADMIN_ONLY_SETTINGS_SECTIONS.includes(id) || isSuperAdmin(staff);
}

/** The exact phrase a Super Admin must type to run Data Reset. */
export const DATA_RESET_PHRASE = 'DELETE EVERYTHING';

/** True only for the exact phrase (surrounding spaces ignored, case kept). */
export function isDataResetConfirmed(typed: string): boolean {
  return typed.trim() === DATA_RESET_PHRASE;
}

/** Maps a legacy stored section id onto its namespaced replacement. */
const LEGACY_SECTION_IDS: Record<string, SettingsSectionId> = {
  'stages': 'settings-stages',
  'workshops': 'settings-workshop-lists',
  'popup': 'settings-popup',
  'staff': 'settings-staff-registry',
  'pottery-logging': 'settings-pottery-logging',
  'capacity': 'settings-capacity',
  'events': 'settings-events',
  'data-reset': 'settings-data-reset'
};

/** Resolves any stored value — new or legacy — to a valid section. */
export function resolveSettingsSection(value?: string | null): SettingsSectionId {
  if (value && isSettingsSection(value)) return value;
  if (value && LEGACY_SECTION_IDS[value]) return LEGACY_SECTION_IDS[value];
  return 'settings-stages';
}

export const SETTINGS_SECTION_IDS = SETTINGS_SECTIONS.map(s => s.id);

export function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.includes(value as SettingsSectionId);
}

export function getSettingsSectionLabel(id: string, lang: Lang = 'en'): string {
  const section = SETTINGS_SECTIONS.find(s => s.id === id);
  if (!section) return id;
  return lang === 'ar' ? section.labelAr : section.label;
}
