import { dbg, dbgOnce } from "./debug";
import type { ClientMessage } from "./types";

/**
 * Connection to ONE other person, "perfect negotiation" (W3C / MDN).
 * Both sides run the same code. If both send an offer at once,
 * the polite side gives way and the impolite one ignores the other offer.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly remoteId: string,
    private polite: boolean,
    iceServers: RTCIceServer[],
    private send: (message: ClientMessage) => void,
    onTrack: (stream: MediaStream) => void,
    onState: (state: RTCPeerConnectionState) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onnegotiationneeded = async () => {
      dbg("pc: negotiationneeded", { signaling: this.pc.signalingState });
      try {
        this.makingOffer = true;
        // no args: the browser makes the offer itself
        await this.pc.setLocalDescription();
        const local = this.pc.localDescription!;
        dbg("pc: sending (negotiationneeded)", { type: local.type });
        // the real type: if a remote offer got in first this is an answer, sending it as an
        // "offer" broke the other side's negotiation
        this.send({ type: local.type as "offer" | "answer", to: remoteId, sdp: local.sdp });
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        dbgOnce("pc: first local candidate", { type: candidate.type, protocol: candidate.protocol });
        this.send({ type: "ice", to: remoteId, candidate: candidate.toJSON() });
      } else dbg("pc: gathering done");
    };
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      dbg("pc: ice", { state });
      clearTimeout(this.restartTimer);
      // "disconnected" often heals by itself in a second or two; still down after a few: the
      // path is gone (wifi <-> mobile), look for a new one now instead of waiting ~30 s for "failed"
      if (state === "disconnected") this.restartTimer = setTimeout(() => this.restart("still disconnected"), 3000);
    };
    this.pc.onsignalingstatechange = () => dbg("pc: signaling", { state: this.pc.signalingState });

    this.pc.ontrack = ({ track, streams }) => {
      dbg("pc: track", { kind: track.kind });
      onTrack(streams[0] ?? new MediaStream([track]));
    };

    this.pc.onconnectionstatechange = () => {
      dbg("pc: connection", { state: this.pc.connectionState });
      onState(this.pc.connectionState);
      // network changed (wifi -> mobile), look for a new path
      if (this.pc.connectionState === "failed") this.restart("failed");
    };
  }

  /** Media is flowing (or about to): worth keeping through a signaling reconnect. */
  get alive(): boolean {
    const ice = this.pc.iceConnectionState;
    return this.pc.connectionState === "connected" || ice === "connected" || ice === "completed";
  }

  private restart(why: string): void {
    if (this.pc.signalingState === "closed") return;
    dbg("pc: ice restart", { why });
    this.pc.restartIce();
  }

  addLocalStream(stream: MediaStream): void {
    stream.getTracks().forEach((track) => this.pc.addTrack(track, stream));
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    // receiver.track always has a kind, even if the sender sends nothing now
    const transceiver = this.pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
    // no new offer/answer, instant
    await transceiver?.sender.replaceTrack(track);
  }

  async handleDescription(type: "offer" | "answer", sdp: string): Promise<void> {
    // full mdn version: an answer we're still applying doesn't count as a collision
    const readyForOffer =
      !this.makingOffer && (this.pc.signalingState === "stable" || this.settingRemoteAnswer);
    const offerCollision = type === "offer" && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    this.settingRemoteAnswer = type === "answer";
    // polite side does an implicit rollback here
    await this.pc.setRemoteDescription({ type, sdp });
    this.settingRemoteAnswer = false;

    // only if we really hold their offer now: a negotiationneeded that ran in between may
    // have answered it already, a second setLocalDescription would make a stray offer
    if (type === "offer" && this.pc.signalingState === "have-remote-offer") {
      await this.pc.setLocalDescription();
      const local = this.pc.localDescription!;
      dbg("pc: sending (reply)", { type: local.type });
      this.send({ type: local.type as "offer" | "answer", to: this.remoteId, sdp: local.sdp });
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    try {
      if (candidate) await this.pc.addIceCandidate(candidate);
    } catch (err) {
      dbg("pc: candidate rejected", { ignored: this.ignoreOffer, signaling: this.pc.signalingState, error: String(err) });
      // candidates of an ignored offer fail, that's fine
      if (!this.ignoreOffer) console.warn("bad ICE candidate", err);
    }
  }

  close(): void {
    clearTimeout(this.restartTimer);
    this.pc.close();
  }
}
