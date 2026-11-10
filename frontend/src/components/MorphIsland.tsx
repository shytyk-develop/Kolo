"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Island } from "./Island";

export interface IslandItem {
  // new key = new content, the island morphs to its size
  key: string;
  node: ReactNode;
  tone?: "default" | "danger";
}

interface Layer extends IslandItem {
  id: number;
}

let nextId = 1;

// hidden = shrinks to a small capsule and fades, appearing grows out of it
const PILL = { w: 96, h: 30 };

/** Floating top island that changes its content and size like the iPhone one. null hides it. */
export function MorphIsland({ item }: { item: IslandItem | null }) {
  // keep the last content while hiding, so it slides away with text in it.
  // Only on a new key: the parent makes a new item object every render.
  const [kept, setKept] = useState(item);
  if (item && item.key !== kept?.key) setKept(item);
  const shown = item ?? kept;

  const [leaving, setLeaving] = useState<Layer[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const prev = useRef<IslandItem | null>(shown);
  const current = useRef<HTMLDivElement>(null);

  // the old content fades out on top of the new one
  useEffect(() => {
    const old = prev.current;
    if (old && shown && old.key !== shown.key) {
      setLeaving((list) => [...list.filter((l) => l.key !== shown.key), { ...old, id: nextId++ }]);
    }
    // only on a new key, same content re-rendering is not a change
  }, [shown?.key]);

  // runs after the one above, so that one still sees the previous content
  useEffect(() => {
    prev.current = shown;
  });

  // size follows the current content
  useLayoutEffect(() => {
    const el = current.current;
    if (!el) return;
    const measure = () => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown?.key]);

  const hidden = !item || !size;
  const w = hidden ? PILL.w : size.w;
  const h = hidden ? PILL.h : size.h;

  return (
    <Island
      edge="float"
      className={`morph${shown?.tone === "danger" ? " morph--danger" : ""}`}
      data-hidden={hidden || undefined}
      aria-live="polite"
      style={
        {
          "--w": `${w}px`,
          "--h": `${h}px`,
          "--r": `${Math.min(h / 2, 26)}px`,
        } as React.CSSProperties
      }
    >
      {leaving.map((l) => (
        <div
          key={l.id}
          className="morph__layer morph__layer--out"
          aria-hidden
          onAnimationEnd={() => setLeaving((list) => list.filter((x) => x.id !== l.id))}
        >
          {l.node}
        </div>
      ))}
      {shown && (
        <div key={shown.key} ref={current} className="morph__layer">
          {shown.node}
        </div>
      )}
    </Island>
  );
}
