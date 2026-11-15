"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, wsUrl } from "@/lib/api";
import { dbg, dbgOnce } from "@/lib/debug";
import { open as openBox, seal, sealBinding } from "@/lib/e2ee";
import { type LinkFrames, PeerLink } from "@/lib/peer";
import { readKid, type RoomCrypto } from "@/lib/roomKeys";
import { SignalingClient } from "@/lib/signaling";
import type { ClientMessage, JoinTicket, Peer, ServerMessage } from "@/lib/types";

// e2ee: signaling and every frame encrypted with the room key
// signaling: only signaling (a browser that can't encrypt frames); the media is still DTLS between
//            the two browsers, and the key proves it's the right browser
// none: no shared room key (joined by code, an old link): plain WebRTC, compare the safety code
// blocked: I have the room's key and they don't: no connection until I say so (allowPlain)
export type LinkSecurity = "e2ee" | "signaling" | "none" | "blocked";

interface LinkMode {
  sealed: boolean;
  frames: boolean;
  blocked: boolean;
}

// "let in without a key" holds for this room as long as the tab lives
const plainOkKey = (code: string) => `kolo:plain:${code}`;
function plainAllowed(code: string): boolean {
  try {
    return sessionStorage.getItem(plainOkKey(code)) === "1";
  } catch {
    return false;
  }
}

export interface RemoteParticipant {
  peer: Peer;
  stream: MediaStream | null;
  state: RTCPeerConnectionState;
  audio: boolean;
  video: boolean;
  security: LinkSecurity;
}

export interface CallOptions {
  code: string;
  // null: this browser has no key for the room
  crypto: RoomCrypto | null;
  relayOnly: boolean;
}

// what travels inside a sealed box
type InnerBody =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "media-state"; audio: boolean; video: boolean };
// fx: the sender can encrypt frames; n: only ever grows, an old box played again is dropped
type Inner = InnerBody & { fx: boolean; n: number };

const hasTurn = (servers: RTCIceServer[]) =>
  servers.some((s) => [s.urls].flat().some((u) => /^turns?:/i.test(u)));

export interface ChatLine {
  from: string;
  name: string;
  text: string;
  ts: number;
}

export type CallStatus = "connecting" | "lobby" | "in-call" | "reconnecting" | "denied" | "ended" | "error";

// the picture still flows: get the signaling back in place, 1/2/4/8/8 s
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 8000];
// 1001 = going away, 1012 = server stopped/restarted: no point waiting here
const SERVER_GONE = new Set([1001, 1012]);
// a connection that worked and went "disconnected"/"failed" this long is a dropped call
const MEDIA_LOST_MS = 5000;
// an offer nobody answered: call again after this long, this many times
const UNANSWERED_MS = 12_000;
const UNANSWERED_RETRIES = 3;

// lost: the call dropped, home tries to bring it back ("Connection lost");
// home: tried here already and gave up, home just keeps the way back
export type DropKind = "lost" | "home";

const CLOSE_ERRORS: Record<number, string> = {
  4401: "The link has expired, join again",
  4403: "You can't join this meeting",
  4404: "This meeting doesn't exist",
  4409: "The room is full or you opened it in another tab",
  4410: "This meeting has ended",
};

/** Everything about the call: signaling, a connection per person, chat, lobby. */
export function useCall(
  ticket: JoinTicket | null,
  localStream: MediaStream | null,
  onDrop: (kind: DropKind) => void,
  { code, crypto, relayOnly }: CallOptions,
) {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [me, setMe] = useState<Peer | null>(null);
  const [remotes, setRemotes] = useState<Record<string, RemoteParticipant>>({});
  const [lobby, setLobby] = useState<Peer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const links = useRef(new Map<string, PeerLink>());
  const signaling = useRef<SignalingClient | null>(null);
  // media-state goes sealed to the ones with the key, plain to the rest
  const sendState = useRef<(m: { type: "media-state"; audio: boolean; video: boolean }) => void>(() => {});
  const allowPlainRef = useRef<() => void>(() => {});
  // for the message handler, which lives outside renders
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;

  const patchRemote = useCallback((id: string, patch: Partial<RemoteParticipant>) => {
    setRemotes((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  useEffect(() => {
    if (!ticket || !localStream) return;
    const myId = ticket.participant_id;
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // messages one by one: an ice candidate must not run before its offer is applied
    let inbox = Promise.resolve();
    // the call is leaving this page: our seat is kept for the comeback, not given up
    let handingOff = false;
    const connected = new Set<string>();
    // the signaling socket is up (welcome came, no close since)
    let wsUp = false;
    const mediaTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const alive = () => [...links.current.values()].some((l) => l.alive);
    // links my welcome just made: their "peer-joined" may still be on its way (we came in together)
    const fromWelcome = new Set<string>();

    // hiding the IP needs TURN: better not to connect than to show the IP
    if (relayOnly && !hasTurn(ticket.ice_servers)) {
      setStatus("error");
      setError("Can’t hide your IP: this server has no relay. Turn the setting off to call.");
      return;
    }

    // one worker for all connections of this call
    const worker =
      crypto?.frames && typeof Worker !== "undefined"
        ? new Worker(new URL("../lib/e2ee.worker.ts", import.meta.url), { type: "module" })
        : null;
    if (worker) {
      worker.onmessage = ({ data }) => dbg("e2ee: frames dropped", data);
      worker.onerror = (event) => console.error("e2ee worker failed", event.message);
    }
    const framesFor = (on: boolean): LinkFrames | null =>
      on && worker && crypto?.frames
        ? { worker, mode: crypto.frames, roomKey: crypto.roomKey, roomCode: crypto.roomCode, myId }
        : null;

    // how each link is protected, decided once when it's made (both sides decide the same way)
    const modes = new Map<string, LinkMode>();
    const securityOf = (mode: LinkMode): LinkSecurity =>
      mode.blocked ? "blocked" : mode.frames ? "e2ee" : mode.sealed ? "signaling" : "none";
    let plainOk = plainAllowed(code);
    // what people without the key sent, until I say yes
    const held = new Map<string, ServerMessage[]>();
    const modeFor = (peer: { id: string; kid?: string }): LinkMode => {
      const known = modes.get(peer.id);
      if (known) return known;
      const kid = readKid(crypto, peer.kid);
      // I have the key, they don't: a server could also be making them "forget" it.
      // So no connection for now
      const mode = { ...kid, blocked: Boolean(crypto) && !kid.sealed && !plainOk };
      modes.set(peer.id, mode);
      return mode;
    };

    // outgoing boxes one by one: sealing is async, the order must stay
    let outbox = Promise.resolve();
    let lastN = 0;
    const lastSeenN = new Map<string, number>();
    const sendSealed = (to: string | null, message: InnerBody) => {
      if (!crypto) return;
      outbox = outbox
        .then(async () => {
          lastN = Math.max(Date.now(), lastN + 1);
          const inner = { ...message, fx: Boolean(crypto.frames), n: lastN };
          const box = await seal(crypto.keys.signaling, sealBinding(code, myId, to), inner);
          signaling.current?.send(to ? { type: "sealed", to, box } : { type: "sealed", box });
        })
        .catch((err) => console.error("sealing failed", err));
    };

    const sendToPeer = (peerId: string, m: ClientMessage) => {
      if (m.type === "ice") dbgOnce("send: first ice");
      else dbg(`send: ${m.type}`);
      if (!modes.get(peerId)?.sealed) return signaling.current?.send(m);
      if (m.type === "offer" || m.type === "answer") sendSealed(peerId, { type: m.type, sdp: m.sdp });
      else if (m.type === "ice") sendSealed(peerId, { type: "ice", candidate: m.candidate });
    };

    allowPlainRef.current = () => {
      plainOk = true;
      try {
        sessionStorage.setItem(plainOkKey(code), "1");
      } catch {}
      for (const [id, mode] of modes) {
        if (!mode.blocked) continue;
        modes.set(id, { ...mode, blocked: false });
        patchRemote(id, { security: "none" });
        const waiting = held.get(id);
        held.delete(id);
        const peer = remotesRef.current[id]?.peer;
        // their offer is already waiting: answer it now. Otherwise I call
        if (waiting?.length) waiting.forEach((m) => (inbox = inbox.then(() => onMessage(m)).catch((err) => console.error("held message failed", err))));
        else if (peer) linkFor(peer);
      }
    };

    sendState.current = (m) => {
      const all = [...modes.entries()].filter(([id]) => links.current.has(id));
      if (all.some(([, mode]) => mode.sealed)) sendSealed(null, m);
      if (!all.length || all.some(([, mode]) => !mode.sealed)) signaling.current?.send(m);
    };

    // TURN logins last minutes only: get new ones before an ICE restart if the old ones are old
    let iceUntil = Date.now() + (ticket.ice_expires_in ?? 0) * 1000;
    let iceServers = ticket.ice_servers;
    const freshIceServers = async (): Promise<RTCIceServer[] | null> => {
      if (!hasTurn(iceServers) || Date.now() < iceUntil - 60_000) return null;
      const fresh = await api.freshIce(code, ticket.token);
      iceServers = fresh.ice_servers;
      iceUntil = Date.now() + fresh.expires_in * 1000;
      return iceServers;
    };

    const newRemote = (peer: Peer): RemoteParticipant => ({
      peer,
      stream: null,
      state: "new",
      audio: true,
      video: true,
      security: securityOf(modeFor(peer)),
    });

    // My offer can get lost (their socket was just dead). If nothing comes back for long:
    // call again from scratch, a few times at most
    const retries = new Map<string, number>();
    const unanswered = new Map<string, ReturnType<typeof setTimeout>>();
    const watchUnanswered = (peer: Peer, link: PeerLink) => {
      clearTimeout(unanswered.get(peer.id));
      unanswered.set(
        peer.id,
        setTimeout(() => {
          const tries = retries.get(peer.id) ?? 0;
          if (stopped || links.current.get(peer.id) !== link || link.pc.remoteDescription || !wsUp || tries >= UNANSWERED_RETRIES) return;
          dbg("link: no answer, calling again", { peer: peer.id, attempt: tries + 1 });
          const mode = modes.get(peer.id);
          dropPeer(peer.id);
          retries.set(peer.id, tries + 1);
          if (mode) modes.set(peer.id, mode);
          linkFor(peer);
        }, UNANSWERED_MS),
      );
    };

    const linkFor = (peer: Peer): PeerLink => {
      const existing = links.current.get(peer.id);
      if (existing) return existing;

      const mode = modeFor(peer);
      const link = new PeerLink(
        peer.id,
        // who is polite, both sides decide the same way
        myId < peer.id,
        { iceServers, relayOnly, freshIceServers, frames: framesFor(mode.frames) },
        (m) => sendToPeer(peer.id, m),
        (stream) => patchRemote(peer.id, { stream }),
        (state) => {
          patchRemote(peer.id, { state });
          watchMedia(peer.id, state);
        },
      );
      link.addLocalStream(localStream, myId);
      links.current.set(peer.id, link);
      watchUnanswered(peer, link);
      dbg("link: created", { peer: peer.id, security: securityOf(mode) });
      setRemotes((prev) => ({ ...prev, [peer.id]: prev[peer.id] ?? newRemote(peer) }));
      return link;
    };

    // wifi <-> mobile: don't wait for "failed", look for a new path right away
    const onNetworkChange = () => {
      dbg("network: changed");
      links.current.forEach((link) => void link.restart("network changed"));
    };
    window.addEventListener("online", onNetworkChange);
    const connection = (navigator as unknown as { connection?: EventTarget }).connection;
    connection?.addEventListener?.("change", onNetworkChange);

    // a connection that was up and stays down while my socket is down too: my call dropped.
    // With the socket up it's their side, the server tells us when they're gone
    const watchMedia = (id: string, state: RTCPeerConnectionState) => {
      clearTimeout(mediaTimers.get(id));
      mediaTimers.delete(id);
      if (state === "connected") connected.add(id);
      if (!connected.has(id) || (state !== "disconnected" && state !== "failed")) return;
      mediaTimers.set(
        id,
        setTimeout(() => {
          if (!stopped && !wsUp && links.current.has(id) && !alive()) drop("lost");
        }, MEDIA_LOST_MS),
      );
    };

    const drop = (kind: DropKind) => {
      if (stopped) return;
      dbg("call: dropped", { kind });
      stopped = true;
      handingOff = true;
      clearTimeout(retryTimer);
      setStatus("reconnecting");
      onDropRef.current(kind);
    };

    const dropPeer = (id: string) => {
      clearTimeout(unanswered.get(id));
      unanswered.delete(id);
      retries.delete(id);
      fromWelcome.delete(id);
      modes.delete(id);
      held.delete(id);
      clearTimeout(mediaTimers.get(id));
      mediaTimers.delete(id);
      connected.delete(id);
      if (links.current.has(id)) dbg("link: closed", { peer: id });
      links.current.get(id)?.close();
      links.current.delete(id);
      setRemotes((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
    };

    const dropAll = () => {
      modes.clear();
      if (links.current.size) dbg("link: closed all", { count: links.current.size });
      links.current.forEach((link) => link.close());
      links.current.clear();
      setRemotes({});
    };

    // a sealed box: only someone with the room key made it, and only for me (or for the room)
    const unseal = async (from: string, box: string): Promise<Inner | null> => {
      if (!crypto) return null;
      let inner: Inner | null = null;
      for (const to of [myId, null]) {
        try {
          inner = await openBox<Inner>(crypto.keys.signaling, sealBinding(code, from, to), box);
          break;
        } catch {}
      }
      if (!inner) {
        console.warn("signaling: a sealed message didn't open (wrong key or changed on the way), dropped");
        return null;
      }
      // seen already or older: someone is replaying old messages
      if (!(inner.n > (lastSeenN.get(from) ?? 0))) {
        console.warn("signaling: a replayed message, dropped");
        return null;
      }
      lastSeenN.set(from, inner.n);
      return inner;
    };

    const onMessage = async (msg: ServerMessage, sealed = false) => {
      if (msg.type === "ice") dbgOnce("recv: first ice");
      else if (msg.type !== "pong") dbg(`recv: ${msg.type}`, "from" in msg ? { from: msg.from } : undefined);

      if (msg.type === "sealed") {
        const inner = await unseal(msg.from, msg.box);
        if (!inner) return;
        // they proved they have the key, even if the server didn't show their kid
        const before = modes.get(msg.from);
        if (!before || before.blocked) {
          modes.set(msg.from, { sealed: true, frames: inner.fx && Boolean(crypto?.frames), blocked: false });
          patchRemote(msg.from, { security: inner.fx && crypto?.frames ? "e2ee" : "signaling" });
        }
        if (!modes.get(msg.from)?.sealed) return;
        const { fx: _fx, n: _n, ...rest } = inner;
        return onMessage({ ...rest, from: msg.from } as ServerMessage, true);
      }
      // agreed on a key but arrived unencrypted: that wasn't the other side.
      // And someone with no key gets through only after my ok
      if (!sealed && (msg.type === "offer" || msg.type === "answer" || msg.type === "ice" || msg.type === "media-state")) {
        const mode = modeFor(remotesRef.current[msg.from]?.peer ?? { id: msg.from });
        if (mode.sealed) {
          console.warn(`signaling: a plain "${msg.type}" where an encrypted one was due, dropped`);
          return;
        }
        if (mode.blocked) {
          const waiting = held.get(msg.from) ?? [];
          // a new offer replaces what came before it
          if (msg.type === "offer") waiting.length = 0;
          if (waiting.length < 64) waiting.push(msg);
          held.set(msg.from, waiting);
          return;
        }
      }

      switch (msg.type) {
        case "welcome": {
          attempt = 0;
          wsUp = true;
          setMe(msg.you);
          setStatus("in-call");
          setError(null);
          setLobby(msg.lobby ?? []);
          // after a reconnect: only the signaling dropped, the video may be fine. Keep every
          // connection that still works, redo only the dead ones (before: all were torn down,
          // the picture blinked out on every little drop). Not a "rejoined" (gone too long):
          // the others closed theirs already, start fresh
          if (!msg.rejoined) dropAll();
          const here = new Set(msg.peers.map((p) => p.id));
          [...links.current.keys()].forEach((id) => !here.has(id) && dropPeer(id));
          msg.peers.forEach((peer) => {
            const link = links.current.get(peer.id);
            if (link?.alive) return dbg("link: kept", { peer: peer.id });
            if (link) dropPeer(peer.id);
            // fresh from the server: what was guessed about them before no longer holds
            modes.delete(peer.id);
            const tile = newRemote(peer);
            remotesRef.current = { ...remotesRef.current, [peer.id]: tile };
            // no key on their side: just the tile, connecting only after my ok
            if (modeFor(peer).blocked) return setRemotes((prev) => ({ ...prev, [peer.id]: prev[peer.id] ?? tile }));
            // newcomer (or a dead link) calls the ones already in the room
            linkFor(peer);
            fromWelcome.add(peer.id);
          });
          break;
        }
        case "peer-joined": {
          // back after a drop with the call still running: nothing to redo
          const link = links.current.get(msg.peer.id);
          if (link && msg.rejoined && link.alive) {
            dbg("link: kept", { peer: msg.peer.id });
            break;
          }
          // we came in at the same moment: my welcome saw them and my offer is out, keep it.
          // If it really was a new session of theirs, their offer won't fit and gets a fresh link
          // (not after their comeback: then my offer went to their old, dead socket)
          if (link && !msg.rejoined && fromWelcome.delete(msg.peer.id)) {
            dbg("link: kept, joined together", { peer: msg.peer.id });
            break;
          }
          // they're back after a drop and my connection to them is dead: call again.
          // If they do the same, the two offers sort themselves out (perfect negotiation)
          if (link && msg.rejoined) {
            dbg("link: fresh after their comeback", { peer: msg.peer.id });
            dropPeer(msg.peer.id);
            const back = newRemote(msg.peer);
            remotesRef.current = { ...remotesRef.current, [msg.peer.id]: back };
            if (modeFor(msg.peer).blocked) setRemotes((prev) => ({ ...prev, [msg.peer.id]: back }));
            else linkFor(msg.peer);
            break;
          }
          // a new session of theirs means a new connection: theirs will come with an offer
          if (link) dropPeer(msg.peer.id);
          // the link is made when the newcomer's offer comes, just show the tile for now
          modes.delete(msg.peer.id);
          const tile = newRemote(msg.peer);
          setRemotes((prev) => ({ ...prev, [msg.peer.id]: prev[msg.peer.id] ?? tile }));
          // their offer may be handled before the next render
          remotesRef.current = { ...remotesRef.current, [msg.peer.id]: remotesRef.current[msg.peer.id] ?? tile };
          break;
        }
        case "peer-left":
          dropPeer(msg.peer_id);
          break;
        case "offer":
        case "answer": {
          const known = links.current.get(msg.from);
          const link = known ?? linkFor(remotesRef.current[msg.from]?.peer ?? { id: msg.from, name: "…", role: "guest" });
          try {
            // Chrome sometimes accepts such an offer and then no picture comes: better start over
            if (msg.type === "offer" && known?.isFromAnotherConnection(msg.sdp)) throw new Error("offer from a new connection");
            await link.handleDescription(msg.type, msg.sdp);
          } catch (err) {
            // an offer from their brand new connection doesn't fit our old one (other keys):
            // start a fresh one for it
            if (msg.type !== "offer" || !known) throw err;
            dbg("link: offer didn't fit, fresh link", { peer: msg.from, error: String(err) });
            const peer = remotesRef.current[msg.from]?.peer ?? { id: msg.from, name: "…", role: "guest" as const };
            const mode = modes.get(msg.from);
            dropPeer(msg.from);
            if (mode) modes.set(msg.from, mode);
            await linkFor(peer).handleDescription(msg.type, msg.sdp);
          }
          break;
        }
        case "ice":
          await links.current.get(msg.from)?.handleCandidate(msg.candidate);
          break;
        case "media-state":
          patchRemote(msg.from, { audio: msg.audio, video: msg.video });
          break;
        case "chat":
          setChat((prev) => [...prev.slice(-199), msg]);
          break;
        case "lobby":
          setStatus("lobby");
          break;
        case "lobby-request":
          setLobby((prev) => [...prev.filter((p) => p.id !== msg.peer.id), msg.peer]);
          break;
        case "lobby-left":
          setLobby((prev) => prev.filter((p) => p.id !== msg.peer_id));
          break;
        case "denied":
          setStatus("denied");
          break;
        case "error":
          dbg("recv: error", { code: msg.code, message: msg.message });
          setError(msg.message);
          break;
      }
    };

    const onClose = (code: number, reason: string) => {
      wsUp = false;
      if (stopped) return;
      console.info("signaling closed", code, reason);

      if (SERVER_GONE.has(code)) {
        drop("lost");
        return;
      }
      // 1000 = normal, 4xxx = server said no for good, retrying won't help
      if (code === 1000 || (code >= 4000 && code < 5000)) {
        setStatus((prev) => (prev === "denied" ? prev : code === 1000 ? "ended" : "error"));
        setError(CLOSE_ERRORS[code] ?? null);
        return;
      }
      // network drop and no picture either: home takes it from here ("Connection lost")
      if (!alive()) {
        drop("lost");
        return;
      }
      // the picture still flows: try the signaling here, quietly
      if (attempt >= RETRY_DELAYS.length) {
        drop("home");
        return;
      }
      setStatus("reconnecting");
      dbg("ws: retry", { attempt: attempt + 1, inMs: RETRY_DELAYS[attempt] });
      retryTimer = setTimeout(open, RETRY_DELAYS[attempt]);
      attempt += 1;
    };

    const open = () => {
      const client = new SignalingClient(
        wsUrl(ticket),
        (msg) => {
          inbox = inbox.then(() => onMessage(msg)).catch((err) => console.error("signaling message failed", err));
        },
        onClose,
        // an offer or candidates that couldn't go out while it was down
        signaling.current?.takeUnsent() ?? [],
      );
      signaling.current = client;
      client.connect();
    };

    // a tick later: strict mode's mount-unmount-mount in dev must not open two sockets
    retryTimer = setTimeout(open, 0);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      mediaTimers.forEach(clearTimeout);
      unanswered.forEach(clearTimeout);
      window.removeEventListener("online", onNetworkChange);
      connection?.removeEventListener?.("change", onNetworkChange);
      // a drop keeps the seat for the comeback (grace period), a hang-up says bye
      if (handingOff) signaling.current?.handOff();
      else signaling.current?.close();
      dropAll();
      worker?.terminate();
    };
  }, [ticket, localStream, patchRemote, code, crypto, relayOnly]);

  const send = useCallback((m: Parameters<SignalingClient["send"]>[0]) => {
    if (m.type === "media-state") sendState.current(m);
    else signaling.current?.send(m);
  }, []);

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    await Promise.all([...links.current.values()].map((l) => l.replaceVideoTrack(track)));
  }, []);

  const getPeerConnection = useCallback((id: string) => links.current.get(id)?.pc ?? null, []);

  /** Let the people without the room's key into the call (plain WebRTC with them). */
  const allowPlain = useCallback(() => allowPlainRef.current(), []);

  return { status, me, remotes, lobby, chat, error, send, replaceVideoTrack, getPeerConnection, allowPlain };
}