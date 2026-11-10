"use client";

import { useLayoutEffect, useRef, ViewTransition } from "react";

const key = (name: string) => `kolo:rect:${name}`;

/** Remembers where something is on screen, for its stand-in on the next page (see Ghost). */
export function rememberRect(name: string, el: Element | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  try {
    sessionStorage.setItem(key(name), JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
  } catch {}
}

/**
 * Invisible stand-in for something that was on the previous page. In a page change it pairs
 * with that thing by name, so the thing gets its own layer and leaves the way the css says
 * (the card slides aside, the call fades away) instead of vanishing on the first frame.
 * Needed because a lone exit animation doesn't fire in this react build, pairs always do.
 * Where it sits is where the leaving thing goes: the remembered spot of the real thing
 * (rememberRect), moved by `shift`, or the .ghost--* css when nothing is remembered.
 * shift "aside": out to the right on a wide screen, down off the screen on a phone
 */
export function Ghost({ name, kind, shift }: { name: string; kind: string; shift?: "aside" }) {
  const el = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    let r: { x: number; y: number; w: number; h: number } | null = null;
    try {
      r = JSON.parse(sessionStorage.getItem(key(name)) ?? "null");
    } catch {}
    const node = el.current;
    if (!r || !node) return;
    let { x, y } = r;
    if (shift === "aside") {
      if (window.innerWidth > 760) x += 56;
      // 1px still on screen: react only pairs things it can see
      else y = window.innerHeight - 1;
    }
    Object.assign(node.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
      right: "auto",
      bottom: "auto",
    });
  }, [name, shift]);

  return (
    <ViewTransition name={name} share={kind} default="none">
      <span ref={el} className={`ghost ghost--${name}`} aria-hidden />
    </ViewTransition>
  );
}
