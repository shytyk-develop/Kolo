"use client";

import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { useMotionSet } from "@/lib/motion";

// home: middle of the card, banner: home under a call card, top: every other screen
export type TabPos = "home" | "banner" | "top";

interface Props {
  pos: TabPos;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  testId?: string;
}

// css clamps it to half the height; framer's radius correction keeps it a semicircle while it morphs
const ROUND = 999;

// tab top before/after this render, so a new screen can ride up with it
export const tabTrack = { prev: 0, now: 0 };

// one tab for every screen: it morphs into place, the fillets ride along, the label crossfades
export function Tab({ pos, label, icon, onClick, ariaLabel, testId }: Props) {
  const m = useMotionSet();
  const ref = useRef<HTMLButtonElement>(null);
  // every render, before the views' layout effects (the tab comes first in the tree)
  useLayoutEffect(() => {
    tabTrack.prev = tabTrack.now;
    tabTrack.now = ref.current?.offsetTop ?? 0;
  });
  return (
    <motion.button
      ref={ref}
      type="button"
      layoutId="tab"
      layoutDependency={`${pos}:${label}`}
      transition={m.morph}
      className="tab"
      data-pos={pos}
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      whileTap="pressed"
      style={{ borderTopRightRadius: ROUND, borderBottomRightRadius: ROUND, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
    >
      <motion.span layout transition={m.morph} className="tab__fillet tab__fillet--a" aria-hidden />
      <motion.span layout transition={m.morph} className="tab__fillet tab__fillet--b" aria-hidden />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={`${pos === "top" ? "top" : "home"}:${label}`}
          layout="position"
          className={`tab__label tab__label--${pos === "top" ? "top" : "home"}`}
          initial={{ opacity: 0, y: m.reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: m.reduced ? 0 : -8, transition: m.leave }}
          transition={m.sweep}
        >
          <motion.span className="tab__inner" variants={m.reduced ? undefined : { pressed: { scale: 0.97 } }} transition={m.snap}>
            <span className="tab__icon">{icon}</span>
            {label}
          </motion.span>
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
