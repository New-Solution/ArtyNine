/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One wording for a failed save in the staff console, English and Arabic.
 *
 * Every Settings write ends in a Supabase call that throws on failure
 * (src/lib/supabaseDb.ts). A refusal by row-level security (migration 0053
 * for app_settings, 0001 for staff) is the case staff most need explained:
 * the button did nothing because their account may not change this. Anything
 * else is reported as a plain failure with the server's own message kept for
 * whoever has to debug it.
 *
 * No React and no browser APIs, so this runs under plain tsx in
 * saveErrors.test.ts.
 */

export interface SaveErrorText {
  en: string;
  ar: string;
}

const PERMISSION_PATTERNS = [
  /row-level security/i,
  /permission denied/i,
  /only a super admin/i,
  /violates row-level/i,
  /\b42501\b/
];

function messageOf(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : '';
}

/** True when the failure is the database refusing this account. */
export function isPermissionError(err: unknown): boolean {
  const msg = messageOf(err);
  return PERMISSION_PATTERNS.some(p => p.test(msg));
}

/**
 * What to show when a save fails. `what` names the thing being saved, in both
 * languages, e.g. { en: 'the booking pop-up', ar: 'النافذة المنبثقة للحجز' }.
 */
export function saveErrorText(err: unknown, what?: SaveErrorText): SaveErrorText {
  const en = what?.en ? ` ${what.en}` : '';
  const ar = what?.ar ? ` ${what.ar}` : '';
  if (isPermissionError(err)) {
    return {
      en: `Not saved: your account does not have permission to change${en || ' this'}. Ask a Super Admin.`,
      ar: `لم يتم الحفظ: لا يملك حسابك صلاحية تعديل${ar || ' هذا الإعداد'}. تواصل مع المدير العام.`
    };
  }
  const detail = messageOf(err).trim();
  return {
    en: `Could not save${en}. Please try again.${detail ? ` (${detail})` : ''}`,
    ar: `تعذّر حفظ${ar || ' التغييرات'}. يرجى المحاولة مرة أخرى.${detail ? ` (${detail})` : ''}`
  };
}
