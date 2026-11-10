"use client";

import { useEffect, useRef } from "react";

import { onFrame, readMeter } from "@/lib/audioLevel";

import { MicGlyph } from "./Icons";

// bar heights in px; bars are MAX tall and scaled down, so no layout every frame
const MIN = 3.5;
const MAX = 18;
const BARS = 5;
// the sound starts in the middle bar and ripples out: outer bars show it a few frames later
const DELAY = [6, 3, 0, 3, 6];
// which voice band feeds which bar (center = overall loudness), and how tall each may get
const SOURCE = [2, 0, -1, 1, 3];
const WEIGHT = [0.62, 0.86, 1, 0.82, 0.58];
const HISTORY = 8;

const scale = (h: number) => `scaleY(${(h / MAX).toFixed(3)})`;

interface Props {
  stream: MediaStream | null;
  // red flat line, the mic is off
  muted?: boolean;
  // nothing to show (no one there yet): fades away
  hidden?: boolean;
  className?: string;
}

/**
 * Voice waveform, five bars. Real frequency bands drive the shape, the middle bar
 * reacts first and the sound rolls out to the sides. In silence the bars keep a slow
 * low wave, so a live call never looks dead. Written straight to the DOM every frame.
 */
export function LevelBars({ stream, muted, hidden, className }: Props) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const live = Boolean(stream && !muted && !hidden);

  useEffect(() => {
    const els = bars.current;
    if (!live || !stream) {
      // css eases them into a flat line
      els.forEach((el) => el && (el.style.transform = scale(MIN)));
      return;
    }
    // last few frames of [level, band0..band3], newest first
    const history: number[][] = [];
    const last = new Array(BARS).fill(0);
    return onFrame((now) => {
      const { level, bands } = readMeter(stream, now);
      history.unshift([level, ...bands]);
      if (history.length > HISTORY) history.pop();
      els.forEach((el, i) => {
        if (!el) return;
        const past = history[Math.min(DELAY[i], history.length - 1)];
        const voice = SOURCE[i] < 0 ? past[0] : 0.45 * past[0] + 0.55 * past[1 + SOURCE[i]];
        // idle: a slow wave rolling across, ~3px tall, fades out as the voice comes in
        const idle = (0.5 + 0.5 * Math.sin(now * 0.0038 - i * 0.9)) * 3.2 * (1 - Math.min(1, voice * 3));
        const h = MIN + idle + (MAX - MIN) * WEIGHT[i] * voice;
        // skip tiny changes, fewer style writes
        if (Math.abs(h - last[i]) < 0.2) return;
        last[i] = h;
        el.style.transform = scale(h);
      });
    });
  }, [live, stream]);

  return (
    <span
      className={`bars${muted ? " bars--muted" : ""}${className ? ` ${className}` : ""}`}
      data-live={live || undefined}
      data-hidden={hidden || undefined}
      aria-hidden
    >
      {Array.from({ length: BARS }, (_, i) => (
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

/**
 * Mic icon that fills with green from the bottom as you speak, like liquid in the capsule.
 * Answers "is my mic working?" without a separate meter.
 * on = mic state (the slash), active = meter running (hidden copies don't need it).
 */
export function MicMeter({ stream, on, active = true }: { stream: MediaStream | null; on: boolean; active?: boolean }) {
  const fill = useRef<SVGRectElement>(null);

  useEffect(() => {
    const el = fill.current;
    if (!el) return;
    if (!on || !active || !stream) {
      // drains instead of a cut
      el.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)";
      el.style.transform = "scaleY(0)";
      return;
    }
    // live: written every frame, a transition would only add lag
    el.style.transition = "none";
    let last = -1;
    return onFrame((now) => {
      // normal speech fills most of it, only shouting reaches the top
      const v = Math.min(1, readMeter(stream, now).level * 0.92);
      if (Math.abs(v - last) < 0.008) return;
      last = v;
      el.style.transform = `scaleY(${v.toFixed(3)})`;
    });
  }, [stream, on, active]);

  return <MicGlyph off={!on} fillRef={fill} />;
}
