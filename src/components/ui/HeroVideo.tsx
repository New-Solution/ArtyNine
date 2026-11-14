/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The home page's full-width video hero.
 *
 * The video autoplays muted and on a loop with no controls. Autoplay needs
 * `muted` + `playsInline` (iOS Safari will not autoplay otherwise), and the
 * poster shows while the file loads, or for good when a browser declines to
 * autoplay. A visitor who prefers reduced motion gets the poster image only:
 * no video element is rendered, so nothing moves and nothing downloads.
 *
 * The overlay copy sits on a dark scrim that deepens toward the bottom, so it
 * stays readable whether that part of the frame is bright or dark.
 */

import React from 'react';
import { useReducedMotion } from 'motion/react';
import Reveal from './Reveal';

interface HeroVideoProps {
  src: string;
  poster: string;
  /** Overlay content: heading, copy and the call to action. */
  children?: React.ReactNode;
}

export const HeroVideo: React.FC<HeroVideoProps> = ({ src, poster, children }) => {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative isolate overflow-hidden bg-brand-charcoal">
      {reduceMotion ? (
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
      ) : (
        <video
          className="absolute inset-0 -z-10 h-full w-full object-cover"
          src={src}
          poster={poster}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          aria-hidden="true"
          tabIndex={-1}
        />
      )}

      {/* Scrim: a light wash over the whole frame, deeper toward the bottom
          where the copy sits. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-t from-brand-charcoal/85 via-brand-charcoal/35 to-brand-charcoal/20"
      />

      <div className="mx-auto flex min-h-[max(480px,min(calc(100svh-78px),900px))] max-w-7xl flex-col justify-end px-4 pb-16 pt-28 sm:px-6 lg:px-8 lg:pb-20">
        <Reveal index={0}>{children}</Reveal>
      </div>
    </section>
  );
};
