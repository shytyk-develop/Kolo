"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type Ref } from "react";

import type { RemoteParticipant } from "@/hooks/useCall";
import { avatarStyle, formatDuration, initial } from "@/lib/format";

import { CamGlyph, CamOffIcon, DockIcon, HangUpIcon, PinIcon, SwapIcon, UserIcon } from "./Icons";
import { Island } from "./Island";
import { LevelBars, MicMeter } from "./LevelBars";
import type { LocalMedia } from "./MediaProvider";
import { Video } from "./Video";

interface Props {
  media: LocalMedia;
  selfName: string;
  remote: RemoteParticipant | null;
  connectedAt: number | null;
  // 0..4 signal bars from MOS, null = no numbers yet
  quality: number | null;
  statsOpen: boolean;
  onToggleStats: () => void;
  onSwap: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onHangUp: () => void;
  // the preview lives outside, as a floating tile: buttons go into a column
  undocked: boolean;
  // the preview was pulled out: where it was on screen, and the pointer that pulls it
  onDetach: (rect: DOMRect, pointerId: number, offsetX: number, offsetY: number) => void;
  // the floating tile is near: open up with an empty preview slot to drop it into
  receiving: boolean;
  ref?: Ref<CallIslandHandle>;
}

export interface CallIslandHandle {
  // where the preview sits once the island is fully open, in screen px
  previewSlot: () => { x: number; y: number; w: number; h: number } | null;
}

// sizes mirrored from the css, to keep it on screen while it opens
const openHeight = (vh: number, undocked: boolean) =>
  undocked ? Math.min(286, vh - 40) : vh <= 520 ? vh - 40 : Math.min(480, vh - 96);

const readPinned = () => {
  try {
    return localStorage.getItem("kolo:pin") === "1";
  } catch {
    return false;
  }
};

/** Right-edge island: my mic bars, opens into preview + controls on hover or tap. */
export function CallIsland({
  media,
  selfName,
  remote,
  connectedAt,
  quality,
  statsOpen,
  onToggleStats,
  onSwap,
  onToggleAudio,
  onToggleVideo,
  onHangUp,
  undocked,
  onDetach,
  receiving,
  ref: handle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [vh, setVh] = useState(900);
  const [vw, setVw] = useState(1440);
  const ref = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLDivElement>(null);
  const compact = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // a mouse button held down inside it: don't close mid-press
  const holding = useRef(false);
  // last mouse position, for decisions made on pointerup
  const mouse = useRef<{ x: number; y: number } | null>(null);
  // a drag just ended: the click that follows it is not a click
  const swallowClick = useRef(false);

  // pinned = stays open whatever the pointer does; receiving = a tile is about to drop in
  const shown = open || pinned || receiving;

  // the column layout (preview outside). Back to the wide one at once, a tile is dropping in.
  // To the column only once the content has faded out, so the buttons never jump in view
  const [col, setCol] = useState(undocked);
  if (!undocked && col) setCol(false);
  useEffect(() => {
    if (!undocked || col) return;
    // still open (pinned or hovered): switch now
    const id = setTimeout(() => setCol(true), shown ? 0 : 180);
    return () => clearTimeout(id);
  }, [undocked, col, shown]);
  // switched while you can see it (either way): the new layout fades in, the old one never jumps
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const firstCol = useRef(true);
  useLayoutEffect(() => {
    if (firstCol.current) {
      firstCol.current = false;
      return;
    }
    if (shownRef.current) {
      full.current?.animate([{ opacity: 0, scale: "0.97" }, { opacity: 1, scale: "1" }], {
        duration: 320,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      });
    }
  }, [col]);

  useEffect(() => {
    setPinned(readPinned());
    const onResize = () => {
      setVh(window.innerHeight);
      setVw(window.innerWidth);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const togglePin = () => {
    setPinned((p) => {
      try {
        localStorage.setItem("kolo:pin", p ? "0" : "1");
      } catch {}
      return !p;
    });
  };

  // the pointer is the truth: in = open, out = closed, this frame, no timers.
  // css springs retarget from wherever the island is, so in-out-in never jumps
  const set = (next: boolean) => {
    clearTimeout(timer.current);
    setOpen(next);
  };
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = (refocus: boolean) => {
    clearTimeout(timer.current);
    setOpen(false);
    // keyboard users land back on the island, not on <body>
    if (refocus && !pinned && ref.current?.contains(document.activeElement)) compact.current?.focus();
  };

  // it always sits in the middle of the right edge, open or closed
  const compactH = media.videoOn ? 92 : 124;
  const openH = openHeight(vh, col);
  const openW = col ? 84 : 296;

  // hover by geometry, not by enter/leave of a box that is busy growing and shrinking:
  // closed, the small island is the target; open, the final open shape is.
  // So the edge never flickers mid-animation, and the answer comes on the same mouse move.
  const geo = useRef({
    vw,
    compactH,
    openW,
    openH,
    cyClosed: 0,
    cyOpen: 0,
    open: false,
  });
  geo.current = {
    vw,
    compactH,
    openW,
    openH,
    cyClosed: vh / 2,
    cyOpen: vh / 2,
    open,
  };
  const overIsland = (x: number, py: number, asOpen = geo.current.open) => {
    const g = geo.current;
    // a few px of slack: easy to hit, and no chatter right on the line
    if (asOpen) return x >= g.vw - g.openW - 10 && Math.abs(py - g.cyOpen) <= g.openH / 2 + 10;
    return x >= g.vw - 44 - 6 && Math.abs(py - g.cyClosed) <= g.compactH / 2 + 6;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      mouse.current = { x: e.clientX, y: e.clientY };
      // busy hands: a held button, the island or the tile being dragged
      if (holding.current || drag.current?.active || document.documentElement.hasAttribute("data-pip-drag")) return;
      const over = overIsland(e.clientX, e.clientY);
      // on it: nothing pending may close it (the beat after a landing, a blur)
      if (over) clearTimeout(timer.current);
      if (over !== geo.current.open) {
        clearTimeout(timer.current);
        setOpen(over);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
    // reads everything through refs
  }, []);

  // the tile stopped coming in.
  // Taken away (you changed your mind): straight back to the small island, the open one never
  // turns into the button column on the way.
  // Landed: stay open while the pointer is on it; otherwise hold a beat so you see the preview
  // settle in, then tuck away. Any mouse move decides sooner
  const wasReceiving = useRef(receiving);
  useEffect(() => {
    const was = wasReceiving.current;
    wasReceiving.current = receiving;
    if (receiving || !was) return;
    if (undocked) {
      set(false);
      return;
    }
    const m = mouse.current;
    // it is drawn open right now, so judge by the open shape
    if (m && overIsland(m.x, m.y, true)) set(true);
    else {
      setOpen(true);
      later(false, 650);
    }
    // overIsland, set and later read refs; undocked is this render's value
  }, [receiving]);

  // the preview slot of the open island, final position (not mid-animation)
  useImperativeHandle(handle, () => ({
    previewSlot: () => {
      const box = full.current;
      const pv = preview.current;
      if (!box || !pv) return null;
      let left = 0;
      let top = 0;
      for (let n: HTMLElement | null = pv; n && n !== box; n = n.offsetParent as HTMLElement | null) {
        left += n.offsetLeft;
        top += n.offsetTop;
      }
      const g = geo.current;
      return {
        x: g.vw - box.offsetWidth + left,
        y: g.cyOpen - box.offsetHeight / 2 + top,
        w: pv.offsetWidth,
        h: pv.offsetHeight,
      };
    },
  }));

  // the preview dragged out of it. Window listeners, so it keeps going whatever the pointer
  // passes over. The island itself stays put
  const drag = useRef<{ id: number; sx: number; sy: number; active: boolean } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.active || Math.hypot(dx, dy) < 6) return;
      d.active = true;
      swallowClick.current = true;
      const r = preview.current?.getBoundingClientRect();
      drag.current = null;
      if (r) {
        onDetachRef.current(r, e.pointerId, d.sx - r.left, d.sy - r.top);
        // the tile is out, the island tucks away behind it
        clearTimeout(timer.current);
        setOpen(false);
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (holding.current) {
        holding.current = false;
        const m = mouse.current;
        if (e.pointerType === "mouse" && m && !overIsland(m.x, m.y)) set(false);
      }
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      // the click (if any) fires right after pointerup
      setTimeout(() => (swallowClick.current = false), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // latest values for the window listeners
  const onDetachRef = useRef(onDetach);
  onDetachRef.current = onDetach;

  // touch: a tap anywhere else closes it. Esc too. Pinned ignores both.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
    // close() only touches refs and setters
  }, [open]);

  // the other person just got through: a small bounce while it's closed, so you notice
  const connected = remote?.state === "connected";
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && !wasConnected.current && !shown) {
      ref.current?.animate([{ scale: "1" }, { scale: "1.16" }, { scale: "1" }], {
        duration: 620,
        easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      });
    }
    wasConnected.current = connected;
  }, [connected, shown]);

  const remoteName = remote?.peer.name && remote.peer.name !== "…" ? remote.peer.name : "Guest";
  const remoteVideo = Boolean(remote?.stream && remote.video);

  return (
    <Island
      ref={ref}
      edge="right"
      className="ci"
      data-open={shown || undefined}
      data-tall={!media.videoOn || undefined}
      data-undocked={col || undefined}
      data-out={undocked || undefined}
      data-pinned={pinned || undefined}
      data-receiving={receiving || undefined}
      onPointerDown={(e) => {
        holding.current = true;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const t = e.target as HTMLElement;
        // the preview can be pulled out of the open island
        if (t.closest(".ci__preview") && !undocked && !col && shown) {
          drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, active: false };
        }
      }}
      onBlur={(e) => {
        // keyboard tabbed out. null = click on empty space, outside clicks are handled above
        const to = e.relatedTarget as Node | null;
        if (to && !ref.current?.contains(to)) later(false, 0);
      }}
      data-testid="call-island"
    >
      <button
        ref={compact}
        className="ci__compact"
        onClick={() => !swallowClick.current && set(true)}
        aria-label="Show call controls"
        aria-expanded={shown}
        tabIndex={shown ? -1 : 0}
      >
        <CamOffIcon size={18} className="ci__camoff" />
      </button>

      {/* my mic on the small island. Open, it goes away: the mic button is the meter there */}
      <LevelBars className="ci__eq" stream={media.stream} muted={!media.audioOn} hidden={shown} />

      <div ref={full} className="ci__full" inert={!shown}>
        <button
          className="ci__pin"
          onClick={togglePin}
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin, hide on leave" : "Pin open"}
          title={pinned ? "Unpin" : "Keep open"}
          data-testid="pin"
        >
          <PinIcon size={15} filled={pinned} />
        </button>

        <button
          ref={preview}
          className="ci__preview"
          onClick={() => !swallowClick.current && onSwap()}
          disabled={!remote}
          aria-label="Swap videos, drag out to float"
          aria-keyshortcuts="S"
          inert={col}
          data-testid="swap"
        >
          {/* empty slot while a tile is about to drop in */}
          <span className="ci__drop" aria-hidden>
            <DockIcon size={22} />
          </span>
          <span className="ci__slotfill">
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
          </span>
        </button>

        <div className="ci__info">
          <div className="ci__who">
            <span className="ci__name">{remote ? remoteName : "Waiting for a guest"}</span>
            <span className="ci__meta">
              <CallClock since={connectedAt} pending={Boolean(remote)} />
              {remote && (
                <button
                  className="ci__quality"
                  onClick={onToggleStats}
                  aria-label="Stats"
                  aria-pressed={statsOpen}
                  title="Connection quality, tap for stats"
                  data-testid="stats-toggle"
                >
                  <QualityBars bars={quality} />
                </button>
              )}
            </span>
          </div>
        </div>

        {/* column layout (preview floating outside): a little air between the pin and the buttons */}
        <div className="ci__colhead" aria-hidden />

        <div className="ci__actions">
          <button
            className="round round--lg"
            data-off={!media.audioOn || undefined}
            onClick={onToggleAudio}
            aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
            aria-keyshortcuts="M"
            data-testid="toggle-audio"
          >
            <MicMeter stream={media.stream} on={media.audioOn} active={shown} />
          </button>
          <button
            className="round round--lg"
            data-off={!media.videoOn || undefined}
            onClick={onToggleVideo}
            aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
            aria-keyshortcuts="V"
            data-testid="toggle-video"
          >
            <CamGlyph off={!media.videoOn} />
          </button>
          <button className="hangup" onClick={onHangUp} aria-label="Leave the call" data-testid="leave">
            <HangUpIcon size={24} />
          </button>
        </div>
      </div>
    </Island>
  );
}

// own component: it ticks every second, the rest of the island doesn't re-render
function CallClock({ since, pending }: { since: number | null; pending: boolean }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!since) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);

  return (
    <span className="ci__time">
      {since ? formatDuration(Date.now() - since) : pending ? "Connecting…" : "Share the link"}
    </span>
  );
}

// phone-style signal bars, filled by MOS
function QualityBars({ bars }: { bars: number | null }) {
  const tone = bars == null ? "none" : bars >= 3 ? "good" : bars === 2 ? "fair" : "poor";
  return (
    <span className="qbars" data-tone={tone} aria-hidden>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} data-on={bars != null && i <= bars ? "" : undefined} />
      ))}
    </span>
  );
}
