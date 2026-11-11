"use client";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";

import { useCall } from "@/hooks/useCall";
import { callLog } from "@/lib/calls";
import { personOf, type Person } from "@/lib/people";
import { usePhone, usePortSide } from "@/hooks/usePhone";
import { type CallStats, useStats } from "@/hooks/useStats";
import { dbgOnce } from "@/lib/debug";
import { avatarStyle, formatDuration, initial } from "@/lib/format";
import { callQuality } from "@/lib/quality";
import { fingerprintFromSdp, safetyCode } from "@/lib/safety";
import type { Slot } from "@/lib/slot";
import type { JoinTicket } from "@/lib/types";

import { leaveHome, useCamera } from "./CameraLayer";
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
  // top island lives on the room page, the call says what goes in it
  notice: Slot<IslandItem | null>;
  // my video is on screen: the join screen can go
  onShown?: () => void;
}

interface Drag {
  id: number;
  x: number;
  y: number;
  from: number;
  width: number;
  active: boolean;
  p: number;
  // last moves, for flick speed
  samples: { x: number; t: number }[];
}

const SPLIT_GAP = 8;
// one stage move, same as the css
const STAGE_MS = 540;
// bar preview corners, same as the css
const BAR_RADIUS = 18;

type Who = "self" | "remote";

// half of the screen: a = left / top, b = right / bottom
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

export function CallView({ ticket, media, code, selfName, notice: noticeSlot, onShown }: Props) {
  const router = useRouter();
  // what the home screen says about this call afterwards: who, since when, when they left
  const talk = useRef<{ peer: Person | null; since: number | null; leftAt: number | null }>({ peer: null, since: null, leftAt: null });
  const goHomeRef = useRef<() => void>(() => {});
  // a real drop: home shows "Connection lost" (or just the way back) and tries to rejoin
  const call = useCall(ticket, media.stream, (kind) => {
    const t = talk.current;
    callLog.dropped(code, t.peer, t.since, kind === "lost");
    goHomeRef.current();
  });
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [focusSelf, setFocusSelf] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // tile pulled out (null = docked)
  const [pip, setPip] = useState<PipRect | null>(null);
  const [dockHover, setDockHover] = useState(false);
  // split: my half, null = off
  const [split, setSplit] = useState<SplitSide | null>(null);
  const [splitHover, setSplitHover] = useState<SplitOffer>(null);
  // big video hidden while the tile hands its picture over
  const [handoff, setHandoff] = useState<Who | null>(null);
  const lastPipW = useRef(268);
  const splitDrag = useRef<{ id: number; sx: number; sy: number } | null>(null);
  const pipHandle = useRef<PipHandle>(null);
  const islandHandle = useRef<CallIslandHandle>(null);
  const barHandle = useRef<CallBarHandle>(null);
  const phone = usePhone();
  const port = usePortSide();
  const root = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const slideEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // phones: tap on the video hides / shows the bar
  const [barHidden, setBarHidden] = useState(false);
  const tap = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const isHost = ticket.role === "host";

  const remotes = Object.values(call.remotes);
  // made for two: with more, the first connected one is shown
  const remote = remotes.find((r) => r.state === "connected") ?? remotes[0] ?? null;
  const hasRemote = Boolean(remote);
  const remoteName = remote?.peer.name && remote.peer.name !== "…" ? remote.peer.name : "Guest";

  // stats every 2s, the quality bars need them
  const stats = useStats(remote ? call.getPeerConnection(remote.peer.id) : null);
  const quality = callQuality(stats.rttMs, stats.packetLossPct);
  const safety = remote ? (codes[remote.peer.id] ?? null) : null;

  // 0 = the other big, 1 = me big
  const target = hasRemote && !focusSelf ? 0 : 1;
  const splitOn = split && hasRemote ? split : null;
  const tileWho: Who = target === 0 ? "self" : "remote";

  // slide position is a css var, drag writes it directly
  useLayoutEffect(() => {
    root.current?.style.setProperty("--pos", String(target));
  }, [target]);

  // my video is painted: the join screen can go
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
      // video fade-in, same as the css
      timer = setTimeout(() => onShownRef.current?.(), 200);
    };
    // first painted frame where supported
    if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(shown);
    else (v as HTMLVideoElement).addEventListener("loadeddata", shown, { once: true });
    return () => clearTimeout(timer);
  }, []);

  // debug: when the other picture is actually painted
  const remoteStream = remote?.stream ?? null;
  useEffect(() => {
    const v = root.current?.querySelector<HTMLVideoElement>('[data-testid="remote-tile"] video');
    if (!v || !remoteStream || typeof v.requestVideoFrameCallback !== "function") return;
    const id = v.requestVideoFrameCallback(() => dbgOnce("video: first remote frame"));
    return () => v.cancelVideoFrameCallback(id);
  }, [remoteStream]);

  // call timer starts on first connect
  const connected = remote?.state === "connected";
  useEffect(() => {
    if (connected) setConnectedAt((t) => t ?? Date.now());
    if (!hasRemote) setConnectedAt(null);
  }, [connected, hasRemote]);

  // the call for Recent: who they are (id + name from signaling), timed from the first connect
  const known = remote?.peer.name && remote.peer.name !== "…" ? remote.peer : null;
  const peerKey = known ? `${known.client_id ?? ""}|${known.name}` : "";
  useEffect(() => {
    const t = talk.current;
    if (connected) {
      t.since ??= Date.now();
      if (known) t.peer = personOf(known);
      t.leftAt = null;
      callLog.live(code, t.peer, t.since);
    } else if (!hasRemote && t.since && !t.leftAt) {
      t.leftAt = Date.now();
    }
    // peerKey stands for `known`
  }, [connected, hasRemote, peerKey, code]);

  // safety code from both dtls fingerprints
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

  // newcomers assume my mic / camera are on: tell them
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

  // stage animates only around split changes, not on resize. Set during render so it lands with the new halves
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

  // css transition starts from where the slide is, fast clicks just turn it around
  const swap = () => {
    if (!hasRemote) return;
    if (splitOn) {
      setSplit(otherSide(splitOn));
      return;
    }
    morphSwap();
  };

  // where the small one is now (tile, bar button, island preview), null = not on screen
  const swapSlot = (): HTMLElement | null => {
    const el = root.current;
    return (
      el?.querySelector<HTMLElement>(".pip[data-shown] .pip__frame") ??
      (phone ? el?.querySelector<HTMLElement>(".cbar__preview") : null) ??
      el?.querySelector<HTMLElement>(".ci[data-open]:not([data-undocked]) .ci__preview") ??
      null
    );
  };

  // swap: the small one grows out of its slot to the whole screen, the big one dims under it
  const swapRun = useRef<(() => void) | null>(null);
  const morphSwap = () => {
    // one already running: jump it to the end
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
    el.dataset.snap = "";
    el.dataset.swapping = "";
    flushSync(() => setFocusSelf((v) => !v));
    let grow: Animation;
    if (slot) {
      const r = slot.getBoundingClientRect();
      const sr = parseFloat(getComputedStyle(slot).borderTopLeftRadius) || 0;
      // whole screen scaled down to cover the slot: starts as the slot's picture
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
      // nothing to grow from: fade in
      grow = small.animate(
        [
          { opacity: 0, transform: "scale(1.02)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        {
          duration: 320,
          easing: "ease-out",
        },
      );
    }
    const settle = big.animate([{ opacity: 1 }, { opacity: 0.55 }], {
      duration: 560,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
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

  // M = mic, V = camera, S = swap, by key position (any layout)
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

  // restore the last layout, keep it on screen on resize
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kolo:layout") ?? "{}");
      // phones: no free tile
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
    // first run would overwrite the saved layout
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    try {
      localStorage.setItem("kolo:layout", JSON.stringify({ pip, split }));
    } catch {}
    if (pip) lastPipW.current = pip.w;
  }, [pip, split]);

  // became a phone with a tile out: back into the bar
  useEffect(() => {
    if (phone) setPip((p) => (p && !document.querySelector(".pip[data-dragging], .pip[data-flying]") ? null : p));
  }, [phone]);

  // pulled out of the island: the tile takes over the drag
  const detach = (r: DOMRect, pointerId: number, offX: number, offY: number) => {
    const from = { x: r.left, y: r.top, w: r.width };
    setPip(from);
    pipHandle.current?.grab(pointerId, from, offX, offY, { fromIsland: true });
  };

  // phones: pulled out of the bar button, grows into a tile around the finger
  const detachFromBar = (r: DOMRect, pointerId: number, offX: number, offY: number) => {
    const w = clampPip({ x: 0, y: 0, w: 0 }).w;
    const s = r.width / w;
    const from = { x: r.left + offX - offX / s, y: r.top + offY - offY / s, w };
    setPip(from);
    pipHandle.current?.grab(pointerId, from, offX / s, offY / s, { fromScale: s, fromRadius: BAR_RADIUS });
  };

  // dropped on a half: big video shrinks to the other half, tile flies in
  const splitIn = (side: SplitSide) => {
    setSplitHover(null);
    // they left mid-air: just a drop
    if (!hasRemote) return;
    const mySide = tileWho === "self" ? side : otherSide(side);
    const started = performance.now();
    setHandoff(tileWho);
    setSplit(mySide);
    const r = halfRect(side);
    pipHandle.current?.flyTo(
      r,
      // wait for the full stage move, or the picture shifts
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

  // a half pulled away in split: it becomes the tile
  const splitOut = (side: SplitSide, pointerId: number, x: number, y: number, sx: number, sy: number) => {
    if (!splitOn) return;
    const who: Who = side === splitOn ? "self" : "remote";
    const half = halfRect(side);
    const w = clampPip({ x: 0, y: 0, w: lastPipW.current }).w;
    const offX = ((sx - half.x) / half.w) * w;
    const offY = ((sy - half.y) / half.h) * w * PIP_RATIO;
    const from = { x: x - offX, y: y - offY, w };
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

  // back into the island: opens with an empty slot, the tile flies into it
  const dockIn = () => {
    const land = () => {
      setPip(null);
      setDockHover(false);
    };
    // phones: straight into the bar button
    if (phone) {
      const slot = barHandle.current?.slot();
      if (slot) pipHandle.current?.flyTo(slot, land, BAR_RADIUS);
      else land();
      return;
    }
    // open layout goes into the DOM now, so the slot can be measured right away
    flushSync(() => setDockHover(true));
    const slot = islandHandle.current?.previewSlot();
    if (slot) pipHandle.current?.flyTo(slot, land);
    else land();
  };

  // leaving: the call fades, the camera glides home on the same tap
  const cam = useCamera();
  const [leaving, setLeaving] = useState(false);
  const goHome = () => {
    const el = root.current;
    if (el) el.dataset.leaving = "";
    setLeaving(true);
    leaveHome(cam, router, selfBigRef.current ? "full" : "hidden");
  };
  goHomeRef.current = goHome;
  // real duration: until they left, or until now
  const hangUp = () => {
    const t = talk.current;
    callLog.ended(code, t.peer, t.since, t.leftAt ?? Date.now());
    goHome();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // no clipboard on http
    }
  };

  // swipe on the big video: flick or past half switches. In split a drag pulls a half out
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
      clearTimeout(slideEnd.current);
      el.dataset.dragging = "";
      el.dataset.sliding = "";
    }
    let p = d.from - dx / d.width;
    if (p < 0) p *= 0.25;
    else if (p > 1) p = 1 + (p - 1) * 0.25;
    d.p = p;
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 5) d.samples.shift();
    el.style.setProperty("--pos", p.toFixed(4));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    // short tap on a phone: hide / show the bar
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
    delete el.dataset.dragging;
    el.style.setProperty("--pos", String(next));
    setFocusSelf(next === 1);
    // settled: back to stacked, no move
    clearTimeout(slideEnd.current);
    slideEnd.current = setTimeout(() => {
      el.dataset.snap = "";
      delete el.dataset.sliding;
      requestAnimationFrame(() => requestAnimationFrame(() => delete el.dataset.snap));
    }, 560);
  };

  const notice = leaving
    ? null
    : callNotice({
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
        // phones: the top island shows the clock
        timer: phone && connected ? connectedAt : null,
      });

  // phone on its side: island goes to the camera's side. It's outside the call, so via <html>
  const islandSide = phone && port !== "bottom" ? (port === "right" ? "left" : "right") : null;
  useLayoutEffect(() => {
    const html = document.documentElement;
    if (islandSide) html.dataset.callIsland = islandSide;
    else delete html.dataset.callIsland;
    return () => {
      delete html.dataset.callIsland;
    };
  }, [islandSide]);

  // island shows what the call says right now, before paint
  useLayoutEffect(() => {
    noticeSlot.set(notice);
  });

  const remoteVideo = Boolean(remote?.stream && remote.video);
  // I'm the whole screen: my video can morph home on the way out
  const selfBig = !splitOn && target === 1 && !handoff;
  const selfBigRef = useRef(selfBig);
  selfBigRef.current = selfBig;

  const sideOf = (who: Who) => (splitOn ? (who === "self" ? splitOn : otherSide(splitOn)) : undefined);

  return (
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
        </div>
      </div>

      {remotes.map((r) => (
        <RemoteAudio key={r.peer.id} stream={r.stream} />
      ))}

      {/* split targets: the half under the tile lights up */}
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
          side={port}
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
  );
}

const dash = (v: number | string | null, unit = "") => (v == null ? "—" : `${v}${unit}`);

// getStats numbers in a corner, touches go through
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
  // mounted until the closing animation ends
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
  // call start when the island shows the clock, else null
  timer: number | null;
}

// top island text, most important first
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
  // phones: call clock
  if (n.timer) {
    return {
      key: "timer",
      node: (
        <span className="notice notice--timer" data-testid="call-timer">
          <i className="pulse" />
          <Elapsed since={n.timer} />
        </span>
      ),
    };
  }
  return null;
}

// time since connect, ticks on its own
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // on the call's second boundaries
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      id = setTimeout(tick, 1000 - ((Date.now() - since) % 1000));
    };
    id = setTimeout(tick, 1000 - ((Date.now() - since) % 1000));
    return () => clearTimeout(id);
  }, [since]);
  return <span className="notice__time">{formatDuration(now - since)}</span>;
}
