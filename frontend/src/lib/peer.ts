import { dbg, dbgOnce } from "./debug";
import type { FrameCryptoOptions } from "./e2ee.worker";
import { preferOpusDtx, sessionIdOf } from "./sdp";
import type { ClientMessage } from "./types";

/** Frame encryption for one link: the shared worker and what it needs to make the keys. */
export interface LinkFrames {
  worker: Worker;
  mode: "script" | "streams";
  roomKey: string;
  roomCode: string;
  myId: string;
}

export interface LinkConfig {
  iceServers: RTCIceServer[];
  // only via TURN: the other side doesn't see my IP
  relayOnly: boolean;
  // fresh TURN logins before a restart, the old ones expire after minutes
  freshIceServers?: () => Promise<RTCIceServer[] | null>;
  frames: LinkFrames | null;
}

const VIDEO_MAX_BITRATE = 1_500_000;

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
  private encrypted = new WeakSet<object>();
  private remoteSession: string | null = null;

  constructor(
    readonly remoteId: string,
    private polite: boolean,
    private config: LinkConfig,
    private send: (message: ClientMessage) => void,
    onTrack: (stream: MediaStream) => void,
    onState: (state: RTCPeerConnectionState) => void,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.relayOnly ? "relay" : "all",
      // old Chrome: without it there is no createEncodedStreams
      ...(config.frames?.mode === "streams" ? { encodedInsertableStreams: true } : {}),
    } as RTCConfiguration);

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

    this.pc.ontrack = ({ track, streams, receiver }) => {
      dbg("pc: track", { kind: track.kind });
      // normally hooked up in addLocalStream already (Chrome doesn't accept it this late)
      this.encrypt(receiver, "receive", track.kind, remoteId);
      onTrack(streams[0] ?? new MediaStream([track]));
    };

    this.pc.onconnectionstatechange = () => {
      dbg("pc: connection", { state: this.pc.connectionState });
      onState(this.pc.connectionState);
      // network changed (wifi -> mobile), look for a new path
      if (this.pc.connectionState === "failed") void this.restart("failed");
      if (this.pc.connectionState === "connected") this.tune();
    };
  }

  /** Every frame of this sender / receiver goes through the worker. Once per object. */
  private encrypt(target: RTCRtpSender | RTCRtpReceiver, side: "send" | "receive", kind: string, senderId: string): void {
    const frames = this.config.frames;
    if (!frames || this.encrypted.has(target)) return;
    this.encrypted.add(target);
    const options: FrameCryptoOptions = {
      side,
      kind: kind === "audio" ? "audio" : "video",
      roomKey: frames.roomKey,
      roomCode: frames.roomCode,
      senderId,
    };
    if (frames.mode === "script") {
      const Transform = (window as unknown as { RTCRtpScriptTransform: new (w: Worker, o: unknown) => unknown }).RTCRtpScriptTransform;
      (target as unknown as { transform: unknown }).transform = new Transform(frames.worker, options);
    } else {
      const { readable, writable } = (
        target as unknown as { createEncodedStreams(): { readable: ReadableStream; writable: WritableStream } }
      ).createEncodedStreams();
      frames.worker.postMessage({ readable, writable, options }, [readable, writable] as unknown as Transferable[]);
    }
  }

  // encrypted frames work with VP8 only: its header stays readable, H264's doesn't
  private preferVp8(): void {
    if (!this.config.frames) return;
    for (const transceiver of this.pc.getTransceivers()) {
      const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track.kind;
      if (kind !== "video" || transceiver.currentDirection === "stopped") continue;
      const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
      const keep = codecs.filter((c) => !/\/(h264|h265|vp9|av1)$/i.test(c.mimeType));
      try {
        if (keep.some((c) => /\/vp8$/i.test(c.mimeType))) transceiver.setCodecPreferences(keep);
      } catch (err) {
        dbg("pc: codec preferences refused", { error: String(err) });
      }
    }
  }

  // audio first: video may get worse, audio must not
  private tune(): void {
    for (const sender of this.pc.getSenders()) {
      const kind = sender.track?.kind;
      if (!kind) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      if (kind === "audio") {
        params.encodings[0].priority = "high";
        params.encodings[0].networkPriority = "high";
      } else {
        params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
        // on low bandwidth, smaller beats choppy
        params.degradationPreference = "maintain-framerate";
      }
      sender.setParameters(params).catch((err) => dbg("pc: sender parameters refused", { kind, error: String(err) }));
    }
  }

  /** Media is flowing (or about to): worth keeping through a signaling reconnect. */
  get alive(): boolean {
    const ice = this.pc.iceConnectionState;
    return this.pc.connectionState === "connected" || ice === "connected" || ice === "completed";
  }

  private restarting = false;

  /** Look for a new path (the network changed). */
  async restart(why: string): Promise<void> {
    if (this.closed() || this.restarting) return;
    this.restarting = true;
    dbg("pc: ice restart", { why });
    try {
      const fresh = await this.config.freshIceServers?.();
      if (fresh && !this.closed()) this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: fresh });
    } catch (err) {
      dbg("pc: fresh ice servers failed", { error: String(err) });
    } finally {
      this.restarting = false;
    }
    if (!this.closed()) this.pc.restartIce();
  }

  private closed(): boolean {
    return this.pc.signalingState === "closed";
  }

  addLocalStream(stream: MediaStream, myId: string): void {
    stream.getTracks().forEach((track) => {
      const sender = this.pc.addTrack(track, stream);
      this.encrypt(sender, "send", track.kind, myId);
    });
    // the receivers exist from now on: hook them up right away, not at ontrack
    this.pc.getTransceivers().forEach((t) => this.encrypt(t.receiver, "receive", t.receiver.track.kind, this.remoteId));
    this.preferVp8();
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    // receiver.track always has a kind, even if the sender sends nothing now
    const transceiver = this.pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
    // no new offer/answer, instant
    await transceiver?.sender.replaceTrack(track);
  }

  /**
   * Their side started over with a brand new connection (a reload, a rejoin after a long drop)
   * while this one is still the old one: the two can't be patched together, this side must start over too.
   */
  isFromAnotherConnection(sdp: string): boolean {
    const theirs = sessionIdOf(sdp);
    return Boolean(this.remoteSession && theirs && theirs !== this.remoteSession);
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
    await this.pc.setRemoteDescription({ type, sdp: preferOpusDtx(sdp) });
    this.settingRemoteAnswer = false;
    this.remoteSession = sessionIdOf(sdp) ?? this.remoteSession;
    if (type === "offer") this.preferVp8();

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
