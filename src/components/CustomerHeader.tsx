/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Palette, Coffee, Menu, X, User, Calendar, Flame, Instagram, Facebook, Globe } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { Footer } from './ui/Footer';
import { LanguageToggle } from './LanguageToggle';
import { CustomerNotificationBell } from './ui/CustomerNotificationBell';

/** The café's main website (artybooking.com). This app is the booking site
 *  under it; the logo and a "Main website" link lead back there. */
export const MAIN_WEBSITE_URL = 'https://artybooking.com';

export const CustomerHeader: React.FC = () => {
  const { customerTab, setCustomerTab, currentUser, setWorkshopsInitialCategory } = useApp();
  const { t } = useLanguage();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems = [
    { id: 'home', label: t('Home', 'الرئيسية'), icon: Coffee },
    { id: 'workshops', label: t('Workshops', 'الورش'), icon: Palette },
    { id: 'my-bookings', label: t('My Bookings', 'حجوزاتي'), icon: Calendar },
    { id: 'my-pieces', label: t('My Pieces', 'أعمالي'), icon: Flame },
    {
      id: 'auth',
      label: currentUser ? t('My Account', 'حسابي') : t('Login', 'تسجيل الدخول'),
      icon: User
    },
  ] as const;

  const handleNavClick = (tabId: typeof navItems[number]['id']) => {
    // A general nav click always means "browse everything" — clears any
    // category filter left over from a deep link like the birthday band.
    if (tabId === 'workshops') setWorkshopsInitialCategory('All');
    setCustomerTab(tabId);
    setMobileMenuOpen(false);
  };

  return (
      <header className="sticky top-0 z-40 w-full border-b border-brand-clay bg-brand-cream/92 backdrop-blur-md">
        <div className="mx-auto flex h-[78px] max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-12">

          {/* Wordmark — links to the café's main website. "Home" in the
              menu is still this app's own home page. */}
          <a
            href={MAIN_WEBSITE_URL}
            aria-label={t('Arty Café — main website', 'آرتي كافيه — الموقع الرئيسي')}
            className="flex items-center gap-3 text-start group focus:outline-none cursor-pointer shrink-0"
          >
            <img
              src={`${import.meta.env.BASE_URL}images/arty-logo-wordmark.png`}
              alt="Arty Café"
              className="h-10 w-auto object-contain transition-transform duration-300 group-hover:-rotate-6"
            />
            {/* Just the tagline now — the logo already reads "Arty Café".
                It is a single line, so it centres against the logo rather
                than sitting where the top line of the old two-line block was. */}
            <span className="text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-brand-sage">
              Jeddah Art &amp; Clay
            </span>
          </a>

          {/* Desktop navigation — plain words, weight marks the active one */}
          <nav className="hidden md:flex items-center gap-[30px]">
            {navItems.map(item => {
              const isActive = customerTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  className={`text-sm transition-colors cursor-pointer ${
                    isActive
                      ? 'font-semibold text-brand-charcoal'
                      : 'font-normal text-brand-ink hover:text-brand-charcoal'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
            <a
              href={MAIN_WEBSITE_URL}
              className="text-sm font-normal text-brand-ink transition-colors hover:text-brand-charcoal"
            >
              {t('Main website', 'الموقع الرئيسي')}
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            {/* In the bar itself at every width, not folded into the mobile
                drawer: a piece-is-ready notice is time-sensitive, and burying it
                one tap deeper on the smaller screen is the wrong trade. Renders
                nothing at all for a signed-out visitor. */}
            <CustomerNotificationBell />
            <LanguageToggle />

            {/* Mobile menu */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-xl text-brand-charcoal hover:bg-brand-sand focus:outline-none cursor-pointer"
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>

        {/* Mobile drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-brand-clay bg-brand-cream px-4 py-4 space-y-1 shadow-card-sm animate-in fade-in slide-in-from-top-4 duration-200">
            {navItems.map(item => {
              const Icon = item.icon;
              const isActive = customerTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-base cursor-pointer ${
                    isActive
                      ? 'bg-brand-sand font-semibold text-brand-charcoal'
                      : 'font-medium text-brand-ink hover:bg-brand-sand/60'
                  }`}
                >
                  <Icon className="h-5 w-5 text-brand-sage" />
                  {item.label}
                </button>
              );
            })}
            <a
              href={MAIN_WEBSITE_URL}
              className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-base font-medium text-brand-ink hover:bg-brand-sand/60"
            >
              <Globe className="h-5 w-5 text-brand-sage" />
              {t('Main website', 'الموقع الرئيسي')}
            </a>
            <button
              onClick={() => handleNavClick('workshops')}
              className="mt-2 w-full cursor-pointer rounded-2xl bg-brand-terracotta px-4 py-3.5 text-sm font-semibold text-brand-cream"
            >
              Book Now
            </button>
          </div>
        )}
      </header>
  );
};

/**
 * WhatsApp and TikTok have no lucide icon, so their marks are inline.
 * Both inherit `currentColor`, so they pick up the button's hover state like
 * the lucide icons beside them.
 */
const WhatsAppIcon: React.FC<{ className?: string }> = ({ className = 'h-5 w-5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.347-.347.52-.52.174-.174.232-.298.348-.497.115-.198.057-.371-.058-.52-.116-.148-.696-1.653-.943-2.238-.247-.585-.5-.5-.685-.5-.174 0-.372-.025-.57-.025-.199 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.247-.694.247-1.29.173-1.414-.074-.124-.272-.198-.57-.347Z" />
    <path d="M20.52 3.449A11.876 11.876 0 0 0 12.05 0C5.495 0 .16 5.334.157 11.892c0 2.096.548 4.142 1.588 5.945L0 24l6.304-1.654a11.88 11.88 0 0 0 5.741 1.463h.005c6.554 0 11.89-5.335 11.893-11.893a11.82 11.82 0 0 0-3.423-8.467Zm-8.47 18.293h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.981.999-3.648-.235-.374a9.86 9.86 0 0 1-1.511-5.267c.002-5.45 4.437-9.884 9.889-9.884a9.82 9.82 0 0 1 6.988 2.898 9.825 9.825 0 0 1 2.892 6.994c-.003 5.45-4.437 9.884-9.884 9.884Z" />
  </svg>
);

const TikTokIcon: React.FC<{ className?: string }> = ({ className = 'h-5 w-5' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M16.6 5.82a4.28 4.28 0 0 1-1.05-2.82h-3.1v12.2a2.36 2.36 0 1 1-1.7-2.27V9.75a5.46 5.46 0 1 0 4.8 5.42V8.9a7.32 7.32 0 0 0 4.28 1.38V7.18a4.29 4.29 0 0 1-3.23-1.36Z" />
  </svg>
);

export const CustomerFooter: React.FC = () => {
  const { goToStaffLogin, currentStaff, returnToStaffConsole } = useApp();
  const { t } = useLanguage();

  /* Hours, the address and the front-desk number are deliberately absent:
     they are all shown in "Slow down & visit us" on the home page, and a
     second copy here is one more place to forget to update. */
  return (
    <Footer
      logo={
        <img
          src={`${import.meta.env.BASE_URL}images/arty-logo-wordmark.png`}
          alt=""
          className="h-10 w-auto object-contain"
        />
      }
      brandName="Arty Café"
      tagline={t('Jeddah Art & Clay', 'جدة للفن والطين')}
      blurb={t(
        'Jeddah’s cozy creative sanctuary. Crafting memories, pouring fine coffee, and molding mud into masterworks since 2021.',
        'ملاذ جدة الإبداعي. نصنع الذكريات، ونقدّم قهوة مختصة، ونحوّل الطين إلى تحف منذ ٢٠٢١.'
      )}
      socialLinks={[
        {
          icon: <WhatsAppIcon />,
          href: 'https://wa.me/966548182404',
          label: t('WhatsApp', 'واتساب')
        },
        {
          icon: <Instagram className="h-5 w-5" />,
          href: 'https://www.instagram.com/arty.cafe',
          label: 'Instagram'
        },
        {
          icon: <TikTokIcon />,
          href: 'https://www.tiktok.com/@artycafe',
          label: 'TikTok'
        },
        {
          icon: <Facebook className="h-5 w-5" />,
          href: 'https://www.facebook.com/people/Arty-Cafe/100041894486483/',
          label: 'Facebook'
        }
      ]}
      mainLinks={[
        { label: t('Main website', 'الموقع الرئيسي'), href: MAIN_WEBSITE_URL },
        /* TEMPORARY — DEVELOPMENT CONVENIENCE. Reconsider before launch.
           This restores the public "Staff Login" link that was removed with
           the customer/staff site separation, which deliberately stopped the
           customer site advertising the console's existence and location to
           anonymous visitors. That reasoning still holds; the link is back
           only so the console stays one click away while both sites are being
           built. Removing this entry restores the separated behaviour.

           goToStaffLogin() opens the console in this same tab on the current
           domain (adding ?staff on a shared domain such as app.artybooking.com),
           so it works on one domain and on the old split setup alike. */
        currentStaff
          ? {
              label: t('Back to Staff Console', 'العودة إلى لوحة الموظفين'),
              onClick: () => returnToStaffConsole(),
              emphasis: true
            }
          : {
              label: t('Staff Login', 'دخول الموظفين'),
              onClick: () => goToStaffLogin()
            }
      ]}
      copyright={{
        text: t('© 2026 Arty Café Jeddah.', '© ٢٠٢٦ آرتي كافيه جدة.'),
        license: t('All rights reserved.', 'جميع الحقوق محفوظة.')
      }}
    />
  );
};
