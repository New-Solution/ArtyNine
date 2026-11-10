/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Terms & Conditions — public, no sign-in. Deliberately short and plain.
 *
 * Studio practice (late arrival, children's ages, aprons, pickup window,
 * broken pieces, photos, VAT, how the balance is paid, legal name) was
 * confirmed by the studio on 10 Nov 2026.
 *
 * Facts taken from the code rather than assumed:
 *   - online booking needs an account (0049: bookings require a signed-in caller);
 *   - Moyasar, SAR, methods 'creditcard' + 'applepay' (MOYASAR_METHODS) —
 *     Moyasar's card form takes Visa, Mastercard and mada;
 *   - "ready for pickup in approximately two weeks" and SMS updates
 *     (pieceSmsTemplates.ts);
 *   - the pickup window matches the Booking Pop-up default (DEFAULT_PREPAYMENT_POPUP).
 */

import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { STUDIO_LEGAL_NAME, STUDIO_LEGAL_NAME_AR, STUDIO_CR_UNIFIED_NO, STUDIO_VAT_NO } from '../utils/studioConfig';
import {
  InfoPageLayout, InfoSection, InfoList, InfoPageLink, useUpdatedLine
} from './ui/InfoPage';

export const TermsSection: React.FC = () => {
  const { t } = useLanguage();
  const updated = useUpdatedLine();

  return (
    <InfoPageLayout
      eyebrow={t('Policies', 'السياسات')}
      title={t('Terms & Conditions', 'الشروط والأحكام')}
      intro={
        <>
          {t(
            'These terms apply when you book or attend a session at Arty Café, Jeddah. By booking, you agree to them. Arty Café is operated by',
            'تنطبق هذه الشروط عند الحجز أو حضور جلسة في آرتي كافيه، جدة. بإتمامك الحجز فإنك توافق عليها. يُدار آرتي كافيه من قِبل'
          )}{' '}
          {t(STUDIO_LEGAL_NAME, STUDIO_LEGAL_NAME_AR)}{' '}
          ({t('Commercial Registration (Unified No.)', 'الرقم الوطني الموحد')}:{' '}
          <span dir="ltr" className="ltr-numerals">{STUDIO_CR_UNIFIED_NO}</span>
          {t(', VAT Registration No.', '، الرقم الضريبي')}:{' '}
          <span dir="ltr" className="ltr-numerals">{STUDIO_VAT_NO}</span>).
        </>
      }
      updated={updated}
    >
      <InfoSection title={t('1. Bookings', '١. الحجوزات')}>
        <InfoList items={[
          t(
            'You need an account to book online. Please make sure your name and phone number are correct — we use them to confirm your booking and send updates.',
            'تحتاج إلى حساب للحجز إلكترونيًا. يرجى التأكد من صحة اسمك ورقم جوالك، فنحن نستخدمهما لتأكيد حجزك وإرسال التحديثات.'
          ),
          t(
            'A booking paid online is confirmed once the payment succeeds. A booking paid at the studio is confirmed when you complete it.',
            'يتأكد الحجز المدفوع إلكترونيًا عند نجاح الدفع، ويتأكد الحجز المدفوع في الاستوديو عند إتمامه.'
          ),
          t(
            'Places are limited. Please arrive on time: if you arrive more than 15 minutes late, the appointment is cancelled and moved to another time.',
            'الأماكن محدودة. يرجى الحضور في الموعد: في حال التأخر أكثر من 15 دقيقة يُلغى الموعد ويُنقل إلى وقت آخر.'
          ),
          <>
            {t('Cancellations and refunds follow our ', 'يخضع الإلغاء والاسترداد لـ')}
            <InfoPageLink page="cancellation-policy">{t('Cancellation & Refund Policy', 'سياسة الإلغاء والاسترداد')}</InfoPageLink>.
          </>
        ]} />
      </InfoSection>

      <InfoSection title={t('2. Payments', '٢. المدفوعات')}>
        <InfoList items={[
          t('All prices are in Saudi riyals (SAR).', 'جميع الأسعار بالريال السعودي.'),
          t('All prices include VAT.', 'جميع الأسعار شاملة ضريبة القيمة المضافة.'),
          t(
            'Online payments are processed securely by Moyasar, a licensed Saudi payment provider. You can pay by credit or debit card (Visa, Mastercard), mada or Apple Pay.',
            'تتم معالجة المدفوعات الإلكترونية بأمان عبر Moyasar، مزوّد دفع سعودي مرخّص. يمكنك الدفع ببطاقة ائتمانية أو بطاقة خصم (Visa وMastercard) أو مدى أو Apple Pay.'
          ),
          t(
            'Your card details are entered on Moyasar\'s secure form. Arty Café never sees or stores your full card number.',
            'تُدخل بيانات بطاقتك في نموذج Moyasar الآمن، ولا يطّلع آرتي كافيه على رقم بطاقتك الكامل ولا يحتفظ به.'
          ),
          t(
            'Any amount still due is paid at the studio by card, mada or cash.',
            'يُدفع أي مبلغ متبقٍ في الاستوديو بالبطاقة أو مدى أو نقدًا.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('3. Children\'s sessions', '٣. جلسات الأطفال')}>
        <InfoList items={[
          t('Children\'s sessions are for ages 7 and up.', 'جلسات الأطفال مخصصة للأعمار من 7 سنوات فأكثر.'),
          t(
            'Clay and paint can stain clothes, so please dress children in clothes that can get messy. Aprons are provided.',
            'قد يترك الطين والألوان بقعًا على الملابس، لذا يُفضّل إلباس الأطفال ملابس لا بأس باتساخها. نوفّر المآزر.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('4. Your pottery pieces', '٤. قطعك الفخارية')}>
        <InfoList items={[
          t(
            'Pieces need to dry and be fired in the kiln. A piece is usually ready for pickup in about two weeks. We will let you know by SMS when it is ready.',
            'تحتاج القطع إلى التجفيف والحرق في الفرن، وتكون القطعة جاهزة للاستلام عادةً خلال أسبوعين تقريبًا. سنُعلمك برسالة نصية عند جاهزيتها.'
          ),
          t(
            'Finished pieces are kept for about 1.5 months after they are ready, so please collect yours within that time.',
            'نحتفظ بالقطع المكتملة لمدة شهر ونصف تقريبًا بعد جاهزيتها، لذا يرجى استلام قطعتك خلال هذه المدة.'
          ),
          t(
            'Clay is a natural material: a piece can crack or break while drying or firing, even with the greatest care. If that happens, the studio makes a new piece and you colour it. There is no cash refund.',
            'الطين مادة طبيعية، وقد تتشقق القطعة أو تنكسر أثناء التجفيف أو الحرق رغم كل العناية. وفي هذه الحالة يصنع الاستوديو قطعة جديدة وتقوم أنت بتلوينها، دون استرداد نقدي.'
          ),
          t(
            'Colours and glazes can look different after firing.',
            'قد تختلف الألوان والطلاءات بعد الحرق.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('5. Photos', '٥. الصور')}>
        <p>
          {t(
            'The studio asks for your permission before photographing you.',
            'يستأذنك الاستوديو قبل تصويرك.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('6. Changes by the studio', '٦. التغييرات من قِبل الاستوديو')}>
        <InfoList items={[
          t(
            'We may occasionally need to change the instructor, or reschedule or cancel a session. We will tell you as early as we can.',
            'قد نحتاج أحيانًا إلى تغيير المدرّب أو تغيير موعد الجلسة أو إلغائها، وسنُعلمك بذلك في أقرب وقت ممكن.'
          ),
          t(
            'If we cancel or reschedule your session, we will offer you an alternative appointment.',
            'إذا ألغينا جلستك أو غيّرنا موعدها، سنعرض عليك موعدًا بديلًا.'
          ),
          t(
            'Prices and session details may change, but a change never affects a booking you have already confirmed.',
            'قد تتغير الأسعار وتفاصيل الجلسات، لكن أي تغيير لا يؤثر على حجز أكّدته مسبقًا.'
          ),
          t(
            'We may update these terms. The version on this page when you book is the one that applies to that booking.',
            'قد نُحدّث هذه الشروط، وتنطبق على حجزك النسخة المنشورة في هذه الصفحة وقت الحجز.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('7. Governing law', '٧. القانون المعمول به')}>
        <p>
          {t(
            'These terms are governed by the laws of the Kingdom of Saudi Arabia.',
            'تخضع هذه الشروط لأنظمة المملكة العربية السعودية.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('8. Contact', '٨. التواصل')}>
        <p>
          {t('Questions about these terms? ', 'لديك سؤال عن هذه الشروط؟ ')}
          <InfoPageLink page="contact">{t('Contact the studio', 'تواصل مع الاستوديو')}</InfoPageLink>.
        </p>
      </InfoSection>
    </InfoPageLayout>
  );
};
