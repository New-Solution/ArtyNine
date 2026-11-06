/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Customer-facing wording for every online payment outcome, English and
 * Arabic, in one place so the payment step and the return page say the same
 * thing. `t` is LanguageContext's t(en, ar).
 */

import type { VerifyState } from '../lib/onlinePayment';

type T = (en: string, ar: string) => string;

export interface PaymentMessage {
  title: string;
  body: string;
  /** 'success' | 'retry' (customer can try again) | 'studio' (studio will follow up) | 'wait' */
  kind: 'success' | 'retry' | 'studio' | 'wait';
}

export function paymentStateMessage(state: VerifyState, t: T, bankMessage?: string | null): PaymentMessage {
  switch (state) {
    case 'confirmed':
      return {
        kind: 'success',
        title: t('Payment confirmed', 'تم تأكيد الدفع'),
        body: t('Your payment was received and your booking is confirmed.', 'تم استلام دفعتك وتأكيد حجزك.')
      };
    case 'pending':
      return {
        kind: 'wait',
        title: t('Finishing your payment…', 'جارٍ إتمام الدفع…'),
        body: t(
          'Your bank has not finished confirming the payment yet. Please wait a moment — this page will update.',
          'لم ينتهِ البنك من تأكيد الدفع بعد. يرجى الانتظار قليلًا — ستتحدّث هذه الصفحة تلقائيًا.'
        )
      };
    case 'failed':
      return {
        kind: 'retry',
        title: t('Payment not completed', 'لم يكتمل الدفع'),
        body: t(
          `The payment did not go through${bankMessage ? ` (${bankMessage})` : ''}. Nothing was charged. You can try again with the same or another card while your place is held.`,
          `لم تتم عملية الدفع${bankMessage ? ` (${bankMessage})` : ''}. لم يُخصم أي مبلغ. يمكنك المحاولة مرة أخرى بالبطاقة نفسها أو بطاقة أخرى ما دام مكانك محجوزًا.`
        )
      };
    case 'needs_refund':
      return {
        kind: 'studio',
        title: t('Payment received — place no longer available', 'تم استلام الدفع — المكان لم يعد متاحًا'),
        body: t(
          'Your payment arrived after the time to pay had run out, and the place had been taken. The studio will refund you in full and contact you.',
          'وصلت دفعتك بعد انتهاء مهلة الدفع وكان المكان قد حُجز. سيعيد الاستوديو المبلغ كاملًا ويتواصل معك.'
        )
      };
    case 'duplicate':
      return {
        kind: 'studio',
        title: t('This booking was already paid', 'هذا الحجز مدفوع مسبقًا'),
        body: t(
          'We received more than one payment for this booking. Your booking is safe; the studio will refund the extra payment.',
          'استلمنا أكثر من دفعة لهذا الحجز. حجزك مؤكد، وسيعيد الاستوديو الدفعة الزائدة.'
        )
      };
    case 'mismatch':
    case 'not_awaiting':
      return {
        kind: 'studio',
        title: t('We need to check this payment', 'نحتاج إلى مراجعة هذه الدفعة'),
        body: t(
          'Your payment was received but could not be matched to your booking automatically. The studio has been alerted and will contact you.',
          'تم استلام دفعتك لكن تعذّر ربطها بحجزك تلقائيًا. تم إبلاغ الاستوديو وسيتواصل معك.'
        )
      };
    case 'not_found':
    default:
      return {
        kind: 'retry',
        title: t('Payment not found', 'لم يتم العثور على الدفعة'),
        body: t(
          'We could not find this payment. If you were charged, please contact the studio with your booking reference.',
          'تعذّر العثور على هذه الدفعة. إذا خُصم منك مبلغ، يرجى التواصل مع الاستوديو مع رقم الحجز.'
        )
      };
  }
}

/** When verify-payment itself could not be reached. Retrying is safe. */
export function paymentCheckUnavailable(t: T): PaymentMessage {
  return {
    kind: 'wait',
    title: t('Checking your payment…', 'جارٍ التحقق من دفعتك…'),
    body: t(
      'We could not reach the payment service just now. Please do not pay again — we will keep checking.',
      'تعذّر الوصول إلى خدمة الدفع الآن. يرجى عدم الدفع مرة أخرى — سنواصل التحقق.'
    )
  };
}
