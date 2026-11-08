/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cancellation & Refund Policy — public, no sign-in.
 *
 * Every rule here is what the system actually does. Change the code and this
 * page together:
 *   - cancel_own_booking (migration 0048): who gets a refund on a customer
 *     cancellation. Unpaid hold or never paid: nothing to refund. Online
 *     deposit (payment_mode 'deposit'): never refunded. Anything else that was
 *     paid: refund due only with MORE than 24 hours' notice (strictly >),
 *     measured from the booking's start in Riyadh time; staff then return the
 *     money (Moyasar dashboard, or in person). Not cancellable online once the
 *     session has started or the booking is Checked In / In Progress /
 *     Completed.
 *   - online_payment_terms (0046): deposit = min(depositAmount, price);
 *     'full' = the whole price.
 *   - holdMinutes: an unpaid hold stops taking a seat at payment_expires_at;
 *     auto-cancel-bookings marks it Expired (after checking Moyasar).
 * Amounts and modes come from the live onlinePayments setting, read through
 * the same normalizeOnlinePayments() the checkout uses, so this page cannot
 * quote a different deposit or hold time from the one being charged.
 */

import React from 'react';
import { CreditCard, Gift, Store } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import {
  ONLINE_PAYMENTS_SETTING_ID,
  normalizeOnlinePayments,
  type OnlinePaymentKindConfig
} from '../utils/onlinePayments';
import {
  InfoPageLayout, InfoSection, InfoList, ConfirmWithClient, InfoPageLink, useUpdatedLine
} from './ui/InfoPage';

/** Mirrors cancel_own_booking's `hours_notice > 24`. */
const REFUND_NOTICE_HOURS = 24;

export const CancellationPolicySection: React.FC = () => {
  const { appSettings } = useApp();
  const { t } = useLanguage();
  const updated = useUpdatedLine();

  const config = normalizeOnlinePayments(appSettings.find(s => s.id === ONLINE_PAYMENTS_SETTING_ID)?.value);
  const hold = config.holdMinutes;
  const H = REFUND_NOTICE_HOURS;

  const refundHow = (
    <>
      {t(
        'The refund is issued by the studio, to the original payment method, within',
        'يُصدر الاستوديو المبلغ المسترد إلى وسيلة الدفع الأصلية خلال'
      )}{' '}
      <ConfirmWithClient>{t('X business days', 'X أيام عمل')}</ConfirmWithClient>
      {t('. Your bank may take a few extra days to show it.', '. قد يستغرق ظهوره في حسابك البنكي بضعة أيام إضافية.')}
    </>
  );

  /** The rules for one booking type, by how it is paid online. */
  const kindRules = (kind: OnlinePaymentKindConfig): React.ReactNode[] =>
    kind.mode === 'deposit'
      ? [
          t(
            `A deposit of ${kind.depositAmount} SAR is paid online when you book. If the booking costs less than ${kind.depositAmount} SAR, the full price is paid online instead.`,
            `يُدفع عربون بقيمة ${kind.depositAmount} ريال إلكترونيًا عند الحجز. وإذا كانت قيمة الحجز أقل من ${kind.depositAmount} ريال، يُدفع السعر كاملًا إلكترونيًا.`
          ),
          t('The rest of the price is paid at the studio.', 'يُدفع باقي المبلغ في الاستوديو.'),
          <strong className="text-brand-charcoal">
            {t(
              'The deposit is non-refundable. It is not refunded if you cancel, however much notice you give.',
              'العربون غير قابل للاسترداد، ولا يُسترد عند الإلغاء مهما كانت مدة الإشعار.'
            )}
          </strong>
        ]
      : [
          t('The full price is paid online when you book.', 'يُدفع السعر كاملًا إلكترونيًا عند الحجز.'),
          <>
            <strong className="text-brand-charcoal">
              {t(
                `Cancelled more than ${H} hours before the start: full refund of the amount paid.`,
                `الإلغاء قبل أكثر من ${H} ساعة من موعد البدء: استرداد كامل للمبلغ المدفوع.`
              )}
            </strong>{' '}
            {refundHow}
          </>,
          <strong className="text-brand-charcoal">
            {t(
              `Cancelled within ${H} hours of the start: no refund.`,
              `الإلغاء خلال ${H} ساعة من موعد البدء: لا يوجد استرداد.`
            )}
          </strong>
        ];

  const summary = [
    {
      icon: CreditCard,
      title: t('Workshops & events', 'الورش والفعاليات'),
      body: config.workshop.mode === 'deposit'
        ? t(`${config.workshop.depositAmount} SAR deposit online, non-refundable.`, `عربون ${config.workshop.depositAmount} ريال إلكترونيًا، غير قابل للاسترداد.`)
        : t(`Paid in full online. Refunded with more than ${H} hours' notice.`, `يُدفع كاملًا إلكترونيًا. يُسترد عند الإلغاء قبل أكثر من ${H} ساعة.`)
    },
    {
      icon: Gift,
      title: t('Birthday parties', 'حفلات أعياد الميلاد'),
      body: config.birthday.mode === 'deposit'
        ? t(`${config.birthday.depositAmount} SAR deposit online, non-refundable.`, `عربون ${config.birthday.depositAmount} ريال إلكترونيًا، غير قابل للاسترداد.`)
        : t(`Paid in full online. Refunded with more than ${H} hours' notice.`, `تُدفع كاملة إلكترونيًا. تُسترد عند الإلغاء قبل أكثر من ${H} ساعة.`)
    },
    {
      icon: Store,
      title: t('Pay at the studio', 'الدفع في الاستوديو'),
      body: t('Nothing charged online. Free cancellation.', 'لا يُخصم أي مبلغ إلكترونيًا. إلغاء مجاني.')
    }
  ];

  return (
    <InfoPageLayout
      eyebrow={t('Policies', 'السياسات')}
      title={t('Cancellation & Refund Policy', 'سياسة الإلغاء والاسترداد')}
      intro={t(
        'How cancellations and refunds work for bookings made with Arty Café. All amounts are in Saudi riyals (SAR).',
        'كيف يتم الإلغاء والاسترداد للحجوزات لدى آرتي كافيه. جميع المبالغ بالريال السعودي.'
      )}
      updated={updated}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summary.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.title} className="rounded-2xl border border-brand-clay bg-brand-sand/30 p-4 text-start">
              <Icon className="h-5 w-5 text-brand-terracotta" />
              <p className="mt-2 text-sm font-semibold text-brand-charcoal">{card.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-brand-ink">{card.body}</p>
            </div>
          );
        })}
      </div>

      <InfoSection title={t('How to cancel', 'طريقة الإلغاء')}>
        <InfoList items={[
          t(
            'Sign in, open My Bookings and choose Cancel. You can cancel online at any time until the session starts.',
            'سجّل الدخول، وافتح «حجوزاتي» واختر «إلغاء». يمكنك الإلغاء إلكترونيًا في أي وقت حتى يبدأ موعد الجلسة.'
          ),
          t(
            'Once the session has started, or you have checked in, it can no longer be cancelled online. Please contact the studio.',
            'بعد بدء الجلسة أو تسجيل حضورك، لا يمكن الإلغاء إلكترونيًا. يرجى التواصل مع الاستوديو.'
          ),
          t(
            `Notice is counted from the booking's start time, Saudi Arabia time. Exactly ${H} hours or less counts as "within ${H} hours".`,
            `تُحسب مدة الإشعار من وقت بدء الحجز بتوقيت السعودية. ${H} ساعة بالضبط أو أقل تُعدّ «خلال ${H} ساعة».`
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('Workshops & events', 'الورش والفعاليات')}>
        <InfoList items={kindRules(config.workshop)} />
      </InfoSection>

      <InfoSection title={t('Birthday parties', 'حفلات أعياد الميلاد')}>
        <InfoList items={kindRules(config.birthday)} />
      </InfoSection>

      <InfoSection title={t('Bookings paid at the studio', 'الحجوزات المدفوعة في الاستوديو')}>
        <InfoList items={[
          t(
            'When no payment is taken online, nothing is charged when you book, and you can cancel free of charge at any time before the session starts.',
            'عندما لا يُدفع أي مبلغ إلكترونيًا، لا يُخصم شيء عند الحجز، ويمكنك الإلغاء مجانًا في أي وقت قبل بدء الجلسة.'
          ),
          t(
            `If you have already paid the studio for the booking in advance: cancelled more than ${H} hours before the start, the studio refunds you in person; within ${H} hours, no refund.`,
            `إذا كنت قد دفعت للاستوديو مسبقًا: عند الإلغاء قبل أكثر من ${H} ساعة من البدء يُعيد الاستوديو المبلغ لك حضوريًا، وخلال ${H} ساعة لا يوجد استرداد.`
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('Unpaid online bookings', 'الحجوزات غير المدفوعة إلكترونيًا')}>
        <p>
          {t(
            `When you pay online, your place is held for ${hold} minutes while you complete the payment. If the payment is not completed in that time, the hold is released automatically and nothing is charged. If your payment did go through but the page closed, it is checked with the payment provider before the hold is released.`,
            `عند الدفع إلكترونيًا، يُحجز مكانك لمدة ${hold} دقيقة لإتمام الدفع. إذا لم يكتمل الدفع خلال هذه المدة، يُلغى الحجز المؤقت تلقائيًا ولا يُخصم أي مبلغ. وإذا تمّ الدفع لكن الصفحة أُغلقت، يتم التحقق من الدفع لدى مزوّد الدفع قبل إلغاء الحجز المؤقت.`
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('No-shows', 'عدم الحضور')}>
        <p>
          {t(
            'If you do not attend a booking and have not cancelled it, nothing is refunded.',
            'إذا لم تحضر موعدك ولم تقم بإلغائه، فلا يُسترد أي مبلغ.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('Refunds', 'المبالغ المستردة')}>
        <InfoList items={[
          <>
            {t('Online payments (card, mada, Apple Pay):', 'المدفوعات الإلكترونية (البطاقة، مدى، Apple Pay):')}{' '}
            {refundHow}
          </>,
          t('Payments made at the studio are refunded at the studio.', 'المبالغ المدفوعة في الاستوديو تُسترد في الاستوديو.'),
          t(
            'Refunds are not automatic: when a refund is due, the studio is notified and returns the money.',
            'الاسترداد ليس تلقائيًا: عند استحقاق الاسترداد يتم إشعار الاستوديو ويقوم بإعادة المبلغ.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('If the studio cancels or changes a session', 'إذا ألغى الاستوديو جلسة أو غيّرها')}>
        <p>
          <ConfirmWithClient>
            {t(
              'If the studio has to cancel or reschedule your session, you can choose a new time or a full refund of everything you paid, including any deposit.',
              'إذا اضطر الاستوديو إلى إلغاء جلستك أو تغيير موعدها، يمكنك اختيار موعد جديد أو استرداد كامل ما دفعته، بما في ذلك العربون.'
            )}
          </ConfirmWithClient>
        </p>
      </InfoSection>

      <InfoSection title={t('Questions', 'استفسارات')}>
        <p>
          {t('Any questions about a booking or a refund? ', 'لديك سؤال عن حجز أو استرداد؟ ')}
          <InfoPageLink page="contact">{t('Contact the studio', 'تواصل مع الاستوديو')}</InfoPageLink>
          {t('. See also our ', '. اطّلع أيضًا على ')}
          <InfoPageLink page="terms">{t('Terms & Conditions', 'الشروط والأحكام')}</InfoPageLink>.
        </p>
      </InfoSection>
    </InfoPageLayout>
  );
};
