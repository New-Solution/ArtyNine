/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * About — public, no sign-in, also reachable as `?page=about` (see
 * src/utils/infoPages.ts). The story, the studio's services, and a way into
 * the workshops.
 *
 * Laid out after the old artybooking.com About page: overlapping photos on
 * one side, the story on the other. Logical properties only, so it mirrors in
 * Arabic without branching.
 */

import React from 'react';
import { PhotoStrip } from './site/PhotoStrip';
import { Disc3, Hand, Palette, Users, Cake, PartyPopper, Coffee, ArrowRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useLanguage } from '../context/LanguageContext';
import { ScrollReveal } from './ui/ScrollReveal';
import { Scribble } from './ui/AboutArtyTeaser';

const img = (path: string) => `${import.meta.env.BASE_URL}images/${path}`;

const rise = (delay = 0) => ({
  once: true as const,
  viewOptions: { once: true, amount: 0.25 },
  transition: { delay, duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
  variants: { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } }
});

/** The café's own photographs for the "From the studio" strip. */
const STUDIO_PHOTOS: { file: string; en: string; ar: string }[] = [
  { file: 'studio-01.jpg', en: 'Underglaze bottles beside a wall of fired colour test tiles', ar: 'زجاجات ألوان بجانب جدار من بلاطات اختبار الألوان المحروقة' },
  { file: 'studio-02.jpg', en: 'Hands trimming a terracotta pot on the wheel', ar: 'يدان تشذّبان إناءً فخاريًا على العجلة' },
  { file: 'studio-03.jpg', en: 'Throwing a bowl on the potter’s wheel', ar: 'تشكيل وعاء على عجلة الفخار' },
  { file: 'studio-04.jpg', en: 'Paint-covered studio tables under handmade ceramic lamps', ar: 'طاولات الاستوديو الملوّنة تحت مصابيح خزفية مصنوعة يدويًا' },
  { file: 'studio-05.jpg', en: 'A studio wall hung with students’ paintings', ar: 'جدار في الاستوديو تزيّنه لوحات المشاركين' },
  { file: 'studio-06.jpg', en: 'Shelves of glazed cups and bowls made by students', ar: 'رفوف من الأكواب والأوعية المزجّجة من صنع المشاركين' },
  { file: 'studio-07.jpg', en: 'A hand reaching for brushes in a handmade cup', ar: 'يد تمتد إلى فُرش في كوب مصنوع يدويًا' },
  { file: 'studio-08.jpg', en: 'An artist holding a loaded paint palette', ar: 'فنان يحمل لوحة ألوان مليئة' },
  { file: 'studio-09.jpg', en: 'Shaping a cylinder with a rib tool at the wheel', ar: 'تشكيل أسطوانة بأداة التسوية على العجلة' },
  { file: 'studio-10.jpg', en: 'A visitor looking at the portrait wall', ar: 'زائر يتأمل جدار اللوحات' },
  { file: 'studio-11.jpg', en: 'A pot spinning on the wheel, seen from above', ar: 'إناء يدور على العجلة من الأعلى' },
  { file: 'studio-12.jpg', en: 'The pottery room mid-session, trays of thrown cups drying', ar: 'غرفة الفخار أثناء الورشة وصواني الأكواب تجف' }
];

export const AboutSection: React.FC = () => {
  const { setCustomerTab, setWorkshopsInitialCategory } = useApp();
  const { t } = useLanguage();
  const studioPhotos = STUDIO_PHOTOS.map(p => ({ src: img(`hero/${p.file}`), alt: t(p.en, p.ar) }));

  const browseWorkshops = () => {
    setWorkshopsInitialCategory('All');
    setCustomerTab('workshops');
  };

  /* [CONFIRM WITH CLIENT] — the services list and the one-liners below are a
     starting point. Add, remove or reword entries once the client confirms
     what Arty offers. */
  const services = [
    {
      icon: Disc3,
      title: t('Pottery wheel', 'عجلة الفخار'),
      desc: t('Center, throw and shape your own clay pieces on the wheel.', 'شكّل قطعك الفخارية بنفسك على عجلة الفخار.')
    },
    {
      icon: Hand,
      title: t('Hand-building', 'التشكيل اليدوي'),
      desc: t('Pinch, coil and slab clay into anything you can imagine.', 'شكّل الطين بيديك بالقرص واللفائف والشرائح كما تتخيّل.')
    },
    {
      icon: Palette,
      title: t('Painting', 'الرسم'),
      desc: t('Canvas, acrylics and colour, guided step by step.', 'لوحات وألوان أكريليك، مع توجيه خطوة بخطوة.')
    },
    {
      icon: Users,
      title: t('Workshops', 'الورش'),
      desc: t('Small, hands-on classes for every age and skill level.', 'ورش عملية بأعداد محدودة لكل الأعمار والمستويات.')
    },
    {
      icon: Cake,
      title: t('Birthday parties', 'حفلات أعياد الميلاد'),
      desc: t('Creative celebrations with art, balloons and cake.', 'احتفالات إبداعية بالفن والبالونات والكيك.')
    },
    {
      icon: PartyPopper,
      title: t('Private events', 'الفعاليات الخاصة'),
      desc: t('Team-building, gatherings and custom events, made to measure.', 'بناء الفريق والتجمعات والفعاليات المخصصة حسب طلبك.')
    },
    {
      icon: Coffee,
      title: t('Café', 'المقهى'),
      desc: t('Fresh coffee and a cozy corner while you create.', 'قهوة طازجة وركن دافئ بينما تبدع.')
    }
  ];

  return (
    <div className="animate-in fade-in duration-300">

      {/* STORY — photos on one side, words on the other. */}
      <section className="relative overflow-hidden bg-brand-cream py-14 md:py-24">
        <div aria-hidden="true" className="pointer-events-none absolute -start-24 top-10 h-72 w-72 rounded-full bg-brand-sage-soft" />

        <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-8">

          {/* Overlapping photos. A fixed-ratio stage keeps the overlap the
              same at every width. */}
          <ScrollReveal {...rise(0)} className="relative mx-auto aspect-[1/1] w-full max-w-[540px]">
            <img
              src={img('hero/studio-04.jpg')}
              alt={t('Paint-covered studio tables under handmade ceramic lamps', 'طاولات الاستوديو الملوّنة تحت مصابيح خزفية مصنوعة يدويًا')}
              className="absolute start-0 top-0 h-[78%] w-[72%] rounded-[26px] object-cover shadow-card"
              loading="lazy"
              decoding="async"
            />
            <img
              src={img('hero/studio-02.jpg')}
              alt={t('Hands trimming a terracotta pot on the wheel', 'يدان تهذّبان إناءً فخاريًا على العجلة')}
              className="absolute bottom-0 end-0 h-[58%] w-[52%] rounded-[26px] border-[6px] border-brand-cream object-cover shadow-card"
              loading="lazy"
              decoding="async"
            />
            <img
              src={img('hero/studio-08.jpg')}
              alt={t('An artist holding a loaded paint palette', 'فنان يحمل لوحة ألوان')}
              className="absolute bottom-[6%] start-[8%] h-24 w-24 rounded-full border-[5px] border-brand-cream object-cover shadow-card sm:h-32 sm:w-32"
              loading="lazy"
              decoding="async"
            />
            <svg aria-hidden="true" viewBox="0 0 100 100" fill="none" className="absolute end-[6%] top-[8%] h-12 w-12 text-brand-terracotta/70">
              <path d="M50 10c4 22 14 32 36 36-22 4-32 14-36 36-4-22-14-32-36-36 22-4 32-14 36-36Z" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" />
            </svg>
          </ScrollReveal>

          {/* The story */}
          <div className="text-start">
            <ScrollReveal {...rise(0.05)}>
              <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage rtl:tracking-normal">
                {t('About Arty', 'عن آرتي')}
              </span>
            </ScrollReveal>

            <ScrollReveal {...rise(0.12)}>
              <h1 className="mt-3 font-display text-[36px] font-semibold leading-[1.1] text-brand-charcoal sm:text-5xl lg:text-[56px]">
                <span className="relative inline-block">
                  {t('It Was All A Dream…', 'بدأ كل شيء بحلم…')}
                  <Scribble className="absolute -bottom-3 start-0 h-3 w-2/3 text-brand-sage" />
                </span>
              </h1>
            </ScrollReveal>

            <ScrollReveal {...rise(0.2)}>
              <div className="mt-8 space-y-5 text-base leading-[1.8] text-brand-ink sm:text-[17px]">
                <p>
                  {t(
                    'Arty: your creative destination for art, expression and inspiration. We are an interactive art space offering hands-on workshops in pottery, painting and other crafts, all within a warm and welcoming environment that blends learning, fun and self-expression.',
                    'آرتي: وجهتك الإبداعية للفن والتعبير والإلهام. نحن مساحة فنية تفاعلية نقدّم ورشًا عملية في الفخار والرسم وحِرف يدوية أخرى، في أجواء دافئة ومرحِّبة تجمع بين التعلّم والمتعة والتعبير عن الذات.'
                  )}
                </p>
                <p>
                  {t(
                    'At Arty, we believe art is a powerful tool for healing, connection and self-discovery. Our experiences are designed for all ages, whether you’re an artist, a beginner, or simply looking for a peaceful and joyful moment.',
                    'نؤمن في آرتي بأن الفن وسيلة قوية للتعافي والتواصل واكتشاف الذات. صمّمنا تجاربنا لتناسب جميع الأعمار، سواء كنت فنانًا أو مبتدئًا أو تبحث ببساطة عن لحظة هادئة ومبهجة.'
                  )}
                </p>
                <p>
                  {t(
                    'We celebrate cultural heritage through modern creativity, giving our visitors the chance to create unique pieces and reconnect with the beauty of handmade art.',
                    'نحتفي بالتراث الثقافي من خلال إبداع عصري، ونمنح زوّارنا فرصة صنع قطع فريدة وإعادة التواصل مع جمال الفن المصنوع يدويًا.'
                  )}
                </p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* FROM THE STUDIO — the café's own photographs on a slow moving strip. */}
      <section className="bg-brand-cream pb-16 md:pb-20" aria-label={t('From the studio', 'من الاستوديو')}>
        <PhotoStrip photos={studioPhotos} />
      </section>

      {/* OUR SERVICES */}
      <section className="border-y border-brand-clay bg-brand-sand py-16 md:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-xl text-center">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-sage rtl:tracking-normal">
              {t('What we do', 'ماذا نقدّم')}
            </span>
            <ScrollReveal {...rise(0)}>
              <h2 className="mt-2 font-display text-3xl font-semibold text-brand-charcoal md:text-[38px]">
                {t('Our Services', 'خدماتنا')}
              </h2>
            </ScrollReveal>
          </div>

          {/* Flex rather than grid, so a short last row centres instead of
              leaving an empty slot. */}
          <ul className="mt-10 flex flex-wrap justify-center gap-4 sm:gap-5">
            {services.map((service, i) => {
              const Icon = service.icon;
              return (
                <ScrollReveal key={service.title} as="li" {...rise(Math.min(i, 4) * 0.07)} className="w-full sm:w-[calc(50%-10px)] lg:w-[calc(25%-15px)]">
                  <div className="flex h-full items-start gap-4 rounded-[22px] border border-brand-clay bg-brand-cream p-5 text-start shadow-card-sm transition-transform duration-300 motion-safe:hover:-translate-y-1 sm:flex-col sm:gap-0 sm:p-6">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-brand-sage-soft text-brand-sage-hover sm:mb-5">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-display text-lg font-semibold text-brand-charcoal">{service.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-brand-ink">{service.desc}</p>
                    </div>
                  </div>
                </ScrollReveal>
              );
            })}
          </ul>
        </div>
      </section>

      {/* CALL TO ACTION */}
      <section className="bg-brand-cream py-16 md:py-20">
        <ScrollReveal {...rise(0)} className="mx-auto max-w-2xl px-4 text-center sm:px-6">
          <h2 className="font-display text-3xl font-semibold text-brand-charcoal md:text-[38px]">
            {t('Ready to get your hands messy?', 'مستعد تلوّث يديك بالفن؟')}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-brand-ink">
            {t('Pick a workshop and book your seat in a few taps.', 'اختر ورشة واحجز مقعدك بخطوات بسيطة.')}
          </p>
          <button
            type="button"
            onClick={browseWorkshops}
            className="pill-btn pill-btn-primary mt-8 w-full px-7 py-4 text-base shadow-button sm:w-auto"
          >
            <span>{t('Browse Workshops', 'تصفح الورش')}</span>
            <span className="pill-btn-arrow" aria-hidden="true"><ArrowRight className="h-4 w-4 flip-rtl" /></span>
          </button>
        </ScrollReveal>
      </section>
    </div>
  );
};
