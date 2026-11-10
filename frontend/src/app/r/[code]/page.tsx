"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { CallView } from "@/components/CallView";
import { ArrowIcon, CamIcon, CamOffIcon, MicIcon, MicOffIcon, UserIcon } from "@/components/Icons";
import { Island } from "@/components/Island";
import { useMedia } from "@/components/MediaProvider";
import { MorphIsland, type IslandItem } from "@/components/MorphIsland";
import { Video } from "@/components/Video";
import { ApiError, api, hostSecrets } from "@/lib/api";
import { initial } from "@/lib/format";
import type { JoinTicket, RoomPublic } from "@/lib/types";

// "/r/abc-defg-hij": camera preview and name, then the call itself
export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const media = useMedia();
  const { start } = media;
  const [room, setRoom] = useState<RoomPublic | null>(null);
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState<JoinTicket | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const nameField = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    api
      .getRoom(code)
      .then(setRoom)
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 404 ? "This meeting doesn't exist" : String(err.message)),
      );
    void start();
    setIsHost(Boolean(hostSecrets.get(code)));
    try {
      setName(localStorage.getItem("kolo:name") ?? "");
    } catch {}
  }, [code, start]);

  async function join() {
    if (joining) return;
    setError(null);
    setJoining(true);
    try {
      try {
        localStorage.setItem("kolo:name", name.trim());
      } catch {}
      setTicket(await api.join(code, name.trim(), hostSecrets.get(code)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setJoining(false);
    }
  }

  if (ticket && media.stream) {
    return <CallView ticket={ticket} media={media} code={code} selfName={name.trim()} />;
  }

  const notice = topNotice({ code, room, isHost, error: error ?? media.error });
  const ready = Boolean(room && media.stream && !joining);

  return (
    <main className="join">
      <div className="join__stage">
        <Video stream={media.stream} mirror />
        <div className="nocam" data-on={!media.stream || !media.videoOn || undefined}>
          <span className="avatar avatar--xl">{initial(name) ?? <UserIcon size={40} />}</span>
        </div>
      </div>

      <MorphIsland item={notice} />

      <Island edge="bottom" className="joinbar">
        <form
          className="joinbar__form"
          onSubmit={(e) => {
            e.preventDefault();
            // no name yet: shake the field instead of a grey button
            if (!name.trim()) {
              nameField.current?.querySelector("input")?.focus();
              nameField.current?.animate(SHAKE, { duration: 420, easing: "ease-out" });
              return;
            }
            if (ready) void join();
          }}
        >
          <label className="field" ref={nameField}>
            <UserIcon size={16} />
            <input
              placeholder="Your name"
              value={name}
              maxLength={40}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              data-testid="name-input"
            />
          </label>
          <span className="joinbar__sep" aria-hidden />
          <button
            type="button"
            className="round"
            data-off={!media.audioOn || undefined}
            onClick={media.toggleAudio}
            disabled={!media.stream}
            aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
          >
            {media.audioOn ? <MicIcon /> : <MicOffIcon />}
          </button>
          <button
            type="button"
            className="round"
            data-off={!media.videoOn || undefined}
            onClick={media.toggleVideo}
            disabled={!media.stream}
            aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
          >
            {media.videoOn ? <CamIcon /> : <CamOffIcon />}
          </button>
          <button className="joinbar__go" type="submit" disabled={!ready} data-testid="join-button">
            {joining ? "Joining…" : "Join"}
            <ArrowIcon size={18} strokeWidth={2.2} />
          </button>
        </form>
      </Island>
    </main>
  );
}

const SHAKE = [0, -5, 5, -5, 5, 0].map((x) => ({ transform: `translateX(${x}px)` }));

// backend names rooms "Room <code>" when the creator gave no name
function inviterOf(room: RoomPublic): string | null {
  return room.name && !room.name.startsWith("Room ") ? room.name : null;
}

function topNotice({
  code,
  room,
  isHost,
  error,
}: {
  code: string;
  room: RoomPublic | null;
  isHost: boolean;
  error: string | null;
}): IslandItem | null {
  if (error) {
    return { key: `error:${error}`, tone: "danger", node: <span className="pill-text">{error}</span> };
  }
  if (!room) return null;
  const who = inviterOf(room);
  const title = isHost ? "Your meeting" : who ? `${who} invited you` : "You’re invited";
  const online = room.participants > 0;
  return {
    key: "invite",
    node: (
      <span className="invite">
        <span className="avatar avatar--sm">
          {initial(who ?? "") ?? <UserIcon size={14} />}
          {online && <i className="avatar__dot" />}
        </span>
        <span className="invite__title">{title}</span>
        <span className="invite__sep" aria-hidden />
        <span className="invite__code">{code}</span>
      </span>
    ),
  };
}
