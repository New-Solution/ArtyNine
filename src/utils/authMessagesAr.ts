/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Arabic for the English messages the customer sign-in, sign-up, claim and
 * password-reset calls return (AppContext / captcha). Display only: the calls
 * themselves are unchanged, and the login/sign-up screens look a message up
 * here at render time. A message with no entry is shown as it came.
 *
 * Keep the English keys byte-for-byte identical to the strings they mirror.
 */

import { CAPTCHA_FAILED_MESSAGE } from './captcha';

const AUTH_MESSAGES_AR: Record<string, string> = {
  // Fallbacks set in AuthSection itself
  'Invalid credentials.': 'بيانات الدخول غير صحيحة.',
  'Could not set up your password.': 'تعذّر إعداد كلمة المرور.',
  'Registration failed.': 'تعذّر إنشاء الحساب.',
  'Could not send the reset link.': 'تعذّر إرسال رابط إعادة التعيين.',
  'If an account exists for that address, a reset link is on its way.':
    'إذا كان هناك حساب بهذا البريد، فسيصلك رابط إعادة التعيين قريبًا.',

  // Sign-in, sign-up and claim
  'Could not create the account. Please try again.': 'تعذّر إنشاء الحساب. يرجى المحاولة مرة أخرى.',
  'Almost there — check your email and confirm your address to finish creating your account.':
    'اقتربت! تحقّق من بريدك الإلكتروني وأكّد عنوانك لإكمال إنشاء حسابك.',
  'Email or phone number is required.': 'البريد الإلكتروني أو رقم الجوال مطلوب.',
  'Enter your password.': 'أدخل كلمة المرور.',
  'No customer record is linked to this account yet.': 'لا يوجد سجل عميل مرتبط بهذا الحساب حتى الآن.',
  'This number is on file from a visit or booking, but there is no email address on the record to send a confirmation link to. Please ask the studio to add your email, then set your password here.':
    'هذا الرقم مسجّل لدينا من زيارة أو حجز سابق، لكن لا يوجد بريد إلكتروني في السجل لإرسال رابط التأكيد إليه. يرجى أن تطلب من الاستوديو إضافة بريدك، ثم عيّن كلمة المرور هنا.',
  'That account cannot be set up here. Please sign in, or use Forgot password.':
    'لا يمكن إعداد هذا الحساب هنا. يرجى تسجيل الدخول، أو استخدام «نسيت كلمة المرور».',
  'We cannot finish setting this up online yet — there is no email address on your record. Please ask the studio to add one, then claim your account.':
    'لا يمكننا إكمال الإعداد عبر الإنترنت بعد، فلا يوجد بريد إلكتروني في سجلك. يرجى أن تطلب من الاستوديو إضافته، ثم فعّل حسابك.',
  'Enter the email address on your record, and we will send a confirmation link to finish claiming your account.':
    'أدخل البريد الإلكتروني المسجّل لدينا، وسنرسل لك رابط تأكيد لإكمال تفعيل حسابك.',
  'Could not set up your account right now. Please try again.': 'تعذّر إعداد حسابك الآن. يرجى المحاولة مرة أخرى.',
  'That email address does not match the one on your record. Check the hint above, or ask the studio to confirm it.':
    'هذا البريد لا يطابق البريد المسجّل لدينا. راجع التلميح أعلاه، أو اطلب من الاستوديو تأكيده.',
  'Almost there — check your email and confirm your address to finish claiming your account.':
    'اقتربت! تحقّق من بريدك الإلكتروني وأكّد عنوانك لإكمال تفعيل حسابك.',
  'No account found with these details. Please create an account.':
    'لم نجد حسابًا بهذه البيانات. يرجى إنشاء حساب.',

  // Password reset
  'Enter a valid email address.': 'أدخل بريدًا إلكترونيًا صحيحًا.',
  'If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.':
    'إذا كان هناك حساب بهذا البريد، فسيصلك رابط إعادة التعيين قريبًا. تحقّق من البريد الوارد ومجلد الرسائل غير المرغوب فيها.',
  'We are having trouble sending email right now. Please try again in a few minutes.':
    'نواجه مشكلة في إرسال البريد حاليًا. يرجى المحاولة بعد بضع دقائق.',
  'This reset link has expired or has already been used. Request a new one.':
    'انتهت صلاحية رابط إعادة التعيين أو سبق استخدامه. اطلب رابطًا جديدًا.',
  'Password resets are sent by email. Use "Forgot password?" to get a secure link.':
    'تُرسل روابط إعادة تعيين كلمة المرور عبر البريد الإلكتروني. استخدم «نسيت كلمة المرور؟» للحصول على رابط آمن.',
  'Your session has expired, or this account has not been set up with a password yet. Sign in again, or use "Forgot password?" to set one by email.':
    'انتهت جلستك، أو لم تُعيَّن كلمة مرور لهذا الحساب بعد. سجّل الدخول مرة أخرى، أو استخدم «نسيت كلمة المرور؟» لتعيينها عبر البريد.',

  // Security check
  [CAPTCHA_FAILED_MESSAGE]: 'يرجى إكمال التحقق الأمني، ثم المحاولة مرة أخرى.'
};

/** The message in the visitor's language: Arabic when one is on file, otherwise as given. */
export function localizeAuthMessage(message: string, lang: string): string {
  return lang === 'ar' ? AUTH_MESSAGES_AR[message] ?? message : message;
}
