/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The home page's full-width video hero.
 *
 * Autoplay needs `muted` + `playsInline` (iOS Safari will not autoplay
 * otherwise), and the poster shows while the file loads, or for good when a
 * browser declines to autoplay. The overlay copy sits on a dark scrim that
 * deepens toward the bottom, so it stays readable whether that part of the
 * video is a bright table or a dark corner.
 *
 * Moving content that runs longer than five seconds needs a way to stop it
 * (WCAG 2.2.2), so there is a pause control. A visitor who prefers reduced
 * motion gets the poster and can press play themselves.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Pause, Play } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import Reveal from './Reveal';

interface HeroVideoProps {
  src: string;
  poster: string;
  /** Overlay content: heading, copy and the call to action. */
  children?: React.ReactNode;
}

export const HeroVideo: React.FC<HeroVideoProps> = ({ src, poster, children }) => {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(!reduceMotion);

  // Follow the reduced-motion setting if it is known only after mount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduceMotion) {
      video.pause();
    } else {
      video.play().catch(() => setPlaying(false));
    }
  }, [reduceMotion]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <section className="relative isolate overflow-hidden bg-brand-charcoal">
      <video
        ref={videoRef}
        className="absolute inset-0 -z-10 h-full w-full object-cover"
        src={src}
        poster={poster}
        autoPlay={!reduceMotion}
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      {/* Scrim: a light wash over the whole frame, deeper toward the bottom
          where the copy sits. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-t from-brand-charcoal/85 via-brand-charcoal/35 to-brand-charcoal/20"
      />

      <div className="mx-auto flex min-h-[max(480px,min(calc(100svh-78px),900px))] max-w-7xl flex-col justify-end px-4 pb-16 pt-28 sm:px-6 lg:px-8 lg:pb-20">
        <Reveal index={0}>{children}</Reveal>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('Pause video', 'إيقاف الفيديو مؤقتًا') : t('Play video', 'تشغيل الفيديو')}
        className="absolute bottom-4 end-4 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-brand-cream/40 bg-brand-charcoal/40 text-brand-cream backdrop-blur-sm transition-colors hover:bg-brand-charcoal/70 sm:bottom-6 sm:end-6"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
    </section>
  );
};
