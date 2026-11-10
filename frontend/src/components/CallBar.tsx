"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

import type { RemoteParticipant } from "@/hooks/useCall";
import { avatarStyle, initial } from "@/lib/format";

import { CamGlyph, HangUpIcon, UnsplitIcon, UserIcon } from "./Icons";
import { Island } from "./Island";
import { MicMeter } from "./LevelBars";
import type { LocalMedia } from "./MediaProvider";
import { Video } from "./Video";

export interface CallBarHandle {
  // where the preview sits, in screen px: a tile flying back lands exactly there
  slot: () => { x: number; y: number; w: number; h: number } | null;
}

interface Props {
  media: LocalMedia;
  selfName: string;
  remote: RemoteParticipant | null;
  remoteName: string;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onHangUp: () => void;
  onSwap: () => void;
  // the preview pulled out with a finger: where it was, the pointer, the grab point in it
  onDetach: (rect: DOMRect, pointerId: number, offsetX: number, offsetY: number) => void;
  // the preview is out (a tile in your hand) / the tile is over the bar, about to come back
  out: boolean;
  receiving: boolean;
  // split view on: the preview slot turns into "one screen again"
  split: boolean;
  onUnsplit: () => void;
  // tucked away below the screen (tap on the video), for a clean picture
  hidden: boolean;
  ref?: Ref<CallBarHandle>;
}

/**
 * Phones: one row at the bottom instead of the side island. Mic, camera, hang up, and a
 * preview of the other video as big as a button: tap it to swap, pull it up to split.
 */
export function CallBar({
  media,
  selfName,
  remote,
  remoteName,
  onToggleAudio,
  onToggleVideo,
  onHangUp,
  onSwap,
  onDetach,
  out,
  receiving,
  split,
  onUnsplit,
  hidden,
  ref,
}: Props) {
  const slot = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; sx: number; sy: number } | null>(null);
  // a drag just ended: the click that follows it is not a tap
  const swallow = useRef(false);
  const cb = useRef({ onDetach });
  cb.current = { onDetach };

  useImperativeHandle(ref, () => ({
    slot: () => {
      const r = slot.current?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    },
  }));

  // a few px of movement on the preview = it's coming out with the finger
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      drag.current = null;
      swallow.current = true;
      const r = slot.current?.getBoundingClientRect();
      if (r) cb.current.onDetach(r, e.pointerId, d.sx - r.left, d.sy - r.top);
    };
    const onUp = (e: PointerEvent) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
      // the click (if any) comes right after pointerup
      setTimeout(() => (swallow.current = false), 0);
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

  const remoteVideo = Boolean(remote?.stream && remote.video);
  // only a real other person can be swapped with or split with
  const canPull = Boolean(remote) && !split;

  return (
    <Island edge="bottom" className="cbar" data-hidden={hidden || undefined} inert={hidden} data-testid="call-bar">
      <div className="cbar__row">
        <button
          className="round round--lg"
          data-off={!media.audioOn || undefined}
          onClick={onToggleAudio}
          aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
          data-testid="toggle-audio"
        >
          <MicMeter stream={media.stream} on={media.audioOn} />
        </button>
        <button
          className="round round--lg"
          data-off={!media.videoOn || undefined}
          onClick={onToggleVideo}
          aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
          data-testid="toggle-video"
        >
          <CamGlyph off={!media.videoOn} />
        </button>
        <button className="hangup cbar__hangup" onClick={onHangUp} aria-label="Leave the call" data-testid="leave">
          <HangUpIcon size={24} />
        </button>
        <button
          ref={slot}
          className="cbar__preview"
          data-out={out || undefined}
          data-receiving={receiving || undefined}
          data-split={split || undefined}
          disabled={!remote}
          onPointerDown={(e) => {
            if (canPull) drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY };
          }}
          onClick={() => {
            if (swallow.current) return;
            if (split) onUnsplit();
            else onSwap();
          }}
          aria-label={split ? "Back to one screen" : "Swap videos, pull up to split the screen"}
          data-testid="swap"
        >
          {/* the other video, like the island preview: the track slides with --pos */}
          <span className="cbar__fill">
            <span className="track track--preview">
              <span className="slide">
                <Video stream={remote?.stream ?? null} />
                <span className="nocam" data-on={!remoteVideo || undefined}>
                  <span className="avatar cbar__avatar" style={avatarStyle(remote ? remoteName : "")}>
                    {initial(remote ? remoteName : "") ?? <UserIcon size={16} />}
                  </span>
                </span>
              </span>
              <span className="slide slide--2">
                <Video stream={media.stream} mirror />
                <span className="nocam" data-on={!media.videoOn || undefined}>
                  <span className="avatar cbar__avatar" style={avatarStyle(selfName)}>
                    {initial(selfName) ?? <UserIcon size={16} />}
                  </span>
                </span>
              </span>
            </span>
          </span>
          <span className="cbar__unsplit" aria-hidden>
            <UnsplitIcon size={22} />
          </span>
        </button>
      </div>
    </Island>
  );
}
