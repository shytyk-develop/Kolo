"use client";

import { useEffect, useState } from "react";

export interface CallStats {
  rttMs: number | null;
  inboundKbps: number | null;
  packetLossPct: number | null;
  resolution: string | null;
  fps: number | null;
  // host / srflx / relay: how the call goes
  candidateType: string | null;
}

const EMPTY: CallStats = {
  rttMs: null,
  inboundKbps: null,
  packetLossPct: null,
  resolution: null,
  fps: null,
  candidateType: null,
};

/** Reads getStats() every 2s. Counters only grow, so speed = difference of two reads. Pass null to stop. */
export function useStats(pc: RTCPeerConnection | null, intervalMs = 2000): CallStats {
  const [stats, setStats] = useState<CallStats>(EMPTY);

  useEffect(() => {
    if (!pc) {
      setStats(EMPTY);
      return;
    }
    // last bytes count, to get kbit/s
    let last: { bytes: number; at: number } | null = null;

    const timer = setInterval(async () => {
      if (pc.connectionState === "closed") return;
      const report = await pc.getStats();
      const next: CallStats = { ...EMPTY };
      let bytes = 0;
      let received = 0;
      let lost = 0;

      report.forEach((s) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
          if (s.currentRoundTripTime != null) next.rttMs = Math.round(s.currentRoundTripTime * 1000);
          const local = report.get(s.localCandidateId)?.candidateType;
          const remote = report.get(s.remoteCandidateId)?.candidateType;
          // turn on either side means the media goes through a relay
          next.candidateType = local === "relay" || remote === "relay" ? "relay" : (local ?? null);
        }
        if (s.type === "inbound-rtp") {
          bytes += s.bytesReceived ?? 0;
          received += s.packetsReceived ?? 0;
          lost += s.packetsLost ?? 0;
          if (s.kind === "video") {
            if (s.frameWidth) next.resolution = `${s.frameWidth}×${s.frameHeight}`;
            if (s.framesPerSecond != null) next.fps = Math.round(s.framesPerSecond);
          }
        }
      });

      const now = performance.now();
      // bits per ms = kbit/s
      if (last && now > last.at) next.inboundKbps = Math.round(((bytes - last.bytes) * 8) / (now - last.at));
      last = { bytes, at: now };
      if (received + lost > 0) next.packetLossPct = Math.round((lost / (received + lost)) * 1000) / 10;
      setStats(next);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [pc, intervalMs]);

  return stats;
}
