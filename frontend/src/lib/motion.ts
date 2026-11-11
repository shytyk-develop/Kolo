"use client";

import { useReducedMotion, type Transition, type Variants } from "motion/react";
import { useMemo } from "react";

// from component.tsx: shapes on a soft spring, content on a quick one a beat later, leaving is faster

// the expanding bar's spring: ~220 ms perceived, no bounce
export const morph: Transition = { type: "spring", stiffness: 240, damping: 30, mass: 0.8 };
// the member rows' spring: ~180 ms perceived
export const sweep: Transition = { type: "spring", stiffness: 400, damping: 35, mass: 0.5 };
// small parts (switch thumb, icon swaps, press): a hair of bounce
export const snap: Transition = { type: "spring", stiffness: 560, damping: 30, mass: 0.5 };
// things on their way out
export const leave: Transition = { type: "tween", duration: 0.14, ease: [0.4, 0, 1, 1] };
// reduced motion: everything is a short fade
export const fade: Transition = { type: "tween", duration: 0.12, ease: "linear" };

export const STAGGER = 0.025;
// rows wait for the shape to get going
export const CONTENT_DELAY = 0.04;
export const PRESS_SCALE = 0.97;
export const SLIDE = 8;

export interface MotionSet {
  reduced: boolean;
  morph: Transition;
  sweep: Transition;
  snap: Transition;
  leave: Transition;
  // a view's frame: holds the stagger, leaves with a fade and a short slide
  frame: Variants;
  // one row of a view
  row: Variants;
  // popovers, sheets and toasts
  pop: Variants;
  press: { scale: number } | undefined;
}

function build(reduced: boolean): MotionSet {
  if (reduced) {
    const still: Variants = {
      hidden: { opacity: 0 },
      shown: { opacity: 1, transition: fade },
      gone: { opacity: 0, transition: fade },
    };
    return {
      reduced,
      morph: fade,
      sweep: fade,
      snap: fade,
      leave: fade,
      frame: { hidden: {}, shown: {}, gone: { opacity: 0, transition: fade } },
      row: { hidden: { opacity: 0 }, shown: { opacity: 1, transition: fade } },
      pop: still,
      press: undefined,
    };
  }
  return {
    reduced,
    morph,
    sweep,
    snap,
    leave,
    frame: {
      hidden: {},
      shown: { transition: { staggerChildren: STAGGER, delayChildren: CONTENT_DELAY } },
      // custom = 1 going forward (old view slides up), -1 going back
      gone: (dir: number = 1) => ({ opacity: 0, y: -SLIDE * dir, transition: leave }),
    },
    row: {
      hidden: { opacity: 0, y: 10 },
      shown: { opacity: 1, y: 0, transition: sweep },
    },
    pop: {
      hidden: { opacity: 0, scale: 0.94, y: 6 },
      shown: { opacity: 1, scale: 1, y: 0, transition: sweep },
      gone: { opacity: 0, scale: 0.97, transition: leave },
    },
    press: { scale: PRESS_SCALE },
  };
}

const FULL = build(false);
const REDUCED = build(true);

/** The presets, swapped for 120 ms fades when the system asks for less motion. */
export function useMotionSet(): MotionSet {
  const reduced = Boolean(useReducedMotion());
  return useMemo(() => (reduced ? REDUCED : FULL), [reduced]);
}
