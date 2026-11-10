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
      try {
        this.makingOffer = true;
        // no args: the browser makes the offer itself
        await this.pc.setLocalDescription();
        this.send({ type: "offer", to: remoteId, sdp: this.pc.localDescription!.sdp });
      } catch (err) {
        console.error("negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ type: "ice", to: remoteId, candidate: candidate.toJSON() });
    };

    this.pc.ontrack = ({ track, streams }) => {
      onTrack(streams[0] ?? new MediaStream([track]));
    };

    this.pc.onconnectionstatechange = () => {
      onState(this.pc.connectionState);
      // network changed (wifi -> mobile), look for a new path
      if (this.pc.connectionState === "failed") this.pc.restartIce();
    };
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

    if (type === "offer") {
      await this.pc.setLocalDescription();
      this.send({ type: "answer", to: this.remoteId, sdp: this.pc.localDescription!.sdp });
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    try {
      if (candidate) await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // candidates of an ignored offer fail, that's fine
      if (!this.ignoreOffer) console.warn("bad ICE candidate", err);
    }
  }

  close(): void {
    this.pc.close();
  }
}
