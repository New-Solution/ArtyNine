/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Terms & Conditions — public, no sign-in. Deliberately short and plain.
 *
 * Statements the studio has not confirmed are wrapped in <ConfirmWithClient>,
 * which prints the literal [CONFIRM WITH CLIENT] marker. Remove the wrapper
 * once a statement is confirmed (or reword it).
 *
 * Facts taken from the code rather than assumed:
 *   - online booking needs an account (0049: bookings require a signed-in caller);
 *   - Moyasar, SAR, methods 'creditcard' + 'applepay' (MOYASAR_METHODS) —
 *     Moyasar's card form takes Visa, Mastercard and mada;
 *   - "ready for pickup in approximately two weeks" and SMS updates
 *     (pieceSmsTemplates.ts).
 */

import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import {
  InfoPageLayout, InfoSection, InfoList, ConfirmWithClient, InfoPageLink, useUpdatedLine
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
          <ConfirmWithClient>{t('legal entity name, CR number', 'الاسم النظامي للمنشأة، رقم السجل التجاري')}</ConfirmWithClient>.
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
          <>
            {t('Places are limited. Please arrive on time.', 'الأماكن محدودة. يرجى الحضور في الموعد.')}{' '}
            <ConfirmWithClient>
              {t('A late arrival may have a shorter session.', 'قد تقصر مدة الجلسة عند التأخر.')}
            </ConfirmWithClient>
          </>,
          <>
            {t('Cancellations and refunds follow our ', 'يخضع الإلغاء والاسترداد لـ')}
            <InfoPageLink page="cancellation-policy">{t('Cancellation & Refund Policy', 'سياسة الإلغاء والاسترداد')}</InfoPageLink>.
          </>
        ]} />
      </InfoSection>

      <InfoSection title={t('2. Payments', '٢. المدفوعات')}>
        <InfoList items={[
          t('All prices are in Saudi riyals (SAR).', 'جميع الأسعار بالريال السعودي.'),
          <ConfirmWithClient>
            {t('Prices include VAT.', 'الأسعار شاملة ضريبة القيمة المضافة.')}
          </ConfirmWithClient>,
          t(
            'Online payments are processed securely by Moyasar, a licensed Saudi payment provider. You can pay by credit or debit card (Visa, Mastercard), mada or Apple Pay.',
            'تتم معالجة المدفوعات الإلكترونية بأمان عبر Moyasar، مزوّد دفع سعودي مرخّص. يمكنك الدفع ببطاقة ائتمانية أو بطاقة خصم (Visa وMastercard) أو مدى أو Apple Pay.'
          ),
          t(
            'Your card details are entered on Moyasar\'s secure form. Arty Café never sees or stores your full card number.',
            'تُدخل بيانات بطاقتك في نموذج Moyasar الآمن، ولا يطّلع آرتي كافيه على رقم بطاقتك الكامل ولا يحتفظ به.'
          ),
          <>
            {t('Any amount still due is paid at the studio by', 'يُدفع أي مبلغ متبقٍ في الاستوديو عبر')}{' '}
            <ConfirmWithClient>{t('cash, card or mada', 'النقد أو البطاقة أو مدى')}</ConfirmWithClient>.
          </>
        ]} />
      </InfoSection>

      <InfoSection title={t('3. Children\'s sessions', '٣. جلسات الأطفال')}>
        <InfoList items={[
          <>
            {t('Children\'s sessions are for ages', 'جلسات الأطفال مخصصة للأعمار')}{' '}
            <ConfirmWithClient>{t('X and up', 'من X سنوات فأكثر')}</ConfirmWithClient>.
          </>,
          <>
            {t('Children under', 'يجب أن يبقى مع الأطفال دون سن')}{' '}
            <ConfirmWithClient>{t('X years must stay with a parent or guardian', 'X سنوات أحد الوالدين أو وليّ الأمر')}</ConfirmWithClient>{' '}
            {t('for the whole session. Parents and guardians remain responsible for their children at all times.', 'طوال الجلسة. ويبقى الوالدان أو وليّ الأمر مسؤولين عن أطفالهم في جميع الأوقات.')}
          </>,
          <>
            {t(
              'Clay and paint can stain clothes, so please dress children in clothes that can get messy.',
              'قد يترك الطين والألوان بقعًا على الملابس، لذا يُفضّل إلباس الأطفال ملابس لا بأس باتساخها.'
            )}{' '}
            <ConfirmWithClient>{t('Aprons are provided.', 'نوفّر مرايل.')}</ConfirmWithClient>
          </>
        ]} />
      </InfoSection>

      <InfoSection title={t('4. Your pottery pieces', '٤. قطعك الفخارية')}>
        <InfoList items={[
          t(
            'Pieces need to dry and be fired in the kiln. A piece is usually ready for pickup in about two weeks. We will let you know by SMS when it is ready.',
            'تحتاج القطع إلى التجفيف والحرق في الفرن، وتكون القطعة جاهزة للاستلام عادةً خلال أسبوعين تقريبًا. سنُعلمك برسالة نصية عند جاهزيتها.'
          ),
          <>
            {t('Please collect your piece within', 'يرجى استلام قطعتك خلال')}{' '}
            <ConfirmWithClient>{t('X days', 'X يومًا')}</ConfirmWithClient>{' '}
            {t('of being told it is ready. Pieces not collected after that may be disposed of', 'من إشعارك بجاهزيتها. وقد يتم التخلص من القطع غير المستلمة بعد ذلك')}{' '}
            <ConfirmWithClient />.
          </>,
          <>
            {t(
              'Clay is a natural material: a piece can crack or break while drying or firing, even with the greatest care. If that happens,',
              'الطين مادة طبيعية، وقد تتشقق القطعة أو تنكسر أثناء التجفيف أو الحرق رغم كل العناية. وفي هذه الحالة'
            )}{' '}
            <ConfirmWithClient>{t('we will let you know and offer a free session to make a new piece; no cash refund', 'سنُعلمك ونقدّم لك جلسة مجانية لصنع قطعة جديدة، دون استرداد نقدي')}</ConfirmWithClient>.
          </>,
          t(
            'Colours and glazes can look different after firing.',
            'قد تختلف الألوان والطلاءات بعد الحرق.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('5. Photos', '٥. الصور')}>
        <InfoList items={[
          <ConfirmWithClient>
            {t(
              'We may take photos and videos during sessions and share them on our social media.',
              'قد نلتقط صورًا ومقاطع فيديو أثناء الجلسات وننشرها على حساباتنا في وسائل التواصل الاجتماعي.'
            )}
          </ConfirmWithClient>,
          <ConfirmWithClient>
            {t(
              'If you would rather you or your child did not appear, please tell a member of staff before the session. We never post a child\'s full name.',
              'إذا كنت لا ترغب في ظهورك أو ظهور طفلك، يرجى إبلاغ أحد الموظفين قبل الجلسة. لا ننشر الاسم الكامل لأي طفل.'
            )}
          </ConfirmWithClient>
        ]} />
      </InfoSection>

      <InfoSection title={t('6. Changes by the studio', '٦. التغييرات من قِبل الاستوديو')}>
        <InfoList items={[
          t(
            'We may occasionally need to change the instructor, or reschedule or cancel a session. We will tell you as early as we can.',
            'قد نحتاج أحيانًا إلى تغيير المدرّب أو تغيير موعد الجلسة أو إلغائها، وسنُعلمك بذلك في أقرب وقت ممكن.'
          ),
          <>
            {t('If we cancel or reschedule your session, ', 'إذا ألغينا جلستك أو غيّرنا موعدها، ')}
            <ConfirmWithClient>
              {t(
                'you can choose a new time or a full refund of everything you paid, including any deposit.',
                'يمكنك اختيار موعد جديد أو استرداد كامل ما دفعته، بما في ذلك العربون.'
              )}
            </ConfirmWithClient>
          </>,
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
          <ConfirmWithClient>
            {t(
              'These terms are governed by the laws of the Kingdom of Saudi Arabia.',
              'تخضع هذه الشروط لأنظمة المملكة العربية السعودية.'
            )}
          </ConfirmWithClient>
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
