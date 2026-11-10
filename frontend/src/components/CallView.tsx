"use client";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useCall } from "@/hooks/useCall";
import { type CallStats, useStats } from "@/hooks/useStats";
import { initial } from "@/lib/format";
import { callQuality } from "@/lib/quality";
import { fingerprintFromSdp, safetyCode } from "@/lib/safety";
import type { JoinTicket } from "@/lib/types";

import { CallIsland } from "./CallIsland";
import { CheckIcon, CopyIcon, UserIcon } from "./Icons";
import type { LocalMedia } from "./MediaProvider";
import { MorphIsland, type IslandItem } from "./MorphIsland";
import { RemoteAudio, Video } from "./Video";

interface Props {
  ticket: JoinTicket;
  media: LocalMedia;
  code: string;
  selfName: string;
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

export function CallView({ ticket, media, code, selfName }: Props) {
  const router = useRouter();
  const call = useCall(ticket, media.stream);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [focusSelf, setFocusSelf] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
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

  // the slide position is a css variable, drag writes it directly, so it's set here too
  useLayoutEffect(() => {
    root.current?.style.setProperty("--pos", String(target));
  }, [target]);

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

  // css transition picks up from wherever the slide is now, so fast clicks just turn it around
  const swap = () => {
    if (hasRemote) setFocusSelf((v) => !v);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // no clipboard on http, the code is on screen anyway
    }
  };

  // swipe on the big video: follows the finger, flick or past half switches
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasRemote || (e.pointerType === "mouse" && e.button !== 0)) return;
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
      el.dataset.dragging = "";
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

  const onPointerEnd = () => {
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
    onHome: () => router.push("/"),
  });

  const remoteVideo = Boolean(remote?.stream && remote.video);

  return (
    <main ref={root} className="call" data-testid="call">
      <div
        className="call__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div className="track track--main">
          <div className="slide" data-testid="remote-tile" data-state={remote?.state}>
            <Video stream={remote?.stream ?? null} />
            <div className="nocam" data-on={!remoteVideo || undefined}>
              <span className="avatar avatar--xl">{initial(remote ? remoteName : "") ?? <UserIcon size={40} />}</span>
            </div>
          </div>
          <div className="slide slide--2" data-testid="local-tile">
            <Video stream={media.stream} mirror />
            <div className="nocam" data-on={!media.videoOn || undefined}>
              <span className="avatar avatar--xl">{initial(selfName) ?? <UserIcon size={40} />}</span>
            </div>
          </div>
        </div>
      </div>

      {remotes.map((r) => (
        <RemoteAudio key={r.peer.id} stream={r.stream} />
      ))}

      {statsOpen && remote && <StatsPanel stats={stats} quality={quality} safety={safety} />}

      <MorphIsland item={notice} />

      <CallIsland
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
        onHangUp={() => router.push("/")}
      />
    </main>
  );
}

const dash = (v: number | string | null, unit = "") => (v == null ? "—" : `${v}${unit}`);

// getStats numbers in a corner, over the video; doesn't catch touches, swipes go through
function StatsPanel({
  stats,
  quality,
  safety,
}: {
  stats: CallStats;
  quality: ReturnType<typeof callQuality>;
  safety: string | null;
}) {
  return (
    <div className="stats" data-testid="stats">
      <div>RTT: {dash(stats.rttMs, " ms")}</div>
      <div>Inbound: {dash(stats.inboundKbps, " kbit/s")}</div>
      <div>Loss: {dash(stats.packetLossPct, " %")}</div>
      <div>
        Video: {dash(stats.resolution)} @ {dash(stats.fps)} fps
      </div>
      <div>Path: {dash(stats.candidateType)}</div>
      <div>
        MOS: {quality.mos == null ? "—" : quality.mos.toFixed(2)} (R {quality.r == null ? "—" : Math.round(quality.r)})
      </div>
      <div>
        Safety code: <span data-testid="safety">{safety ?? "—"}</span>
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
          <span className="avatar avatar--sm">{initial(asking.name) ?? "?"}</span>
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
