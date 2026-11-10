"use client";

import { useEffect, useRef } from "react";

import { useStats } from "@/hooks/useStats";

interface Props {
  stream: MediaStream | null;
  name: string;
  // own sound is never played back, or there's echo
  muted?: boolean;
  mirror?: boolean;
  videoOn?: boolean;
  audioOn?: boolean;
  state?: RTCPeerConnectionState;
  pc?: RTCPeerConnection | null;
  showStats?: boolean;
  // safety code (ch11)
  safety?: string | null;
  testId?: string;
}

export function VideoTile({
  stream,
  name,
  muted,
  mirror,
  videoOn = true,
  audioOn = true,
  state,
  pc = null,
  showStats,
  safety,
  testId,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const stats = useStats(showStats ? pc : null);

  // srcObject can't be a jsx attribute, so set it through the ref
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className={`tile${mirror ? " mirror" : ""}`} data-testid={testId} data-state={state}>
      {/* playsInline: without it iphone safari opens the video fullscreen */}
      <video ref={ref} autoPlay playsInline muted={muted} />
      {(!stream || !videoOn) && <div className="avatar">{name.slice(0, 1).toUpperCase()}</div>}
      <span className="label">
        {name}
        {!audioOn && " · 🔇"}
        {state && state !== "connected" && ` · ${state}`}
        {safety && <span data-testid="safety"> · 🔒 {safety}</span>}
      </span>
      {showStats && pc && (
        <div className="stats">
          <div>RTT: {stats.rttMs ?? "—"} ms</div>
          <div>Inbound: {stats.inboundKbps ?? "—"} kbit/s</div>
          <div>Loss: {stats.packetLossPct ?? "—"} %</div>
          <div>
            Video: {stats.resolution ?? "—"} @ {stats.fps ?? "—"} fps
          </div>
          <div>Path: {stats.candidateType ?? "—"}</div>
        </div>
      )}
    </div>
  );
}
