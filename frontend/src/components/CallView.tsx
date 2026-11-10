"use client";

import { useRouter } from "next/navigation";
import {
  addTransitionType,
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  ViewTransition,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";

import { useCall } from "@/hooks/useCall";
import { type CallStats, useStats } from "@/hooks/useStats";
import { avatarStyle, initial } from "@/lib/format";
import { callQuality } from "@/lib/quality";
import { fingerprintFromSdp, safetyCode } from "@/lib/safety";
import type { Slot } from "@/lib/slot";
import type { JoinTicket } from "@/lib/types";

import { usePhone } from "@/hooks/usePhone";

import { CallBar, type CallBarHandle } from "./CallBar";
import { CallIsland, type CallIslandHandle } from "./CallIsland";
import {
  clampPip,
  FloatingPreview,
  frameRadius,
  PIP_RATIO,
  type PipHandle,
  type PipRect,
  type SplitOffer,
  type SplitSide,
  splitVertical,
} from "./FloatingPreview";
import { CheckIcon, CopyIcon, SplitIcon, UserIcon } from "./Icons";
import type { LocalMedia } from "./MediaProvider";
import type { IslandItem } from "./MorphIsland";
import { RemoteAudio, Video } from "./Video";

interface Props {
  ticket: JoinTicket;
  media: LocalMedia;
  code: string;
  selfName: string;
  // the top island lives on the room page (it was there on the join screen), the call says what goes in it
  notice: Slot<IslandItem | null>;
  // my own video is on screen: whatever covered it (the join screen) can go
  onShown?: () => void;
  // the camera's page-change name is free (the join screen that had it is gone)
  cameraName?: boolean;
}

interface Drag {
  id: number;
  x: number;
  y: number;
  from: number;
  width: number;
  active: boolean;
  p: number;
  // last moves, for the flick speed
  samples: { x: number; t: number }[];
}

// space between the two halves of split view
const SPLIT_GAP = 8;
// one stage move (track and halves share it), from the css
const STAGE_MS = 540;
// corners of the phone bar's preview button, from the css
const BAR_RADIUS = 18;

type Who = "self" | "remote";

// a half of the screen in px: a = left (or top on a tall screen), b = right (bottom)
function halfRect(side: SplitSide) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (splitVertical()) {
    const h = (vh - SPLIT_GAP) / 2;
    return { x: 0, y: side === "a" ? 0 : vh - h, w: vw, h };
  }
  const w = (vw - SPLIT_GAP) / 2;
  return { x: side === "a" ? 0 : vw - w, y: 0, w, h: vh };
}

const otherSide = (s: SplitSide): SplitSide => (s === "a" ? "b" : "a");

export function CallView({ ticket, media, code, selfName, notice: noticeSlot, onShown, cameraName = true }: Props) {
  const router = useRouter();
  const call = useCall(ticket, media.stream);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [focusSelf, setFocusSelf] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // preview pulled out of the island (null = docked), remembered
  const [pip, setPip] = useState<PipRect | null>(null);
  const [dockHover, setDockHover] = useState(false);
  // split view: which half I'm on, null = off. Remembered with the layout
  const [split, setSplit] = useState<SplitSide | null>(null);
  // split target on offer while the tile is pushed into an edge
  const [splitHover, setSplitHover] = useState<SplitOffer>(null);
  // a big video hidden for a moment: the tile is over it, handing over the picture
  const [handoff, setHandoff] = useState<Who | null>(null);
  const lastPipW = useRef(268);
  const splitDrag = useRef<{ id: number; sx: number; sy: number } | null>(null);
  const pipHandle = useRef<PipHandle>(null);
  const islandHandle = useRef<CallIslandHandle>(null);
  const barHandle = useRef<CallBarHandle>(null);
  // phones: a bottom bar instead of the side island, the tile only lives in your hand
  const phone = usePhone();
  const root = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const slideEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // phones: a tap on the video (not on a control) hides the bar for a clean screen, again shows it
  const [barHidden, setBarHidden] = useState(false);
  const tap = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const isHost = ticket.role === "host";

  const remotes = Object.values(call.remotes);
  // made for two, with more people the first connected one is on screen
  const remote = remotes.find((r) => r.state === "connected") ?? remotes[0] ?? null;
  const hasRemote = Boolean(remote);
  const remoteName = remote?.peer.name && remote.peer.name !== "…" ? remote.peer.name : "Guest";

  // always on, the quality bars need it; every 2s, cheap
  const stats = useStats(remote ? call.getPeerConnection(remote.peer.id) : null);
  const quality = callQuality(stats.rttMs, stats.packetLossPct);
  const safety = remote ? (codes[remote.peer.id] ?? null) : null;

  // 0 = the other person big, 1 = me big. Nobody here yet = me.
  const target = hasRemote && !focusSelf ? 0 : 1;
  // split needs two people
  const splitOn = split && hasRemote ? split : null;
  // the small one (island preview / floating tile) is whoever isn't big
  const tileWho: Who = target === 0 ? "self" : "remote";

  // the slide position is a css variable, drag writes it directly, so it's set here too
  useLayoutEffect(() => {
    root.current?.style.setProperty("--pos", String(target));
  }, [target]);

  // my video in the call is painted and faded in: the join screen over it can go
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    const v = root.current?.querySelector<HTMLVideoElement>('[data-testid="local-tile"] video');
    if (!v) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const shown = () => {
      if (done) return;
      done = true;
      // the video's own fade-in, from the css
      timer = setTimeout(() => onShownRef.current?.(), 200);
    };
    // first painted frame where supported, first decoded one otherwise
    if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(shown);
    else (v as HTMLVideoElement).addEventListener("loadeddata", shown, { once: true });
    return () => clearTimeout(timer);
  }, []);

  // call timer starts on the first connect
  const connected = remote?.state === "connected";
  useEffect(() => {
    if (connected) setConnectedAt((t) => t ?? Date.now());
    if (!hasRemote) setConnectedAt(null);
  }, [connected, hasRemote]);

  // once connected, safety code from both dtls fingerprints
  useEffect(() => {
    Object.values(call.remotes).forEach(async (r) => {
      if (r.state !== "connected" || codes[r.peer.id]) return;
      const pc = call.getPeerConnection(r.peer.id);
      const mine = fingerprintFromSdp(pc?.localDescription?.sdp);
      const theirs = fingerprintFromSdp(pc?.remoteDescription?.sdp);
      if (mine && theirs) {
        const value = await safetyCode(mine, theirs);
        setCodes((prev) => ({ ...prev, [r.peer.id]: value }));
      }
    });
  }, [call.remotes, call, codes]);

  // newcomers think everyone's mic and camera are on, tell them if mine are off
  const peerIds = Object.keys(call.remotes).sort().join(",");
  const { send } = call;
  useEffect(() => {
    if (call.status === "in-call" && peerIds && !(media.audioOn && media.videoOn)) {
      send({ type: "media-state", audio: media.audioOn, video: media.videoOn });
    }
  }, [peerIds, call.status, send, media.audioOn, media.videoOn]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  const toggleAudio = () => {
    const audio = media.toggleAudio();
    call.send({ type: "media-state", audio, video: media.videoOn });
  };

  const toggleVideo = () => {
    const video = media.toggleVideo();
    call.send({ type: "media-state", audio: media.audioOn, video });
  };

  // the stage moves with one timing for the track and the halves; only around split changes,
  // so resizing the window never animates. Any split change, whatever caused it (a drop, a pull,
  // S, the other person leaving). Worked out during render, so the flag lands in the same commit
  // as the new halves: anything measuring the layout in between can't make them jump
  const [staging, setStaging] = useState<"move" | "swap" | null>(null);
  const [stagedSplit, setStagedSplit] = useState(splitOn);
  if (stagedSplit !== splitOn) {
    setStagedSplit(splitOn);
    setStaging(stagedSplit && splitOn ? "swap" : "move");
  }
  useEffect(() => {
    if (!staging) return;
    const id = setTimeout(() => setStaging(null), STAGE_MS + 60);
    return () => clearTimeout(id);
  }, [staging, splitOn]);

  // css transition picks up from wherever the slide is now, so fast clicks just turn it around.
  // In split view it swaps the halves
  const swap = () => {
    if (!hasRemote) return;
    if (splitOn) {
      setSplit(otherSide(splitOn));
      return;
    }
    morphSwap();
  };

  // where the small one is right now (the picture the swap grows out of and the big one lands
  // in): the floating tile, the phone bar's button, the open island's preview. null = it isn't
  // on screen (closed island), then the big one goes into the small island itself
  const swapSlot = (): HTMLElement | null => {
    const el = root.current;
    return (
      el?.querySelector<HTMLElement>(".pip[data-shown] .pip__frame") ??
      (phone ? el?.querySelector<HTMLElement>(".cbar__preview") : null) ??
      el?.querySelector<HTMLElement>(".ci[data-open]:not([data-undocked]) .ci__preview") ??
      null
    );
  };

  // swap by tap / click / S: the two trade places, live, nothing frozen. The small one grows out
  // of its slot (out from under the island / bar / tile) to the whole screen, the big one under it
  // eases back a little; the slot dims for a moment and comes back showing the old big one.
  // Both big videos are always on screen (stacked), so nothing has to be drawn from scratch
  // mid-move. A swipe on the video is still a slide, it follows the finger
  const swapRun = useRef<(() => void) | null>(null);
  const morphSwap = () => {
    // one already running: jump it to its end, start from there
    swapRun.current?.();
    const el = root.current;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const remoteEl = el?.querySelector<HTMLElement>('[data-testid="remote-tile"]');
    const localEl = el?.querySelector<HTMLElement>('[data-testid="local-tile"]');
    if (!el || still || !remoteEl || !localEl) {
      setFocusSelf((v) => !v);
      return;
    }
    const big = target === 0 ? remoteEl : localEl;
    const small = target === 0 ? localEl : remoteEl;
    const slot = swapSlot();
    const W = el.clientWidth;
    const H = el.clientHeight;
    const R = frameRadius();
    // the new state right away: the small one is on top now, the slot holds the old big one
    // (dimmed for the moment, see data-swapping)
    el.dataset.snap = "";
    el.dataset.swapping = "";
    flushSync(() => setFocusSelf((v) => !v));
    let grow: Animation;
    if (slot) {
      const r = slot.getBoundingClientRect();
      const sr = parseFloat(getComputedStyle(slot).borderTopLeftRadius) || 0;
      // the whole screen, scaled down so it covers the slot, centered on it, and clipped to it:
      // exactly the slot's picture at the start
      const k = Math.max(r.width / W, r.height / H);
      const tx = r.left + r.width / 2 - (W * k) / 2;
      const ty = r.top + r.height / 2 - (H * k) / 2;
      const x1 = (r.left - tx) / k;
      const y1 = (r.top - ty) / k;
      const x2 = (r.right - tx) / k;
      const y2 = (r.bottom - ty) / k;
      small.style.transformOrigin = "0 0";
      grow = small.animate(
        [
          {
            transform: `translate(${tx}px, ${ty}px) scale(${k})`,
            clipPath: `inset(${y1}px ${W - x2}px ${H - y2}px ${x1}px round ${sr / k}px)`,
          },
          { transform: "translate(0px, 0px) scale(1)", clipPath: `inset(0px 0px 0px 0px round ${R}px)` },
        ],
        { duration: 560, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      );
    } else {
      // nothing on screen to grow from (closed island): it fades in over the old one
      grow = small.animate([{ opacity: 0, transform: "scale(1.02)" }, { opacity: 1, transform: "scale(1)" }], {
        duration: 320,
        easing: "ease-out",
      });
    }
    // the old one sinks into the shade under it (dims, never moves: no edge ever shows)
    const settle = big.animate([{ opacity: 1 }, { opacity: 0.55 }], {
      duration: 560,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
    // the slot comes back with its new picture while the big one is still settling
    const back = setTimeout(() => {
      el.dataset.swapBack = "";
      delete el.dataset.swapping;
    }, 200);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      swapRun.current = null;
      clearTimeout(back);
      grow.cancel();
      settle.cancel();
      small.style.transformOrigin = "";
      delete el.dataset.swapping;
      setTimeout(() => delete el.dataset.swapBack, 260);
      requestAnimationFrame(() => delete el.dataset.snap);
    };
    swapRun.current = done;
    grow.finished.then(done, () => {});
  };

  // M = mic, V = camera, S = swap. By key position, so it works on any keyboard layout.
  const keys = useRef({ toggleAudio, toggleVideo, swap });
  keys.current = { toggleAudio, toggleVideo, swap };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      const action = { KeyM: keys.current.toggleAudio, KeyV: keys.current.toggleVideo, KeyS: keys.current.swap }[
        e.code
      ];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // restore where things were last time, keep them on screen when the window changes
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kolo:layout") ?? "{}");
      // phones have no free tile to come back to
      if (saved.pip && !window.matchMedia("(max-width: 640px), (max-height: 500px)").matches)
        setPip(clampPip(saved.pip));
      if (saved.split === "a" || saved.split === "b") setSplit(saved.split);
    } catch {}
    const onResize = () => setPip((p) => (p ? clampPip(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const firstSave = useRef(true);
  useEffect(() => {
    // the first run would overwrite the saved layout with the defaults
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    try {
      localStorage.setItem("kolo:layout", JSON.stringify({ pip, split }));
    } catch {}
    if (pip) lastPipW.current = pip.w;
  }, [pip, split]);

  // became a phone (window narrowed) with a tile out: it has nowhere to stay, back into the bar
  useEffect(() => {
    if (phone) setPip((p) => (p && !document.querySelector(".pip[data-dragging], .pip[data-flying]") ? null : p));
  }, [phone]);

  // pulled out of the island: the tile appears exactly where the preview was and takes the drag over
  const detach = (r: DOMRect, pointerId: number, offX: number, offY: number) => {
    const from = { x: r.left, y: r.top, w: r.width };
    setPip(from);
    pipHandle.current?.grab(pointerId, from, offX, offY, { fromIsland: true });
  };

  // phones: pulled out of the bar's button. It grows from the button into a tile around the
  // finger, the same spot of the picture stays under it
  const detachFromBar = (r: DOMRect, pointerId: number, offX: number, offY: number) => {
    const w = clampPip({ x: 0, y: 0, w: 0 }).w;
    const s = r.width / w;
    const from = { x: r.left + offX - offX / s, y: r.top + offY - offY / s, w };
    setPip(from);
    pipHandle.current?.grab(pointerId, from, offX / s, offY / s, { fromScale: s, fromRadius: BAR_RADIUS });
  };

  // the tile dropped on the split target: the big video shrinks to its half while the tile
  // flies into the other one, then the stage's own video takes over under it
  const splitIn = (side: SplitSide) => {
    setSplitHover(null);
    // the other one left while it was in the air: it's just a drop
    if (!hasRemote) return;
    const mySide = tileWho === "self" ? side : otherSide(side);
    const started = performance.now();
    setHandoff(tileWho);
    setSplit(mySide);
    const r = halfRect(side);
    pipHandle.current?.flyTo(
      r,
      // the stage needs its full move too, or the picture would shift at the handover
      () =>
        setTimeout(
          () => {
            setPip(null);
            setHandoff(null);
          },
          Math.max(0, STAGE_MS - (performance.now() - started)),
        ),
      frameRadius(),
    );
  };

  // a half pulled away in split view: it turns into the tile under the finger,
  // the other half grows back to the whole screen
  const splitOut = (side: SplitSide, pointerId: number, x: number, y: number, sx: number, sy: number) => {
    if (!splitOn) return;
    const who: Who = side === splitOn ? "self" : "remote";
    const half = halfRect(side);
    const w = clampPip({ x: 0, y: 0, w: lastPipW.current }).w;
    // same spot of the picture stays under the finger
    const offX = ((sx - half.x) / half.w) * w;
    const offY = ((sy - half.y) / half.h) * w * PIP_RATIO;
    const from = { x: x - offX, y: y - offY, w };
    // no slide inside the small tracks: the tile already shows the right person
    const el = root.current;
    if (el) {
      el.dataset.instant = "";
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.instant));
    }
    setHandoff(who);
    setTimeout(() => setHandoff((h) => (h === who ? null : h)), STAGE_MS);
    setFocusSelf(who === "remote");
    setSplit(null);
    setPip(from);
    pipHandle.current?.grab(pointerId, from, offX, offY, { fromScale: half.w / w });
  };

  // back into the island: it opens with an empty slot, the tile flies into exactly that spot,
  // then the real preview takes over under it
  const dockIn = () => {
    const land = () => {
      setPip(null);
      setDockHover(false);
    };
    // phones: the bar's button is always there, straight into it
    if (phone) {
      const slot = barHandle.current?.slot();
      if (slot) pipHandle.current?.flyTo(slot, land, BAR_RADIUS);
      else land();
      return;
    }
    // the open layout goes into the DOM now, so the slot can be measured in the same event
    // and the tile leaves on the very frame you let go
    flushSync(() => setDockHover(true));
    const slot = islandHandle.current?.previewSlot();
    if (slot) pipHandle.current?.flyTo(slot, land);
    else land();
  };

  // leaving: a navigation with a type, so the page change can play the "back home" version
  // of the camera morph (or a plain fade when the other person is the big one)
  const hangUp = () =>
    startTransition(() => {
      addTransitionType("to-home");
      router.push("/");
    });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // no clipboard on http, the code is on screen anyway
    }
  };

  // swipe on the big video: follows the finger, flick or past half switches.
  // In split view a drag on a half pulls it out instead
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    tap.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (!hasRemote || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (splitOn) {
      splitDrag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY };
      return;
    }
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: target,
      width: e.currentTarget.clientWidth + 16,
      active: false,
      p: target,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const tp = tap.current;
    if (tp && tp.id === e.pointerId && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) > 8) tap.current = null;
    const sd = splitDrag.current;
    if (sd && sd.id === e.pointerId) {
      if (Math.hypot(e.clientX - sd.sx, e.clientY - sd.sy) < 10) return;
      splitDrag.current = null;
      const mid = splitVertical() ? window.innerHeight / 2 : window.innerWidth / 2;
      const side: SplitSide = (splitVertical() ? sd.sy : sd.sx) < mid ? "a" : "b";
      splitOut(side, e.pointerId, e.clientX, e.clientY, sd.sx, sd.sy);
      return;
    }
    const d = drag.current;
    const el = root.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) drag.current = null;
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      // side by side for the swipe (the other one was under the big one, it's covered, so the
      // jump to its side is never seen)
      clearTimeout(slideEnd.current);
      el.dataset.dragging = "";
      el.dataset.sliding = "";
    }
    let p = d.from - dx / d.width;
    // rubber band past the ends
    if (p < 0) p *= 0.25;
    else if (p > 1) p = 1 + (p - 1) * 0.25;
    d.p = p;
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
    el.style.setProperty("--pos", p.toFixed(4));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    // a short touch that didn't move: on a phone it hides / shows the bar
    const tp = tap.current;
    tap.current = null;
    if (phone && e.type === "pointerup" && tp?.id === e.pointerId && e.timeStamp - tp.t < 400) {
      setBarHidden((h) => !h);
    }
    splitDrag.current = null;
    const d = drag.current;
    const el = root.current;
    drag.current = null;
    if (!d?.active || !el) return;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const speed = (last.x - first.x) / Math.max(1, last.t - first.t);
    let next = d.p > 0.5 ? 1 : 0;
    if (Math.abs(speed) > 0.35) next = speed < 0 ? 1 : 0;
    // same frame: transition back on and the new target, it animates from the finger
    delete el.dataset.dragging;
    el.style.setProperty("--pos", String(next));
    setFocusSelf(next === 1);
    // settled: back to resting on top of each other, without any move
    clearTimeout(slideEnd.current);
    slideEnd.current = setTimeout(() => {
      el.dataset.snap = "";
      delete el.dataset.sliding;
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.snap));
    }, 560);
  };

  const notice = callNotice({
    status: call.status,
    error: call.error,
    lobby: isHost ? call.lobby : [],
    remote: remote ? { name: remoteName, connected } : null,
    code,
    copied,
    onCopy: copyLink,
    onAdmit: (id) => call.send({ type: "admit", peer_id: id }),
    onDeny: (id) => call.send({ type: "deny", peer_id: id }),
    onHome: hangUp,
  });

  // every render: the island shows what the call says right now (same frame, before paint)
  useLayoutEffect(() => {
    noticeSlot.set(notice);
  });

  const remoteVideo = Boolean(remote?.stream && remote.video);
  // I'm the whole screen: my video can morph into the home screen's camera on the way out
  const selfBig = !splitOn && target === 1 && !handoff;

  const sideOf = (who: Who) => (splitOn ? (who === "self" ? splitOn : otherSide(splitOn)) : undefined);

  return (
    // leaving the call: the whole call screen is one layer that fades away over the home screen
    // (pairs with a stand-in there, see Ghost)
    <ViewTransition name="call-screen" share="call-away" default="none">
      <main
        ref={root}
        className="call"
        data-phone={phone || undefined}
        data-big={target === 0 ? "remote" : "self"}
        data-split={splitOn ?? undefined}
        data-staging={staging ?? undefined}
        data-testid="call"
      >
        <div
          className="call__stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div className="track track--main">
            <div
              className="slide"
              data-testid="remote-tile"
              data-state={remote?.state}
              data-side={sideOf("remote")}
              data-handoff={handoff === "remote" || undefined}
            >
              <Video stream={remote?.stream ?? null} fit={splitOn ? "cover" : "smart"} />
              <div className="nocam" data-on={!remoteVideo || undefined}>
                <span className="avatar avatar--xl" style={avatarStyle(remote ? remoteName : "")}>
                  {initial(remote ? remoteName : "") ?? <UserIcon size={40} />}
                </span>
              </div>
              <span className="slide__name">{remoteName}</span>
            </div>
            {/* the name stays put once it's free (renaming confuses react's bookkeeping); whether the
              camera morphs home is the share class: only when I'm the whole screen */}
            <ViewTransition
              name={cameraName ? "self-camera" : undefined}
              share={selfBig ? "camera-morph" : "none"}
              default="none"
            >
              <div
                className="slide slide--2"
                data-testid="local-tile"
                data-side={sideOf("self")}
                data-handoff={handoff === "self" || undefined}
              >
                <Video stream={media.stream} mirror fit={splitOn ? "cover" : "smart"} />
                <div className="nocam" data-on={!media.videoOn || undefined}>
                  <span className="avatar avatar--xl" style={avatarStyle(selfName)}>
                    {initial(selfName) ?? <UserIcon size={40} />}
                  </span>
                </div>
                <span className="slide__name">You</span>
              </div>
            </ViewTransition>
          </div>
        </div>

        {remotes.map((r) => (
          <RemoteAudio key={r.peer.id} stream={r.stream} />
        ))}

        {/* where the tile goes when dropped: half of the screen */}
        {/* split view on offer: both halves, the one under the tile lights up, that's where it goes */}
        {(["a", "b"] as const).map((side) => (
          <div
            key={side}
            className="splitzone"
            data-side={side}
            data-shown={splitHover ? "" : undefined}
            data-active={splitHover?.side === side || undefined}
            aria-hidden
          >
            <span className="splitzone__hint">
              <SplitIcon />
              Release here
            </span>
          </div>
        ))}

        <StatsPanel show={statsOpen && Boolean(remote)} stats={stats} quality={quality} safety={safety} />

        <FloatingPreview
          ref={pipHandle}
          rect={pip}
          media={media}
          selfName={selfName}
          remote={remote}
          remoteName={remoteName}
          onChange={setPip}
          onDockRequest={dockIn}
          onSwap={swap}
          dockTarget={() => root.current?.querySelector(phone ? ".cbar" : ".ci")?.getBoundingClientRect() ?? null}
          onDockHover={setDockHover}
          canSplit={hasRemote}
          onSplitHover={setSplitHover}
          onSplitRequest={splitIn}
          phone={phone}
        />

        {phone ? (
          <CallBar
            ref={barHandle}
            media={media}
            selfName={selfName}
            remote={remote}
            remoteName={remoteName}
            onToggleAudio={toggleAudio}
            onToggleVideo={toggleVideo}
            onHangUp={hangUp}
            onSwap={swap}
            onDetach={detachFromBar}
            out={Boolean(pip)}
            receiving={dockHover}
            split={Boolean(splitOn)}
            onUnsplit={() => setSplit(null)}
            hidden={barHidden}
          />
        ) : (
          <CallIsland
            ref={islandHandle}
            media={media}
            selfName={selfName}
            remote={remote}
            connectedAt={connectedAt}
            quality={quality.bars}
            statsOpen={statsOpen}
            onToggleStats={() => setStatsOpen((v) => !v)}
            onSwap={swap}
            onToggleAudio={toggleAudio}
            onToggleVideo={toggleVideo}
            onHangUp={hangUp}
            undocked={Boolean(splitOn) || (Boolean(pip) && !dockHover)}
            onDetach={detach}
            receiving={dockHover}
          />
        )}
      </main>
    </ViewTransition>
  );
}

const dash = (v: number | string | null, unit = "") => (v == null ? "—" : `${v}${unit}`);

// getStats numbers in a corner, over the video; doesn't catch touches, swipes go through
function StatsPanel({
  show,
  stats,
  quality,
  safety,
}: {
  show: boolean;
  stats: CallStats;
  quality: ReturnType<typeof callQuality>;
  safety: string | null;
}) {
  // stays mounted until the closing animation ends
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  if (!mounted) return null;

  return (
    <div
      className="stats"
      data-leaving={!show || undefined}
      onAnimationEnd={() => !show && setMounted(false)}
      data-testid="stats"
    >
      <div>
        <span className="stats__k">RTT:</span> {dash(stats.rttMs, " ms")}
      </div>
      <div>
        <span className="stats__k">Inbound:</span> {dash(stats.inboundKbps, " kbit/s")}
      </div>
      <div>
        <span className="stats__k">Loss:</span> {dash(stats.packetLossPct, " %")}
      </div>
      <div>
        <span className="stats__k">Video:</span> {dash(stats.resolution)} @ {dash(stats.fps)} fps
      </div>
      <div>
        <span className="stats__k">Path:</span> {dash(stats.candidateType)}
      </div>
      <div>
        <span className="stats__k">MOS:</span> {quality.mos == null ? "—" : quality.mos.toFixed(2)} (R{" "}
        {quality.r == null ? "—" : Math.round(quality.r)})
      </div>
      <div>
        <span className="stats__k">Safety code:</span> <span data-testid="safety">{safety ?? "—"}</span>
      </div>
    </div>
  );
}

interface NoticeInput {
  status: ReturnType<typeof useCall>["status"];
  error: string | null;
  lobby: { id: string; name: string }[];
  remote: { name: string; connected: boolean } | null;
  code: string;
  copied: boolean;
  onCopy: () => void;
  onAdmit: (id: string) => void;
  onDeny: (id: string) => void;
  onHome: () => void;
}

// what the top island says, most important first
function callNotice(n: NoticeInput): IslandItem | null {
  if (n.status === "denied") {
    return {
      key: "denied",
      tone: "danger",
      node: (
        <span className="notice" data-testid="denied">
          <span className="notice__text">The host didn&apos;t let you in</span>
          <button className="chip" onClick={n.onHome}>
            Home
          </button>
        </span>
      ),
    };
  }
  if (n.error) {
    return {
      key: `error:${n.error}`,
      tone: "danger",
      node: (
        <span className="pill-text" data-testid="call-error">
          {n.error}
        </span>
      ),
    };
  }
  if (n.status === "lobby") {
    return {
      key: "lobby",
      node: (
        <span className="notice" data-testid="lobby-wait">
          <i className="pulse" />
          <span className="notice__text">Waiting for the host to let you in</span>
        </span>
      ),
    };
  }
  const asking = n.lobby[0];
  if (asking) {
    return {
      key: `ask:${asking.id}`,
      node: (
        <span className="notice">
          <span className="avatar avatar--sm" style={avatarStyle(asking.name)}>
            {initial(asking.name) ?? "?"}
          </span>
          <span className="notice__text">
            <b>{asking.name}</b> wants to join
          </span>
          <button className="chip" onClick={() => n.onDeny(asking.id)} data-testid="deny">
            No
          </button>
          <button className="chip chip--light" onClick={() => n.onAdmit(asking.id)} data-testid="admit">
            Let in
          </button>
        </span>
      ),
    };
  }
  if (n.status === "reconnecting" || n.status === "connecting") {
    return {
      key: "reconnecting",
      node: (
        <span className="notice">
          <i className="pulse pulse--amber" />
          <span className="notice__text">{n.status === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        </span>
      ),
    };
  }
  if (!n.remote && n.status === "in-call") {
    return {
      key: n.copied ? "copied" : "waiting",
      node: n.copied ? (
        <span className="notice">
          <CheckIcon size={16} className="notice__ok" />
          <span className="notice__text">Link copied</span>
        </span>
      ) : (
        <button className="notice notice--btn" onClick={n.onCopy} aria-label="Copy invite link">
          <i className="pulse" />
          <span className="notice__text">Waiting for a guest</span>
          <span className="invite__sep" aria-hidden />
          <span className="invite__code">{n.code}</span>
          <CopyIcon size={15} className="notice__icon" />
        </button>
      ),
    };
  }
  if (n.remote && !n.remote.connected) {
    return {
      key: "peer-connecting",
      node: (
        <span className="notice">
          <i className="pulse pulse--amber" />
          <span className="notice__text">Connecting to {n.remote.name}…</span>
        </span>
      ),
    };
  }
  return null;
}
