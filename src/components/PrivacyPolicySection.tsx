/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Privacy Policy — public, no sign-in. Same layout and plain style as Terms.
 *
 * Statements the studio has not confirmed are wrapped in <ConfirmWithClient>,
 * which prints the literal [CONFIRM WITH CLIENT] marker. Remove the wrapper
 * once a statement is confirmed (or reword it).
 *
 * Facts taken from the code rather than assumed:
 *   - customers: name, phone, optional email; bookings; birthday details
 *     (birthday person's name and age, optional cake reference photo —
 *     BirthdayBookingDetails); piece photos taken by the studio;
 *   - sign-in by phone code (Supabase Auth); data and photos hosted on
 *     Supabase (database + Storage);
 *   - card details are typed into Moyasar's form; we keep Moyasar's payment
 *     record, whose card number Moyasar already masks (0046 / 0047), never the
 *     full number or CVC;
 *   - SMS via our provider (_shared/sms.ts: mShastra or meertek);
 *   - optional Cloudflare Turnstile check at sign-in (utils/captcha.ts); the
 *     site itself is served by Cloudflare Pages;
 *   - the browser keeps the sign-in session and language choice.
 */

import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { InfoPageLayout, InfoSection, InfoList, ConfirmWithClient, InfoPageLink } from './ui/InfoPage';

export const PrivacyPolicySection: React.FC = () => {
  const { t } = useLanguage();

  return (
    <InfoPageLayout
      eyebrow={t('Policies', 'السياسات')}
      title={t('Privacy Policy', 'سياسة الخصوصية')}
      intro={
        <>
          {t(
            'This policy explains what personal information Arty Café, Jeddah collects when you use this website or visit the studio, why we use it, and the choices you have. Arty Café is operated by',
            'توضح هذه السياسة المعلومات الشخصية التي يجمعها آرتي كافيه، جدة عند استخدامك هذا الموقع أو زيارتك للاستوديو، وسبب استخدامنا لها، والخيارات المتاحة لك. يُدار آرتي كافيه من قِبل'
          )}{' '}
          <ConfirmWithClient>{t('legal entity name, CR number', 'الاسم النظامي للمنشأة، رقم السجل التجاري')}</ConfirmWithClient>.
        </>
      }
      updated={t('Last updated: 9 November 2026', 'آخر تحديث: ٩ نوفمبر ٢٠٢٦')}
    >
      <InfoSection title={t('1. What we collect', '١. المعلومات التي نجمعها')}>
        <InfoList items={[
          t(
            'Your name and mobile number, which you give us when you create an account or book. We use your number to sign you in with a one-time code.',
            'اسمك ورقم جوالك، وتزوّدنا بهما عند إنشاء حساب أو الحجز. ونستخدم رقمك لتسجيل دخولك برمز لمرة واحدة.'
          ),
          t('Your email address, only if you choose to give it.', 'بريدك الإلكتروني، فقط إذا اخترت تزويدنا به.'),
          t(
            'Your bookings: the workshop or event, date, time, number of people, price, payment status and any notes, and your visit history at the studio.',
            'حجوزاتك: الورشة أو الفعالية، والتاريخ، والوقت، وعدد الأشخاص، والسعر، وحالة الدفع، وأي ملاحظات، إضافةً إلى سجل زياراتك للاستوديو.'
          ),
          t(
            'For birthday bookings: the birthday person\'s name and age, party choices and special requests, and a cake reference photo if you upload one.',
            'لحجوزات أعياد الميلاد: اسم صاحب المناسبة وعمره، واختيارات الحفل والطلبات الخاصة، وصورة مرجعية للكعكة إن قمت برفعها.'
          ),
          t(
            'Photos of your pottery pieces, taken by our staff so you can follow your piece as it is made.',
            'صور قطعك الفخارية، يلتقطها موظفونا لتتمكن من متابعة قطعتك أثناء صنعها.'
          ),
          t(
            'For online payments: the payment record from Moyasar (amount, status, date and the card type with a masked card number). See section 4.',
            'للمدفوعات الإلكترونية: سجل الدفع من Moyasar (المبلغ، والحالة، والتاريخ، ونوع البطاقة مع رقم بطاقة مخفي). انظر البند ٤.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('2. Why we use it', '٢. لماذا نستخدمها')}>
        <InfoList items={[
          t(
            'To take and manage your bookings, take payment, and recognise you when you arrive.',
            'لاستقبال حجوزاتك وإدارتها، وتحصيل المدفوعات، والتعرّف عليك عند وصولك.'
          ),
          t(
            'To send you SMS updates about your booking (confirmations, changes, cancellations and refunds) and the sign-in codes you ask for.',
            'لإرسال رسائل نصية بتحديثات حجزك (التأكيد، والتغييرات، والإلغاء، والاسترداد) ورموز الدخول التي تطلبها.'
          ),
          t(
            'To track your pottery pieces through drying and firing, and to tell you when a piece is ready for pickup.',
            'لمتابعة قطعك الفخارية خلال مراحل التجفيف والحرق، وإبلاغك عند جاهزية القطعة للاستلام.'
          ),
          t(
            'To keep accurate records of payments and refunds, and to resolve any questions or disputes.',
            'للاحتفاظ بسجلات دقيقة للمدفوعات والمبالغ المستردة، وللإجابة عن أي استفسارات أو نزاعات.'
          ),
          t(
            'We do not sell your information, and we do not use it for advertising.',
            'لا نبيع معلوماتك، ولا نستخدمها لأغراض إعلانية.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('3. Who processes it for us', '٣. من يعالج المعلومات نيابةً عنا')}>
        <p>
          {t(
            'We share your information only with the service providers that run parts of this service for us, and only what each one needs:',
            'لا نشارك معلوماتك إلا مع مزوّدي الخدمات الذين يشغّلون أجزاءً من هذه الخدمة نيابةً عنا، وبالقدر الذي يحتاجه كل منهم فقط:'
          )}
        </p>
        <InfoList items={[
          <>
            {t(
              'Supabase — hosts our database, sign-in and photo storage.',
              'Supabase — يستضيف قاعدة بياناتنا وتسجيل الدخول وتخزين الصور.'
            )}{' '}
            <ConfirmWithClient>{t('Server region / where the data is stored', 'منطقة الخوادم / مكان تخزين البيانات')}</ConfirmWithClient>
          </>,
          t(
            'Moyasar — a licensed Saudi payment provider that processes online card, mada and Apple Pay payments.',
            'Moyasar — مزوّد دفع سعودي مرخّص يعالج المدفوعات الإلكترونية بالبطاقات ومدى وApple Pay.'
          ),
          t(
            'Our SMS provider — delivers booking updates and sign-in codes to your phone.',
            'مزوّد الرسائل النصية — يوصل تحديثات الحجز ورموز الدخول إلى جوالك.'
          ),
          t(
            'Cloudflare — serves this website and may run a quick security check at sign-in to block automated abuse.',
            'Cloudflare — يقدّم هذا الموقع، وقد يُجري فحصًا أمنيًا سريعًا عند تسجيل الدخول لمنع الاستخدام الآلي المسيء.'
          )
        ]} />
        <p>
          {t(
            'We may also disclose information when the law requires it.',
            'وقد نُفصح عن المعلومات أيضًا عندما يقتضي النظام ذلك.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('4. Card details', '٤. بيانات البطاقة')}>
        <p>
          {t(
            'When you pay online, you type your card details into Moyasar\'s secure payment form, and they go directly to Moyasar. Arty Café never sees or stores your full card number or security code (CVC). We keep only Moyasar\'s record of the payment, in which the card number is already masked by Moyasar (for example 4111 11•• •••• 1111).',
            'عند الدفع إلكترونيًا، تُدخل بيانات بطاقتك في نموذج الدفع الآمن الخاص بـ Moyasar، وتُرسل مباشرةً إلى Moyasar. لا يطّلع آرتي كافيه على رقم بطاقتك الكامل أو رمز الأمان (CVC) ولا يحتفظ بهما. نحتفظ فقط بسجل Moyasar للدفعة، والذي يكون فيه رقم البطاقة مخفيًا من قِبل Moyasar (مثل 4111 11•• •••• 1111).'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('5. Photos', '٥. الصور')}>
        <InfoList items={[
          <ConfirmWithClient>
            {t(
              'Photos of your pieces are visible only to you (in My Pieces) and to our staff.',
              'صور قطعك مرئية لك فقط (في صفحة قطعي) ولموظفينا.'
            )}
          </ConfirmWithClient>,
          <ConfirmWithClient>
            {t(
              'We will not post photos of your pieces, or of you or your child, on social media without your permission. You can tell a member of staff at any time if you would rather not appear.',
              'لن ننشر صور قطعك أو صورك أو صور طفلك على وسائل التواصل الاجتماعي دون إذنك. ويمكنك إبلاغ أحد الموظفين في أي وقت إن كنت لا ترغب في الظهور.'
            )}
          </ConfirmWithClient>,
          <ConfirmWithClient>
            {t(
              'Piece photos are deleted when the piece has been collected, or with your account.',
              'تُحذف صور القطع بعد استلام القطعة، أو عند حذف حسابك.'
            )}
          </ConfirmWithClient>
        ]} />
      </InfoSection>

      <InfoSection title={t('6. How long we keep it', '٦. مدة الاحتفاظ بالمعلومات')}>
        <InfoList items={[
          <>
            {t('Your account and booking history: for as long as you have an account, and', 'حسابك وسجل حجوزاتك: طوال مدة وجود حسابك، و')}{' '}
            <ConfirmWithClient>{t('X months after your last visit', 'X شهرًا بعد آخر زيارة')}</ConfirmWithClient>.
          </>,
          <>
            {t(
              'Payment and refund records: for as long as Saudi accounting and tax rules require, even if you delete your account.',
              'سجلات المدفوعات والمبالغ المستردة: للمدة التي تتطلبها الأنظمة المحاسبية والضريبية في المملكة، حتى لو حذفت حسابك.'
            )}{' '}
            <ConfirmWithClient>{t('Number of years', 'عدد السنوات')}</ConfirmWithClient>
          </>,
          t(
            'Your browser keeps you signed in and remembers your language choice on your own device. Signing out clears your session.',
            'يُبقيك متصفحك مسجّل الدخول ويتذكّر اختيارك للغة على جهازك. ويؤدي تسجيل الخروج إلى إنهاء جلستك.'
          )
        ]} />
      </InfoSection>

      <InfoSection title={t('7. Your choices: changes and deletion', '٧. خياراتك: التعديل والحذف')}>
        <p>
          {t(
            'You can ask us to show you the information we hold about you, correct it, or delete your account and its data. ',
            'يمكنك أن تطلب منا الاطلاع على المعلومات التي نحتفظ بها عنك، أو تصحيحها، أو حذف حسابك وبياناته. '
          )}
          <InfoPageLink page="contact">{t('Contact the studio', 'تواصل مع الاستوديو')}</InfoPageLink>
          {t(
            ' from the phone number on your account, and we will reply within',
            ' من رقم الجوال المسجّل في حسابك، وسنرد خلال'
          )}{' '}
          <ConfirmWithClient>{t('X days', 'X يومًا')}</ConfirmWithClient>.
        </p>
        <p>
          {t(
            'We may need to keep some records after deletion — for example payment records the law requires, or a booking that is still upcoming — and will tell you if so.',
            'قد نحتاج إلى الاحتفاظ ببعض السجلات بعد الحذف — مثل سجلات الدفع التي يُلزمنا بها النظام، أو حجز لم يحن موعده بعد — وسنُعلمك بذلك إن حدث.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('8. Changes to this policy', '٨. التغييرات على هذه السياسة')}>
        <p>
          {t(
            'We may update this policy. The date at the top shows when it last changed.',
            'قد نُحدّث هذه السياسة، ويوضح التاريخ في أعلى الصفحة آخر تحديث لها.'
          )}
        </p>
      </InfoSection>

      <InfoSection title={t('9. Contact', '٩. التواصل')}>
        <p>
          {t('Questions about your privacy? ', 'لديك سؤال عن خصوصيتك؟ ')}
          <InfoPageLink page="contact">{t('Contact the studio', 'تواصل مع الاستوديو')}</InfoPageLink>.
        </p>
      </InfoSection>
    </InfoPageLayout>
  );
};
