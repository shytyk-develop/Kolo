"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState, ViewTransition } from "react";

import { CallView } from "@/components/CallView";
import { Ghost } from "@/components/Ghost";
import { ArrowIcon, CamGlyph, Spinner, UserIcon } from "@/components/Icons";
import { Island } from "@/components/Island";
import { MicMeter } from "@/components/LevelBars";
import { useMedia } from "@/components/MediaProvider";
import { MorphIsland, type IslandItem } from "@/components/MorphIsland";
import { Video } from "@/components/Video";
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
  // the camera's page-change name moves to the call only after the join screen is really gone
  // (a commit later), two elements may never hold it at once
  const [cameraFree, setCameraFree] = useState(false);
  useEffect(() => {
    if (joinGone) setCameraFree(true);
  }, [joinGone]);
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
    const id = setTimeout(() => setJoinGone(true), JOIN_LEAVE_MS);
    return () => clearTimeout(id);
  }, [callShown]);

  const notice = topNotice({ code, room, isHost, error: error ?? media.error });
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
          cameraName={cameraFree}
        />
      )}
      {!joinGone && (
        <main className="join" data-leaving={inCall || undefined} data-covered={callShown || undefined} inert={inCall}>
          {/* the camera morphs in from the home screen. Keeps its name until it's removed, then the
              call's own video takes it over (renaming instead would confuse react's bookkeeping) */}
          <ViewTransition name="self-camera" share="camera-morph" enter="camera-in" default="none">
            <div className="join__stage">
              <Video stream={media.stream} mirror fit="smart" />
              <div className="nocam" data-on={!media.stream || !media.videoOn || undefined}>
                <span className="avatar avatar--xl" style={avatarStyle(name)}>
                  {initial(name) ?? <UserIcon size={40} />}
                </span>
              </div>
            </div>
          </ViewTransition>

          {/* own layers in a page change: drawn over the camera morph, they play their own entrance */}
          <ViewTransition name="join-bar" share="live" enter="ui-in" default="none">
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
          </ViewTransition>
        </main>
      )}
      <RoomIsland slot={callNotice} inCall={inCall} fallback={notice} />
      {/* stand-ins for the home screen's card and camera buttons, for page changes both ways:
          they go aside when you come here, and come back from here when you go home */}
      <Ghost name="home-card" kind="card-away" shift="aside" />
      <Ghost name="home-controls" kind="fade-away" />
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
  return (
    <ViewTransition name="top-island" share="island-away" enter="ui-in" default="none">
      <MorphIsland item={inCall && fromCall !== undefined ? fromCall : fallback} />
    </ViewTransition>
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
