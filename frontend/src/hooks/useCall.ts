"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "@/lib/api";
import { dbg, dbgOnce } from "@/lib/debug";
import { PeerLink } from "@/lib/peer";
import { SignalingClient } from "@/lib/signaling";
import type { JoinTicket, Peer, ServerMessage } from "@/lib/types";

export interface RemoteParticipant {
  peer: Peer;
  stream: MediaStream | null;
  state: RTCPeerConnectionState;
  audio: boolean;
  video: boolean;
}

export interface ChatLine {
  from: string;
  name: string;
  text: string;
  ts: number;
}

export type CallStatus = "connecting" | "lobby" | "in-call" | "reconnecting" | "denied" | "ended" | "error";

// short window for a wifi blip (~4.5 s total), then the call ends
const RETRY_DELAYS = [1000, 1500, 2000];
// 1001 = going away, 1012 = server stopped/restarted: end the call right away
const SERVER_GONE = new Set([1001, 1012]);

const CLOSE_ERRORS: Record<number, string> = {
  4401: "The link has expired, join again",
  4403: "You can't join this meeting",
  4404: "This meeting doesn't exist",
  4409: "The room is full or you opened it in another tab",
  4410: "This meeting has ended",
};

/** Everything about the call: signaling, a connection per person, chat, lobby. */
export function useCall(ticket: JoinTicket | null, localStream: MediaStream | null) {
  const router = useRouter();
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [me, setMe] = useState<Peer | null>(null);
  const [remotes, setRemotes] = useState<Record<string, RemoteParticipant>>({});
  const [lobby, setLobby] = useState<Peer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const links = useRef(new Map<string, PeerLink>());
  const signaling = useRef<SignalingClient | null>(null);
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

    const newRemote = (peer: Peer): RemoteParticipant => ({
      peer,
      stream: null,
      state: "new",
      audio: true,
      video: true,
    });

    const linkFor = (peer: Peer): PeerLink => {
      const existing = links.current.get(peer.id);
      if (existing) return existing;

      const link = new PeerLink(
        peer.id,
        // who is polite, both sides decide the same way
        myId < peer.id,
        ticket.ice_servers,
        (m) => {
          if (m.type === "ice") dbgOnce("send: first ice");
          else dbg(`send: ${m.type}`);
          signaling.current?.send(m);
        },
        (stream) => patchRemote(peer.id, { stream }),
        (state) => patchRemote(peer.id, { state }),
      );
      link.addLocalStream(localStream);
      links.current.set(peer.id, link);
      dbg("link: created", { peer: peer.id });
      setRemotes((prev) => ({ ...prev, [peer.id]: prev[peer.id] ?? newRemote(peer) }));
      return link;
    };

    const dropPeer = (id: string) => {
      if (links.current.has(id)) dbg("link: closed", { peer: id });
      links.current.get(id)?.close();
      links.current.delete(id);
      setRemotes((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
    };

    const dropAll = () => {
      if (links.current.size) dbg("link: closed all", { count: links.current.size });
      links.current.forEach((link) => link.close());
      links.current.clear();
      setRemotes({});
    };

    const onMessage = async (msg: ServerMessage) => {
      if (msg.type === "ice") dbgOnce("recv: first ice");
      else if (msg.type !== "pong") dbg(`recv: ${msg.type}`, "from" in msg ? { from: msg.from } : undefined);
      switch (msg.type) {
        case "welcome": {
          attempt = 0;
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
            // newcomer (or a dead link) calls the ones already in the room
            linkFor(peer);
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
          // a new session of theirs means a new connection: theirs will come with an offer
          if (link) dropPeer(msg.peer.id);
          // the link is made when the newcomer's offer comes, just show the tile for now
          setRemotes((prev) => ({ ...prev, [msg.peer.id]: prev[msg.peer.id] ?? newRemote(msg.peer) }));
          break;
        }
        case "peer-left":
          dropPeer(msg.peer_id);
          break;
        case "offer":
        case "answer": {
          const known = links.current.get(msg.from);
          const link = known ?? linkFor({ id: msg.from, name: "…", role: "guest" });
          try {
            await link.handleDescription(msg.type, msg.sdp);
          } catch (err) {
            // an offer from their brand new connection doesn't fit our old one (other keys):
            // start a fresh one for it
            if (msg.type !== "offer" || !known) throw err;
            dbg("link: offer didn't fit, fresh link", { peer: msg.from, error: String(err) });
            const peer = remotesRef.current[msg.from]?.peer ?? { id: msg.from, name: "…", role: "guest" as const };
            dropPeer(msg.from);
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

    // the server is gone: close every peer connection and go home with a reason
    const leave = (reason: "server" | "lost") => {
      stopped = true;
      clearTimeout(retryTimer);
      dropAll();
      setStatus("ended");
      try {
        // same flag as a normal hang-up: the home card slides back in
        sessionStorage.setItem("kolo:back-home", "1");
      } catch {}
      router.replace(`/?ended=${reason}`);
    };

    const onClose = (code: number, reason: string) => {
      if (stopped) return;
      console.info("signaling closed", code, reason);

      if (SERVER_GONE.has(code)) {
        leave("server");
        return;
      }
      // 1000 = normal, 4xxx = server said no for good, retrying won't help
      if (code === 1000 || (code >= 4000 && code < 5000)) {
        setStatus((prev) => (prev === "denied" ? prev : code === 1000 ? "ended" : "error"));
        setError(CLOSE_ERRORS[code] ?? null);
        return;
      }
      // network drop or dead server: a few quick tries, then give up
      if (attempt >= RETRY_DELAYS.length) {
        leave("lost");
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

    open();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      signaling.current?.close();
      dropAll();
    };
  }, [ticket, localStream, patchRemote, router]);

  const send = useCallback((m: Parameters<SignalingClient["send"]>[0]) => signaling.current?.send(m), []);

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    await Promise.all([...links.current.values()].map((l) => l.replaceVideoTrack(track)));
  }, []);

  const getPeerConnection = useCallback((id: string) => links.current.get(id)?.pc ?? null, []);

  return { status, me, remotes, lobby, chat, error, send, replaceVideoTrack, getPeerConnection };
}