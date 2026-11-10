"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import type { RemoteParticipant } from "@/hooks/useCall";
import { formatDuration, initial } from "@/lib/format";

import { CamIcon, CamOffIcon, HangUpIcon, MicIcon, MicOffIcon, SwapIcon, UserIcon } from "./Icons";
import { Island } from "./Island";
import { LevelBars } from "./LevelBars";
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
}

/** Right-edge island: small level bars, opens into preview + controls on hover or tap. */
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
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // small delays: passing over doesn't open it, a short slip outside doesn't close it
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // touch: a tap anywhere else closes it. Esc too.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const remoteName = remote?.peer.name && remote.peer.name !== "…" ? remote.peer.name : "Guest";
  const remoteVideo = Boolean(remote?.stream && remote.video);

  return (
    <Island
      ref={ref}
      edge="right"
      className="ci"
      data-open={open || undefined}
      data-tall={!media.videoOn || undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && later(true, 50)}
      onPointerLeave={(e) => e.pointerType === "mouse" && later(false, 240)}
      onBlur={(e) => {
        // keyboard tabbed out. null = click on empty space, outside clicks are handled above
        const to = e.relatedTarget as Node | null;
        if (to && !ref.current?.contains(to)) later(false, 0);
      }}
      data-testid="call-island"
    >
      <button
        className="ci__compact"
        onClick={() => later(true, 0)}
        aria-label="Show call controls"
        aria-expanded={open}
        tabIndex={open ? -1 : 0}
      >
        <LevelBars streams={[media.stream, remote?.stream]} muted={!media.audioOn} />
        <CamOffIcon size={18} className="ci__camoff" />
      </button>

      <div className="ci__full" inert={!open}>
        <button
          className="ci__preview"
          onClick={onSwap}
          disabled={!remote}
          aria-label="Swap videos"
          data-testid="swap"
        >
          <span className="track track--preview">
            <span className="slide">
              <Video stream={remote?.stream ?? null} />
              <span className="nocam" data-on={!remoteVideo || undefined}>
                <span className="avatar avatar--md">{initial(remote ? remoteName : "") ?? <UserIcon size={22} />}</span>
              </span>
              <span className="ci__label">{remote ? remoteName : "Waiting…"}</span>
            </span>
            <span className="slide slide--2">
              <Video stream={media.stream} mirror />
              <span className="nocam" data-on={!media.videoOn || undefined}>
                <span className="avatar avatar--md">{initial(selfName) ?? <UserIcon size={22} />}</span>
              </span>
              <span className="ci__label">You</span>
            </span>
          </span>
          {remote && (
            <span className="ci__swap" aria-hidden>
              <SwapIcon size={16} strokeWidth={2} />
            </span>
          )}
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
          <LevelBars streams={[remote?.stream]} muted={Boolean(remote && !remote.audio)} />
        </div>

        <div className="ci__actions">
          <button
            className="round round--lg"
            data-off={!media.audioOn || undefined}
            onClick={onToggleAudio}
            aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
            data-testid="toggle-audio"
          >
            {media.audioOn ? <MicIcon /> : <MicOffIcon />}
          </button>
          <button
            className="round round--lg"
            data-off={!media.videoOn || undefined}
            onClick={onToggleVideo}
            aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
            data-testid="toggle-video"
          >
            {media.videoOn ? <CamIcon /> : <CamOffIcon />}
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
    <span className="ci__time">{since ? formatDuration(Date.now() - since) : pending ? "Connecting…" : "Share the link"}</span>
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
