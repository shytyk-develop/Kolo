"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";

import type { RemoteParticipant } from "@/hooks/useCall";
import { avatarStyle, initial } from "@/lib/format";

import { DockIcon, SwapIcon, UserIcon } from "./Icons";
import type { LocalMedia } from "./MediaProvider";
import { Video } from "./Video";

export interface PipRect {
  x: number;
  y: number;
  w: number;
}

export type SplitSide = "a" | "b";
export type SplitOffer = { side: SplitSide | null } | null;

export interface GrabOptions {
  // started over the island: no docking until it left it once
  fromIsland?: boolean;
  // started from something of another size: grows / shrinks from this scale
  fromScale?: number;
  fromRadius?: number;
}

export interface PipHandle {
  // carry on a drag started elsewhere
  grab: (pointerId: number, from: PipRect, offsetX: number, offsetY: number, opts?: GrabOptions) => void;
  // fly into a slot, then call done
  flyTo: (to: { x: number; y: number; w: number; h: number }, done: () => void, radius?: number) => void;
}

// split: side by side on wide screens, stacked on tall ones
export const splitVertical = () => window.innerHeight > window.innerWidth;

// corner radius of the big videos, from the css
export const frameRadius = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--video-r")) || 0;

// split: push the tile into the left (top) edge and hold. Not in a corner, so parking there never splits
const SPLIT_PUSH = 48;
// finger at the very edge with the tile pressed in counts as a push
const SPLIT_EDGE = 18;
const SPLIT_PRESSED = 6;
const SPLIT_CORNER = 28;
const SPLIT_HOLD = 280;
// this close to the middle line no half is picked
const SPLIT_NEUTRAL = 60;
// halves on offer: only the pointer on the island means docking
const DOCK_REACH_X = 56;
const DOCK_REACH_Y = 56;

export const PIP_RATIO = 1.2;
const MIN_W = 140;
const MARGIN = 12;
const maxW = () => Math.min(520, window.innerWidth * 0.45, (window.innerHeight - MARGIN * 2) / PIP_RATIO);

// rubber band past the edges
const rubber = (v: number, min: number, max: number) =>
  v < min ? min - (min - v) * 0.35 : v > max ? max + (v - max) * 0.35 : v;

/** Keeps the tile on screen and within size limits. */
export function clampPip(r: PipRect): PipRect {
  const w = Math.max(Math.min(r.w, maxW()), Math.min(MIN_W, maxW()));
  const h = w * PIP_RATIO;
  const x = Math.min(Math.max(r.x, MARGIN), window.innerWidth - w - MARGIN);
  const y = Math.min(Math.max(r.y, MARGIN), window.innerHeight - h - MARGIN);
  return { x, y, w };
}

interface Props {
  rect: PipRect | null;
  media: LocalMedia;
  selfName: string;
  remote: RemoteParticipant | null;
  remoteName: string;
  onChange: (r: PipRect) => void;
  // dropped on the island: parent opens the slot and calls flyTo
  onDockRequest: () => void;
  onSwap: () => void;
  dockTarget: () => DOMRect | null;
  onDockHover: (over: boolean) => void;
  canSplit: boolean;
  // side = the half under the pointer, null = nothing on offer
  onSplitHover: (offer: SplitOffer) => void;
  onSplitRequest: (side: SplitSide) => void;
  // phones: no free tile, it's either split or back in the bar
  phone: boolean;
  ref?: Ref<PipHandle>;
}

type Session =
  | { kind: "pending"; id: number; sx: number; sy: number; offX: number; offY: number }
  | { kind: "move"; id: number; offX: number; offY: number }
  | { kind: "resize"; id: number; sx: number; sy: number; start: PipRect; dirX: 1 | -1; dirY: 1 | -1 }
  | { kind: "pinch"; d0: number; start: PipRect };

/** Your preview pulled out of the island: drag, resize, tap to swap, drop on the island to dock. */
export function FloatingPreview({
  rect,
  media,
  selfName,
  remote,
  remoteName,
  onChange,
  onDockRequest,
  onSwap,
  dockTarget,
  onDockHover,
  canSplit,
  onSplitHover,
  onSplitRequest,
  phone,
  ref,
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const cur = useRef<PipRect>(rect ?? { x: 0, y: 0, w: 268 });
  const session = useRef<Session | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const overDock = useRef(false);
  // false right after leaving the island, it's still on top of it
  const dockArmed = useRef(true);
  const push = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offer = useRef<SplitOffer>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  // latest callbacks for the window listeners
  const cb = useRef({
    onChange,
    onDockRequest,
    onSwap,
    dockTarget,
    onDockHover,
    canSplit,
    onSplitHover,
    onSplitRequest,
    phone,
  });
  cb.current = { onChange, onDockRequest, onSwap, dockTarget, onDockHover, canSplit, onSplitHover, onSplitRequest, phone };

  // position lives in css vars, written directly while dragging
  const write = (r: PipRect) => {
    cur.current = r;
    const s = el.current?.style;
    if (!s) return;
    s.setProperty("--px", `${r.x}px`);
    s.setProperty("--py", `${r.y}px`);
    s.setProperty("--pw", `${r.w}px`);
  };

  const wasShown = useRef(false);
  useLayoutEffect(() => {
    const appeared = Boolean(rect) && !wasShown.current;
    wasShown.current = Boolean(rect);
    if (!rect) return;
    const node = el.current;
    if (node?.hasAttribute("data-flying")) {
      node.removeAttribute("data-flying");
      node.style.removeProperty("--ph");
      node.style.removeProperty("--pr");
    }
    if (session.current) return;
    write(rect);
    // shown without a hand on it: grows in on its spot
    if (appeared) {
      node?.querySelector(".pip__frame")?.animate([{ opacity: 0, scale: "0.86" }, { opacity: 1, scale: "1" }], {
        duration: 460,
        easing: "cubic-bezier(0.34, 1.25, 0.64, 1)",
      });
    }
  }, [rect]);

  const grabPoint = (x: number, y: number) => {
    el.current?.style.setProperty("--gx", `${x}px`);
    el.current?.style.setProperty("--gy", `${y}px`);
  };

  const setDragging = (on: boolean) => {
    if (!el.current) return;
    if (on) el.current.dataset.dragging = "";
    else delete el.current.dataset.dragging;
    // island ignores hover while dragging
    document.documentElement.toggleAttribute("data-pip-drag", on);
  };

  // tile touching the island = goes back in
  const checkDock = (px: number, py: number) => {
    const r = cb.current.dockTarget();
    const t = cur.current;
    const reach = 24;
    let over = false;
    if (r && cb.current.phone) {
      // phones: finger back on the bar
      over = px >= r.left - 24 && px <= r.right + 24 && py >= r.top - 28 && py <= r.bottom + 28;
    } else if (r && offer.current && !overDock.current) {
      over = px >= window.innerWidth - DOCK_REACH_X && Math.abs(py - (r.top + r.bottom) / 2) <= r.height / 2 + DOCK_REACH_Y;
    } else if (r) {
      over = t.x + t.w > r.left - reach && t.y + t.w * PIP_RATIO > r.top - reach && t.y < r.bottom + reach;
    }
    if (!dockArmed.current) {
      if (!over) dockArmed.current = true;
      over = false;
    }
    if (over !== overDock.current) {
      overDock.current = over;
      if (el.current) el.current.toggleAttribute("data-over-dock", over);
      cb.current.onDockHover(over);
    }
  };

  const setOffer = (next: SplitOffer) => {
    const was = offer.current;
    if (was === next || (was && next && was.side === next.side)) return;
    offer.current = next;
    el.current?.toggleAttribute("data-over-split", Boolean(next?.side));
    cb.current.onSplitHover(next);
  };
  const stopPush = () => {
    if (push.current) clearTimeout(push.current);
    push.current = null;
  };
  const resetSplit = () => {
    stopPush();
    setOffer(null);
  };

  // half under the pointer. Phones: no dead middle, a drop always picks the lit half
  const pickHalf = (px: number, py: number): SplitSide | null => {
    if (overDock.current) return null;
    const vert = splitVertical();
    const p = vert ? py : px;
    const mid = (vert ? window.innerHeight : window.innerWidth) / 2;
    const neutral = cb.current.phone ? 0 : SPLIT_NEUTRAL;
    return p < mid - neutral ? "a" : p >= mid + neutral ? "b" : null;
  };

  // raw = tile pos without rubber band; px, py = pointer
  const checkSplit = (rawX: number, rawY: number, px: number, py: number) => {
    // phones: halves on offer the whole drag
    if (cb.current.phone) return setOffer(cb.current.canSplit ? { side: pickHalf(px, py) } : null);
    if (!cb.current.canSplit || !dockArmed.current) return resetSplit();
    if (offer.current) return setOffer({ side: pickHalf(px, py) });
    if (overDock.current) return stopPush();
    const w = cur.current.w;
    const h = w * PIP_RATIO;
    const vert = splitVertical();
    // how far past the edge, and into a corner
    const depth = vert ? MARGIN - rawY : MARGIN - rawX;
    const across = vert
      ? Math.max(MARGIN - rawX, rawX + w - (window.innerWidth - MARGIN))
      : Math.max(MARGIN - rawY, rawY + h - (window.innerHeight - MARGIN));
    const atEdge = (vert ? py : px) <= SPLIT_EDGE;
    const pushed = depth >= SPLIT_PUSH || (atEdge && depth >= SPLIT_PRESSED);
    if (!pushed || across > SPLIT_CORNER) return stopPush();
    if (push.current) return;
    push.current = setTimeout(() => {
      push.current = null;
      const last = lastPointer.current;
      setOffer({ side: last ? pickHalf(last.x, last.y) : "a" });
    }, SPLIT_HOLD);
  };
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  const finish = () => {
    const was = session.current;
    session.current = null;
    setDragging(false);
    const side = offer.current?.side;
    const canSplit = cb.current.canSplit;
    resetSplit();
    if (was && (was.kind === "move" || was.kind === "resize" || was.kind === "pinch")) {
      if (was.kind === "move" && overDock.current) {
        overDock.current = false;
        el.current?.removeAttribute("data-over-dock");
        cb.current.onDockRequest();
        return;
      }
      if (was.kind === "move" && side && canSplit) {
        cb.current.onSplitRequest(side);
        return;
      }
      // phones: no free tile, back into the bar
      if (cb.current.phone) {
        overDock.current = false;
        el.current?.removeAttribute("data-over-dock");
        cb.current.onDockRequest();
        return;
      }
      const r = clampPip(cur.current);
      write(r);
      cb.current.onChange(r);
    }
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!s) return;
      if (s.kind === "pinch") {
        const [a, b] = [...touches.current.values()];
        if (!a || !b) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const w = Math.max(MIN_W * 0.8, Math.min(maxW() * 1.1, (s.start.w * d) / s.d0));
        const cx = s.start.x + s.start.w / 2;
        const cy = s.start.y + (s.start.w * PIP_RATIO) / 2;
        write({ x: cx - w / 2, y: cy - (w * PIP_RATIO) / 2, w });
        return;
      }
      if (e.pointerId !== s.id) return;
      if (s.kind === "pending") {
        if (Math.hypot(e.clientX - s.sx, e.clientY - s.sy) < 6) return;
        session.current = { kind: "move", id: s.id, offX: s.offX, offY: s.offY };
        grabPoint(s.offX, s.offY);
        setDragging(true);
      }
      const m = session.current;
      if (m?.kind === "move") {
        const w = cur.current.w;
        const rawX = e.clientX - m.offX;
        const rawY = e.clientY - m.offY;
        write({
          x: rubber(rawX, MARGIN, window.innerWidth - w - MARGIN),
          y: rubber(rawY, MARGIN, window.innerHeight - w * PIP_RATIO - MARGIN),
          w,
        });
        lastPointer.current = { x: e.clientX, y: e.clientY };
        checkDock(e.clientX, e.clientY);
        checkSplit(rawX, rawY, e.clientX, e.clientY);
      } else if (m?.kind === "resize") {
        // keep the ratio, opposite corner stays put
        const along = ((e.clientX - m.sx) * m.dirX + (e.clientY - m.sy) * m.dirY * PIP_RATIO) / (1 + PIP_RATIO * PIP_RATIO);
        const w = Math.max(MIN_W * 0.85, Math.min(maxW() * 1.08, m.start.w + along));
        const x = m.dirX < 0 ? m.start.x + m.start.w - w : m.start.x;
        const y = m.dirY < 0 ? m.start.y + (m.start.w - w) * PIP_RATIO : m.start.y;
        write({ x, y, w });
      }
    };
    const onUp = (e: PointerEvent) => {
      touches.current.delete(e.pointerId);
      const s = session.current;
      if (!s) return;
      if (s.kind === "pinch") {
        if (touches.current.size < 2) finish();
        return;
      }
      if (e.pointerId !== s.id) return;
      // no movement = tap = swap
      if (s.kind === "pending") {
        session.current = null;
        if (e.type === "pointerup") cb.current.onSwap();
        return;
      }
      finish();
    };
    // Esc: cancel the split offer
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (offer.current || push.current)) {
        e.stopPropagation();
        resetSplit();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      stopPush();
    };
    // reads everything through refs
  }, []);

  // they left mid-drag: drop the offer
  useEffect(() => {
    if (!canSplit) resetSplit();
    // resetSplit only touches refs
  }, [canSplit]);

  // wheel / pinch resize. Native listener: react's is passive
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!rectRef.current) return;
      e.preventDefault();
      const r = cur.current;
      const w = Math.max(MIN_W, Math.min(maxW(), r.w * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))));
      const h0 = r.w * PIP_RATIO;
      write({ x: r.x + (r.w - w) / 2, y: r.y + (h0 - w * PIP_RATIO) / 2, w });
      setDragging(true);
      clearTimeout(settle);
      settle = setTimeout(() => {
        setDragging(false);
        const c = clampPip(cur.current);
        write(c);
        cb.current.onChange(c);
      }, 140);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      clearTimeout(settle);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    grab: (pointerId, from, offX, offY, opts = {}) => {
      const node = el.current;
      write(from);
      grabPoint(offX, offY);
      node?.removeAttribute("data-flying");
      node?.style.removeProperty("--ph");
      node?.style.removeProperty("--pr");
      dockArmed.current = !opts.fromIsland;
      session.current = { kind: "move", id: pointerId, offX, offY };
      setDragging(true);
      lastPointer.current = { x: from.x + offX, y: from.y + offY };
      // phones: halves show up right away
      if (cb.current.phone && cb.current.canSplit) setOffer({ side: pickHalf(from.x + offX, from.y + offY) });
      // grows / shrinks from the size it came out of
      const frame = node?.querySelector<HTMLElement>(".pip__frame");
      if (frame && opts.fromScale && Math.abs(opts.fromScale - 1) > 0.01) {
        const s = opts.fromScale;
        const r = opts.fromRadius ?? frameRadius();
        frame.animate(
          [
            { scale: String(s), borderRadius: `${r / s}px`, boxShadow: "0 0 0 0 rgba(0, 0, 0, 0)" },
            { scale: "1.03", borderRadius: "22px" },
          ],
          { duration: 520, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        );
      }
    },
    flyTo: (to, done, radius = 24) => {
      const node = el.current;
      session.current = null;
      setDragging(false);
      resetSplit();
      if (!node) return done();
      node.setAttribute("data-flying", "");
      node.removeAttribute("data-over-dock");
      node.removeAttribute("data-over-split");
      node.style.setProperty("--ph", `${to.h}px`);
      node.style.setProperty("--pr", `${radius}px`);
      write({ x: to.x, y: to.y, w: to.w });
      let finished = false;
      const end = () => {
        if (finished) return;
        finished = true;
        node.removeEventListener("transitionend", onEnd);
        done();
      };
      const onEnd = (e: TransitionEvent) => e.target === node && e.propertyName === "transform" && end();
      node.addEventListener("transitionend", onEnd);
      // no transitionend if it was already there
      setTimeout(end, 520);
    },
  }));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        session.current = { kind: "pinch", d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), start: { ...cur.current } };
        setDragging(true);
        return;
      }
    }
    const r = cur.current;
    session.current = { kind: "pending", id: e.pointerId, sx: e.clientX, sy: e.clientY, offX: e.clientX - r.x, offY: e.clientY - r.y };
  };

  const startResize = (dirX: 1 | -1, dirY: 1 | -1) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    session.current = { kind: "resize", id: e.pointerId, sx: e.clientX, sy: e.clientY, start: { ...cur.current }, dirX, dirY };
    setDragging(true);
  };

  const remoteVideo = Boolean(remote?.stream && remote.video);

  return (
    <div
      ref={el}
      className="pip"
      data-shown={rect ? "" : undefined}
      data-phone={phone || undefined}
      inert={!rect}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={rect ? 0 : -1}
      aria-label="Your video, drag to move, tap to swap"
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSwap()}
      data-testid="pip"
    >
      <div className="pip__frame">
        <span className="track track--preview">
          <span className="slide">
            <Video stream={remote?.stream ?? null} />
            <span className="nocam" data-on={!remoteVideo || undefined}>
              <span className="avatar avatar--md" style={avatarStyle(remote ? remoteName : "")}>
                {initial(remote ? remoteName : "") ?? <UserIcon size={22} />}
              </span>
            </span>
            <span className="ci__label">{remote ? remoteName : "Waiting…"}</span>
          </span>
          <span className="slide slide--2">
            <Video stream={media.stream} mirror />
            <span className="nocam" data-on={!media.videoOn || undefined}>
              <span className="avatar avatar--md" style={avatarStyle(selfName)}>
                {initial(selfName) ?? <UserIcon size={22} />}
              </span>
            </span>
            <span className="ci__label">You</span>
          </span>
        </span>
        {remote && (
          <span className="ci__swap" aria-hidden>
            <SwapIcon size={16} strokeWidth={2} />
          </span>
        )}
        <button
          className="pip__dock"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDockRequest}
          aria-label="Put back into the island"
          title="Put back"
          data-testid="pip-dock"
        >
          <DockIcon size={16} />
        </button>
      </div>
      <span className="pip__grip pip__grip--nw" onPointerDown={startResize(-1, -1)} aria-hidden />
      <span className="pip__grip pip__grip--ne" onPointerDown={startResize(1, -1)} aria-hidden />
      <span className="pip__grip pip__grip--sw" onPointerDown={startResize(-1, 1)} aria-hidden />
      <span className="pip__grip pip__grip--se" onPointerDown={startResize(1, 1)} aria-hidden />
    </div>
  );
}
