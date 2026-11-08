/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contact — public, no sign-in. Every detail comes from studioConfig.ts, the
 * same constants the home page's "Slow down & visit us" block and the footer
 * use. Items the site does not have yet are shown as [CONFIRM WITH CLIENT].
 */

import React from 'react';
import { MapPin, Clock, Phone, Mail, Instagram, Facebook, MessageCircle, Building2 } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  STUDIO_PHONE, STUDIO_PHONE_TEL, STUDIO_WHATSAPP_URL, STUDIO_WHATSAPP_DISPLAY, STUDIO_EMAIL,
  STUDIO_ADDRESS, STUDIO_ADDRESS_AR, STUDIO_MAPS_URL, STUDIO_HOURS, STUDIO_INSTAGRAM_URL, STUDIO_INSTAGRAM_HANDLE,
  STUDIO_TIKTOK_URL, STUDIO_FACEBOOK_URL
} from '../utils/studioConfig';
import { InfoPageLayout, InfoSection, ConfirmWithClient, InfoPageLink } from './ui/InfoPage';

const linkClass = 'font-semibold text-brand-charcoal hover:text-brand-terracotta break-words';

const Row: React.FC<{ icon: React.ElementType; label: string; children: React.ReactNode }> = ({ icon: Icon, label, children }) => (
  <div className="flex items-start gap-3 rounded-2xl border border-brand-clay bg-brand-sand/30 p-4 text-start">
    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-terracotta" />
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-muted">{label}</span>
      <div className="mt-1 text-sm text-brand-charcoal">{children}</div>
    </div>
  </div>
);

export const ContactSection: React.FC = () => {
  const { t } = useLanguage();
  const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

  return (
    <InfoPageLayout
      eyebrow={t('Contact', 'تواصل معنا')}
      title={t('Contact Arty Café', 'تواصل مع آرتي كافيه')}
      intro={t(
        'Questions about a booking, a birthday party or your pottery piece? We would love to hear from you.',
        'لديك سؤال عن حجز أو حفلة عيد ميلاد أو قطعتك الفخارية؟ يسعدنا تواصلك.'
      )}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Row icon={MapPin} label={t('Address', 'العنوان')}>
          <p>{t(STUDIO_ADDRESS, STUDIO_ADDRESS_AR)}</p>
          <a href={STUDIO_MAPS_URL} {...external} className="mt-1 inline-block text-xs font-semibold text-brand-terracotta underline underline-offset-4">
            {t('Open in Google Maps', 'افتح في خرائط Google')}
          </a>
        </Row>

        <Row icon={Clock} label={t('Opening Hours', 'ساعات العمل')}>
          <p className="ltr-numerals">{t('Every day', 'يوميًا')}: {STUDIO_HOURS}</p>
        </Row>

        <Row icon={Phone} label={t('Call Front Desk', 'اتصل بالاستقبال')}>
          <a href={STUDIO_PHONE_TEL} dir="ltr" className={`${linkClass} font-mono ltr-numerals`}>{STUDIO_PHONE}</a>
        </Row>

        <Row icon={MessageCircle} label={t('WhatsApp', 'واتساب')}>
          <a href={STUDIO_WHATSAPP_URL} {...external} dir="ltr" className={`${linkClass} font-mono ltr-numerals`}>{STUDIO_WHATSAPP_DISPLAY}</a>
        </Row>

        <Row icon={Mail} label={t('Email', 'البريد الإلكتروني')}>
          <a href={`mailto:${STUDIO_EMAIL}`} className={linkClass}>{STUDIO_EMAIL}</a>
        </Row>

        <Row icon={Instagram} label="Instagram">
          <a href={STUDIO_INSTAGRAM_URL} {...external} dir="ltr" className={linkClass}>{STUDIO_INSTAGRAM_HANDLE}</a>
        </Row>
      </div>

      <InfoSection title={t('Also find us on', 'تجدنا أيضًا على')}>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <a href={STUDIO_TIKTOK_URL} {...external} className={linkClass}>TikTok</a>
          <a href={STUDIO_FACEBOOK_URL} {...external} className={`${linkClass} inline-flex items-center gap-1.5`}>
            <Facebook className="h-4 w-4" /> Facebook
          </a>
        </div>
      </InfoSection>

      <InfoSection title={t('Business details', 'بيانات المنشأة')}>
        <Row icon={Building2} label={t('Registered business', 'المنشأة المسجلة')}>
          <ul className="space-y-1">
            <li>{t('Legal name', 'الاسم النظامي')}: <ConfirmWithClient /></li>
            <li>{t('Commercial Registration (CR) no.', 'رقم السجل التجاري')}: <ConfirmWithClient /></li>
            <li>{t('VAT no.', 'الرقم الضريبي')}: <ConfirmWithClient /></li>
          </ul>
        </Row>
      </InfoSection>

      <p className="text-sm text-brand-ink">
        <InfoPageLink page="cancellation-policy">{t('Cancellation & Refund Policy', 'سياسة الإلغاء والاسترداد')}</InfoPageLink>
        <span className="mx-2 text-brand-muted">·</span>
        <InfoPageLink page="terms">{t('Terms & Conditions', 'الشروط والأحكام')}</InfoPageLink>
      </p>
    </InfoPageLayout>
  );
};
