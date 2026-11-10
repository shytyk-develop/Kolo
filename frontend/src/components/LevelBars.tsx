"use client";

import { useEffect, useRef } from "react";

import { onFrame, readLevel } from "@/lib/audioLevel";

const MIN = 5;
const MAX = 18;
// each bar reacts a bit differently, looks like a voice
const WEIGHT = [0.75, 1, 0.9, 0.65];
const SPEED = [0.011, 0.017, 0.013, 0.019];

interface Props {
  // the loudest one drives the bars
  streams: (MediaStream | null | undefined)[];
  // red flat dots, mic is off
  muted?: boolean;
  className?: string;
}

/** Four bars. Heights are written straight to the DOM every frame, no react renders. */
export function LevelBars({ streams, muted, className }: Props) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const live = streams.filter((s): s is MediaStream => Boolean(s));
  // new array every render, the effect only cares about which streams
  const key = live.map((s) => s.id).join(",");

  useEffect(() => {
    const els = bars.current;
    if (muted || !live.length) {
      els.forEach((el) => el && (el.style.height = `${MIN}px`));
      return;
    }
    const last = [MIN, MIN, MIN, MIN];
    return onFrame((now) => {
      const level = Math.max(...live.map(readLevel));
      els.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.82 + 0.18 * Math.sin(now * SPEED[i] + i * 1.7);
        const h = MIN + (MAX - MIN) * Math.min(1, level * WEIGHT[i] * wobble * 1.25);
        // skip tiny changes, fewer style writes
        if (Math.abs(h - last[i]) < 0.3) return;
        last[i] = h;
        el.style.height = `${h.toFixed(1)}px`;
      });
    });
  }, [key, muted]);

  return (
    <span className={`bars${muted ? " bars--muted" : ""}${className ? ` ${className}` : ""}`} aria-hidden>
      {WEIGHT.map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
        />
      ))}
    </span>
  );
}
