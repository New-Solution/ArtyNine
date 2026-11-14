/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A coverflow carousel: the active card centred, its neighbours raked back
 * into depth.
 *
 * This is the supplied reference implementation. Its geometry is the visual
 * target and is reproduced exactly — the transform string, the `falloff` ramp,
 * the 82° tilt cap, the ring-folding loop, the opacity/z-index rules, the
 * exponential settle, the drag and throw, the `ResizeObserver` measurement and
 * every default value (rotate 44, depth 0.6, perspective 3, falloff 0.56,
 * fade 0.1, gap 0.05, cardWidth clamp(148px, 22vw, 260px)). Do not retune
 * these to taste: the section around the carousel is the thing to adapt.
 *
 * Only what could not run in this project was changed:
 *   - `"use client"` removed (Vite, not Next)
 *   - `cn` from `@/lib/utils` does not exist here, so classes compose as
 *     template strings, as the rest of `components/ui` does
 *   - shadcn colour tokens (`bg-muted`, `bg-background`, `text-foreground`,
 *     `ring-ring`) have no definition in this project and would render as
 *     nothing, so each maps to its Arty equivalent. Sizes, radii and shadows
 *     are the reference's.
 *   - the bare `<img>` is `AppImage`, which carries the site's retry-on-failure
 *     behaviour so a workshop photo cannot silently vanish
 *
 * Added for this project, none of it touching the geometry: autoplay that
 * drives the existing settle rather than jumping, `onSelectedChange` and
 * `onActivate` so the section can render its own caption and open a workshop,
 * and a reduced-motion path.
 *
 * Positions are written straight to the DOM. Sixty state updates a second
 * would re-render every card for numbers React never needs to see.
 */

import * as React from 'react';
import { useReducedMotion } from 'motion/react';
import { AppImage } from './AppImage';

const useIsoLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export interface CoverflowSlide {
  src: string;
  alt: string;
}

export interface CoverflowCarouselProps {
  slides: CoverflowSlide[];
  /** Degrees the first neighbour tilts. */
  rotate?: number;
  /** How far the first neighbour recedes, as a fraction of card width. */
  depth?: number;
  /** Viewer distance as a multiple of card width — smaller is a wider lens. */
  perspective?: number;
  /** Exponent on distance. Below 1 the rake eases off as cards travel out. */
  falloff?: number;
  /** Opacity lost per step from the centre. */
  fade?: number;
  /** Any CSS length. Everything else is derived from it, so the rake scales. */
  cardWidth?: string;
  /** Space between cards, as a fraction of card width. */
  gap?: number;
  loop?: boolean;
  showPagination?: boolean;
  /** Advances on its own. Ignored under reduced motion. */
  autoPlay?: boolean;
  autoPlayInterval?: number;
  /** Fires as the centred card changes, including mid-drag. */
  onSelectedChange?: (index: number) => void;
  /** Clicking the centred card. Neighbours recentre instead of activating. */
  onActivate?: (index: number) => void;
  /** Names the carousel for assistive tech. */
  label?: string;
  className?: string;
  cardClassName?: string;
}

export function CoverflowCarousel({
  slides,
  rotate = 44,
  depth = 0.6,
  perspective = 3,
  falloff = 0.56,
  fade = 0.1,
  cardWidth = 'clamp(148px, 22vw, 260px)',
  gap = 0.05,
  loop = true,
  showPagination = false,
  autoPlay = false,
  autoPlayInterval = 4500,
  onSelectedChange,
  onActivate,
  label = 'Cover carousel',
  className = '',
  cardClassName = ''
}: CoverflowCarouselProps) {
  const count = slides.length;
  const prefersReducedMotion = useReducedMotion();

  const frameRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  /** Fractional card index at the centre. The single source of truth. */
  const posRef = React.useRef(0);
  /** Where the current settle is headed. Stepping off `pos` instead would
      swallow a keypress that lands mid-flight, before the round-off moves. */
  const targetRef = React.useRef(0);
  const widthRef = React.useRef(0);
  const rafRef = React.useRef<number | null>(null);
  const dragRef = React.useRef<{
    id: number;
    x: number;
    pos: number;
    v: number;
    t: number;
    moved: boolean;
  } | null>(null);

  const [selected, setSelected] = React.useState(0);
  /** Any reason autoplay should hold: hover, focus, or a hand on the cards. */
  const [paused, setPaused] = React.useState(false);

  // The reference always loops. One card would loop onto itself and two would
  // rake one behind the other rather than reading as a pair, so below three
  // the ring is off — with 3+ cards, which is what this section shows, the
  // behaviour is the reference's exactly.
  const looping = loop && count > 2;

  /** Nearest whole card, folded back into 0..count-1. */
  const indexAt = React.useCallback(
    (pos: number) => ((Math.round(pos) % count) + count) % count,
    [count]
  );

  const paint = React.useCallback(() => {
    const width = widthRef.current;
    if (!width) return;
    const pitch = width * (1 + gap);
    const pos = posRef.current;

    cardRefs.current.forEach((card, index) => {
      if (!card) return;

      // Fold the distance into the shorter way round the ring. This is the
      // whole looping mechanism — no cloned nodes, no shuffling the DOM.
      let offset = index - pos;
      if (looping) {
        offset = ((offset % count) + count) % count;
        if (offset > count / 2) offset -= count;
      }

      const distance = Math.abs(offset);
      // Both the tilt and the recession ease off as cards travel out —
      // doubling the distance adds only about half again as much of each.
      // A linear ramp folds the second card shut; this keeps it readable.
      const ramp = Math.pow(distance, falloff);
      // Capped short of edge-on so a far card never turns its back.
      const tilt = Math.min(rotate * ramp, 82) * Math.sign(offset);

      card.style.transform =
        `translateX(calc(-50% + ${offset * pitch}px)) ` +
        `translateZ(${-depth * width * ramp}px) rotateY(${-tilt}deg)`;

      // A card is teleported across the ring at exactly half a turn out, so it
      // has to be gone by then or the jump is visible.
      const edge = looping ? Math.min(1, Math.max(0, count / 2 - distance)) : 1;
      card.style.opacity = String(Math.max(0, 1 - fade * distance) * edge);
      card.style.zIndex = String(100 - Math.round(distance));
      // Not geometry: only the centred card takes the pointer, so a click can
      // never land on a raked neighbour that merely looks like it is under
      // the cursor.
      card.style.pointerEvents = distance < 0.5 ? 'auto' : 'none';
    });
  }, [count, depth, fade, falloff, gap, looping, rotate]);

  const commitSelected = React.useCallback(
    (index: number) => {
      setSelected(previous => (previous === index ? previous : index));
      onSelectedChange?.(index);
    },
    [onSelectedChange]
  );

  const settle = React.useCallback(
    (target: number) => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      targetRef.current = target;
      commitSelected(indexAt(target));

      // Reduced motion gets the destination with no travel — the same
      // information, without the movement someone asked not to see.
      if (prefersReducedMotion) {
        posRef.current = target;
        paint();
        rafRef.current = null;
        return;
      }

      const step = () => {
        const remaining = target - posRef.current;
        if (Math.abs(remaining) < 0.0004) {
          posRef.current = target;
          paint();
          rafRef.current = null;
          return;
        }
        // ponytail: exponential ease-out, not a spring. Swap in a spring only
        // if the settle needs overshoot.
        posRef.current += remaining * 0.16;
        paint();
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [commitSelected, indexAt, paint, prefersReducedMotion]
  );

  const clamp = React.useCallback(
    (pos: number) => (looping ? pos : Math.max(0, Math.min(count - 1, pos))),
    [count, looping]
  );

  const goTo = React.useCallback(
    (index: number) => {
      // Take the shorter way round rather than unwinding the whole ring.
      const target = looping
        ? index + Math.round((targetRef.current - index) / count) * count
        : index;
      settle(clamp(target));
    },
    [clamp, count, looping, settle]
  );

  const nudge = React.useCallback(
    (by: number) => settle(clamp(Math.round(targetRef.current) + by)),
    [clamp, settle]
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (count < 2) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    targetRef.current = posRef.current;
    setPaused(true);
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      pos: posRef.current,
      v: 0,
      t: performance.now(),
      moved: false
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;

    const pitch = widthRef.current * (1 + gap);
    if (!pitch) return;

    // A few pixels of slack, so a click on the active card is not read as a
    // one-pixel drag and swallowed.
    if (Math.abs(event.clientX - drag.x) > 4) drag.moved = true;

    const now = performance.now();
    const previous = posRef.current;
    posRef.current = clamp(drag.pos - (event.clientX - drag.x) / pitch);
    // Cards per second, for the throw.
    drag.v = ((posRef.current - previous) / Math.max(now - drag.t, 1)) * 1000;
    drag.t = now;

    commitSelected(indexAt(posRef.current));
    paint();
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    setPaused(false);
    if (!drag.moved) {
      // A tap, not a drag: leave the position alone so the card's own click
      // handler decides what happens.
      return;
    }
    // Let a flick carry, but never more than two cards.
    const carried = Math.max(-2, Math.min(2, drag.v * 0.18));
    settle(clamp(Math.round(posRef.current + carried)));
  };

  // Card width drives pitch, depth and perspective, so it is the only thing
  // worth measuring — and only when the box actually changes.
  useIsoLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const measure = () => {
      const card = cardRefs.current[0];
      if (!card) return;
      widthRef.current = card.offsetWidth;
      paint();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [paint]);

  /**
   * Autoplay. Drives `nudge`, so an automatic advance is the same eased settle
   * a click produces — never a swap. Paused rather than torn down while the
   * visitor is involved, so resuming picks up from wherever the cards are
   * instead of restarting the carousel.
   */
  React.useEffect(() => {
    if (!autoPlay || paused || prefersReducedMotion) return;
    // One card cannot advance; two would just flip back and forth on a timer.
    if (count < 3) return;

    const id = window.setInterval(() => nudge(1), Math.max(1200, autoPlayInterval));
    return () => window.clearInterval(id);
  }, [autoPlay, autoPlayInterval, count, nudge, paused, prefersReducedMotion]);

  React.useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  if (count === 0) return null;

  return (
    <div
      className={`w-full ${className}`}
      style={{ ['--cf-card' as string]: cardWidth }}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={event => {
        // Only resume once focus has actually left the carousel.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div className="relative">
        <div
          ref={frameRef}
          tabIndex={0}
          role="group"
          aria-label={`${label}, ${count} item${count === 1 ? '' : 's'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={event => {
            if (count < 2) return;
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              nudge(-1);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              nudge(1);
            }
          }}
          // Vertical padding keeps the drop shadows clear of the overflow clip.
          className="cursor-grab overflow-hidden py-10 outline-none focus-visible:ring-2 focus-visible:ring-brand-sage active:cursor-grabbing"
          style={{
            perspective: `calc(var(--cf-card) * ${perspective})`,
            // Horizontal drag is ours; the page keeps vertical scrolling.
            touchAction: 'pan-y'
          }}
        >
          <div
            className="relative select-none"
            style={{
              height: 'var(--cf-card)',
              transformStyle: 'preserve-3d'
            }}
          >
            {slides.map((slide, index) => (
              <div
                key={index}
                ref={node => {
                  cardRefs.current[index] = node;
                }}
                role="group"
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${count}`}
                onClick={() => {
                  if (index === selected) onActivate?.(index);
                  else goTo(index);
                }}
                className={`absolute left-1/2 top-0 aspect-square overflow-hidden rounded-2xl bg-brand-sand shadow-xl will-change-transform ${
                  onActivate ? 'cursor-pointer' : ''
                } ${cardClassName}`}
                style={{ width: 'var(--cf-card)' }}
              >
                <AppImage
                  src={slide.src}
                  alt={slide.alt}
                  draggable={false}
                  referrerPolicy="no-referrer"
                  className="h-full w-full select-none object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {showPagination && count > 1 && (
        <div className="mt-4 flex items-center justify-center">
          {/* The dot stays 8px; the button around it is a 44px-tall,
              28px-wide tap target, so the row reads the same but is easy to hit. */}
          {slides.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-label={`Go to slide ${index + 1}`}
              aria-current={index === selected}
              onClick={() => goTo(index)}
              className="flex h-11 w-7 cursor-pointer items-center justify-center"
            >
              <span
                className={`size-2 rounded-full bg-brand-charcoal transition-opacity ${
                  index === selected ? 'opacity-100' : 'opacity-30'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
