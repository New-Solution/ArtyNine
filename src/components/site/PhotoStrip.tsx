/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from 'react';
import {
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useTransform,
  useVelocity
} from 'motion/react';
import { useLanguage } from '../../context/LanguageContext';

export interface StripPhoto {
  src: string;
  alt: string;
}

interface PhotoStripProps {
  photos: StripPhoto[];
  /** Seconds for one full loop at rest. */
  duration?: number;
  /** Run against the reading direction. */
  reverse?: boolean;
}

/** Three frame shapes in turn, so the strip has a rhythm rather than a grid. */
const FRAME = [
  'h-56 w-44 sm:h-80 sm:w-64',
  'h-44 w-60 sm:h-64 sm:w-96',
  'h-52 w-52 sm:h-72 sm:w-72'
];

/**
 * The studio's photographs on an endless, slowly moving strip that speeds up
 * while the page is scrolled.
 *
 * The photos are rendered twice side by side and the track moves by exactly
 * one copy (50%) before wrapping, so the loop has no seam. It travels with the
 * reading direction (leftwards in English, rightwards in Arabic) and only runs
 * while it is on screen. With reduced motion it is a still row the visitor can
 * scroll sideways by hand.
 */
export const PhotoStrip: React.FC<PhotoStripProps> = ({ photos, duration = 60, reverse = false }) => {
  const { lang } = useLanguage();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { margin: '100px' });

  // Track position as a percentage of the track's width, wrapped to 0..-50.
  const offset = useMotionValue(0);
  const x = useTransform(offset, v => `${v}%`);

  const { scrollY } = useScroll();
  const scrollSpeed = useVelocity(scrollY);
  const boost = useRef(1);

  const leftwards = (lang === 'ar') === reverse;

  useAnimationFrame((_, delta) => {
    if (reduce || !inView) return;
    // Scroll fast and the strip runs, stop and it eases back to its rest pace.
    const target = 1 + Math.min(Math.abs(scrollSpeed.get()) / 700, 4);
    boost.current += (target - boost.current) * (target > boost.current ? 0.25 : 0.04);
    const step = (50 / (duration * 1000)) * delta * boost.current;
    let next = offset.get() + (leftwards ? -step : step);
    if (next <= -50) next += 50;
    if (next > 0) next -= 50;
    offset.set(next);
  });

  const frames = (copy: number) =>
    photos.map((photo, i) => (
      <div
        key={`${copy}-${photo.src}`}
        className={`mx-2 shrink-0 overflow-hidden rounded-[18px] bg-brand-clay sm:mx-3 sm:rounded-[24px] ${FRAME[i % FRAME.length]}`}
      >
        <img
          src={photo.src}
          alt={copy === 0 ? photo.alt : ''}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      </div>
    ));

  if (reduce) {
    return (
      <div ref={rootRef} className="photo-strip overflow-x-auto pb-2">
        <div className="flex w-max items-center px-2">{frames(0)}</div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="photo-strip overflow-hidden">
      <motion.div style={{ x }} className="flex w-max items-center will-change-transform">
        <div className="flex shrink-0 items-center">{frames(0)}</div>
        <div className="flex shrink-0 items-center" aria-hidden="true">{frames(1)}</div>
      </motion.div>
    </div>
  );
};
