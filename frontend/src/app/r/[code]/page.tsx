"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { CallView } from "@/components/CallView";
import { leaveHome, useCamera, useCameraSlot } from "@/components/CameraLayer";
import { ArrowIcon, BackIcon, CamGlyph, Spinner, UserIcon } from "@/components/Icons";
import { Island } from "@/components/Island";
import { MicMeter } from "@/components/LevelBars";
import { useMedia } from "@/components/MediaProvider";
import { MorphIsland, type IslandItem } from "@/components/MorphIsland";
import { ApiError, api, hostSecrets } from "@/lib/api";
import { avatarStyle, initial } from "@/lib/format";
import { createSlot, type Slot, useSlot } from "@/lib/slot";
import type { JoinTicket, RoomPublic } from "@/lib/types";

// the join screen's way out, from the css: the bar sinks, then it's removed
const JOIN_LEAVE_MS = 420;

// "/r/abc-defg-hij": camera preview and name, then the call itself
export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const media = useMedia();
  const router = useRouter();
  const cam = useCamera();
  // the camera's spot on this screen: all of it (the picture is the app-wide camera, under this)
  const stage = useRef<HTMLDivElement>(null);
  useCameraSlot(stage, "smart");
  // on the way out: the bar sinks, the island folds up, the camera glides home
  const [exiting, setExiting] = useState(false);
  // nowhere to go from here (no such meeting, an error): back home, the camera glides back
  const goHome = () => {
    setExiting(true);
    leaveHome(cam, router, "here");
  };
  const { start } = media;
  const [room, setRoom] = useState<RoomPublic | null>(null);
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState<JoinTicket | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const nameField = useRef<HTMLLabelElement>(null);
  // into the call: the join screen stays on top until the call shows its own picture of you,
  // so the camera never blinks; then it's taken away
  const [callShown, setCallShown] = useState(false);
  const [joinGone, setJoinGone] = useState(false);
  // what the call wants the top island to say; one island for both screens, it just morphs
  const [callNotice] = useState(() => createSlot<IslandItem | null>());

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
      // only into an empty field: during a page change effects run late, and whatever was
      // typed in the meantime must not be wiped
      const saved = localStorage.getItem("kolo:name") ?? "";
      setName((typed) => typed || saved);
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

  const inCall = Boolean(ticket && media.stream);

  // the call reports when its picture is up; if it never does, don't keep the join screen forever
  useEffect(() => {
    if (!inCall) return;
    const id = setTimeout(() => setCallShown(true), 900);
    return () => clearTimeout(id);
  }, [inCall]);
  useEffect(() => {
    if (!callShown) return;
    // the call's own picture is up, exactly the same as the camera's: the camera steps aside
    cam.show(false);
    const id = setTimeout(() => setJoinGone(true), JOIN_LEAVE_MS);
    return () => clearTimeout(id);
  }, [callShown, cam]);

  const notice = topNotice({ code, room, isHost, error: error ?? media.error, onBack: goHome });
  const ready = Boolean(room && media.stream && !joining);

  return (
    <>
      {ticket && inCall && (
        <CallView
          ticket={ticket}
          media={media}
          code={code}
          selfName={name.trim()}
          notice={callNotice}
          onShown={() => setCallShown(true)}
        />
      )}
      {!joinGone && (
        <main
          className="join"
          data-leaving={inCall || exiting || undefined}
          data-covered={callShown || undefined}
          inert={inCall || exiting}
        >
          {/* where the camera is on this screen: all of it */}
          <div ref={stage} className="join__stage">
            <div className="nocam" data-on={!media.stream || !media.videoOn || undefined}>
              <span className="avatar avatar--xl" style={avatarStyle(name)}>
                {initial(name) ?? <UserIcon size={40} />}
              </span>
            </div>
          </div>

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
                <MicMeter stream={media.stream} on={media.audioOn} />
              </button>
              <button
                type="button"
                className="round"
                data-off={!media.videoOn || undefined}
                onClick={media.toggleVideo}
                disabled={!media.stream}
                aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
              >
                <CamGlyph off={!media.videoOn} />
              </button>
              <button className="joinbar__go" type="submit" disabled={!ready} data-testid="join-button">
                {/* same width while joining, the island doesn't jump */}
                Join
                <span className="joinbar__arrow">
                  {/* keyed: the new icon pops in instead of a hard swap */}
                  {joining || inCall ? (
                    <Spinner key="busy" size={16} className="icon-in" />
                  ) : (
                    <ArrowIcon key="go" size={18} strokeWidth={2.2} className="icon-in" />
                  )}
                </span>
              </button>
            </form>
          </Island>
        </main>
      )}
      {/* leaving for home: nothing more to say, the island folds up on the way */}
      <RoomIsland slot={callNotice} inCall={inCall} fallback={exiting ? null : notice} />
    </>
  );
}

// the top island for the join screen and the call: the same element all the way, so
// "Your meeting" morphs into "Connecting…" instead of one island vanishing and another popping up
function RoomIsland({
  slot,
  inCall,
  fallback,
}: {
  slot: Slot<IslandItem | null>;
  inCall: boolean;
  fallback: IslandItem | null;
}) {
  const fromCall = useSlot(slot);
  return <MorphIsland item={inCall && fromCall !== undefined ? fromCall : fallback} />;
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
  onBack,
}: {
  code: string;
  room: RoomPublic | null;
  isHost: boolean;
  error: string | null;
  onBack: () => void;
}): IslandItem | null {
  // something's wrong (no such meeting...): say it, with the way back right there
  if (error) {
    return {
      key: `error:${error}`,
      tone: "danger",
      node: (
        <span className="notice notice--back">
          <button className="notice__back" onClick={onBack} aria-label="Back to home" data-testid="back-home">
            <BackIcon size={18} strokeWidth={2.2} />
          </button>
          <span className="notice__text">{error}</span>
        </span>
      ),
    };
  }
  if (!room) return null;
  const who = inviterOf(room);
  const title = isHost ? "Your meeting" : who ? `${who} invited you` : "You’re invited";
  const online = room.participants > 0;
  return {
    key: "invite",
    node: (
      <span className="invite">
        <span className="avatar avatar--sm" style={avatarStyle(who ?? "")}>
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
