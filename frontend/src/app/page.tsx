"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, ViewTransition } from "react";

import { ArrowIcon, CamGlyph, CamOffIcon, LockIcon, PlusIcon, Spinner } from "@/components/Icons";
import { MicMeter } from "@/components/LevelBars";
import { Ghost, rememberRect } from "@/components/Ghost";
import { Logo } from "@/components/Logo";
import { useMedia } from "@/components/MediaProvider";
import { Video } from "@/components/Video";
import { api, hostSecrets } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const media = useMedia();
  const { start } = media;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [lobby, setLobby] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);

  // where the card and the camera buttons are, so their stand-ins on the room page line up
  // with them in the page change (both ways)
  const go = (href: string) => {
    rememberRect("home-card", card.current);
    rememberRect("home-controls", controls.current);
    router.push(href);
  };

  useEffect(() => {
    void start();
  }, [start]);

  async function createRoom() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // the room is named after its creator, the guest sees "Yan invited you"
      let name: string | undefined;
      try {
        name = localStorage.getItem("kolo:name")?.trim() || undefined;
      } catch {}
      const room = await api.createRoom({ name, lobby_enabled: lobby });
      // the creator becomes the host
      hostSecrets.save(room.code, room.host_secret);
      go(`/r/${room.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a room");
      setBusy(false);
    }
  }

  const status =
    media.error ?? (!media.stream ? "Starting camera…" : media.videoOn ? "You’re on camera" : "Camera is off");

  return (
    <main className="home">
      {/* the same camera as on the next screens: it morphs into the full-screen one and back */}
      <ViewTransition name="self-camera" share="camera-morph" enter="camera-in" default="none">
        <section className="home__preview">
          <Video stream={media.stream} mirror />
          {/* kept on top of the video, so toggling doesn't re-attach the stream */}
          <div className="nocam" data-on={!media.stream || !media.videoOn || undefined}>
            <CamOffIcon size={28} />
          </div>
          {/* own layer: leaves quickly instead of being stretched with the camera picture */}
          <ViewTransition name="home-controls" share="fade-away" enter="ui-in" default="none">
            <div ref={controls} className="home__controls">
              <button
                className="glass"
                onClick={media.toggleAudio}
                disabled={!media.stream}
                aria-pressed={!media.audioOn}
                aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
              >
                <MicMeter stream={media.stream} on={media.audioOn} />
              </button>
              <button
                className="glass"
                onClick={media.toggleVideo}
                disabled={!media.stream}
                aria-pressed={!media.videoOn}
                aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
              >
                <CamGlyph off={!media.videoOn} />
              </button>
              {/* keyed: a new status fades in instead of the text just changing */}
              <span key={status} className="home__status">
                {status}
              </span>
            </div>
          </ViewTransition>
        </section>
      </ViewTransition>

      {/* the card steps aside for the camera, and comes back when you're home again */}
      <ViewTransition name="home-card" share="card-away" enter="card-in" default="none">
        <section ref={card} className="home__card">
          <div className="home__brand">
            <Logo className="home__logo" />
            <p className="home__tagline">
              Video calls for two.
              <br />
              No rooms. No clutter.
            </p>
          </div>

          <div className="home__actions">
            <div className="notch">
              <span className="notch__fillet notch__fillet--a" aria-hidden />
              {/* busy is aria-busy, not disabled: disabled would drop the hover and the tongue would jump back */}
              <button className="notch__btn" onClick={createRoom} aria-busy={busy} data-testid="create-room">
                {/* same text while busy, the tongue keeps its width */}
                <span className="notch__icon">
                  {busy ? (
                    <Spinner key="busy" size={16} className="icon-in" />
                  ) : (
                    <PlusIcon key="new" size={16} strokeWidth={2} className="icon-in" />
                  )}
                </span>
                New meeting
              </button>
              <span className="notch__fillet notch__fillet--b" aria-hidden />
            </div>

            <label className="toggle" title="Guests wait until you let them in">
              <span className="toggle__title">Waiting room</span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={lobby}
                disabled={busy}
                onChange={(e) => setLobby(e.target.checked)}
                data-testid="lobby-checkbox"
              />
            </label>
          </div>

          <div className="home__bottom">
            <form
              className="home__join"
              onSubmit={(e) => {
                e.preventDefault();
                const value = code.trim().toLowerCase();
                if (value) go(`/r/${encodeURIComponent(value)}`);
              }}
            >
              <label htmlFor="code" className="home__label">
                Have a code?
              </label>
              <div className="codefield">
                <input
                  id="code"
                  placeholder="ka7-m2q"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button type="submit" aria-label="Join" disabled={!code.trim()}>
                  <ArrowIcon size={18} strokeWidth={2} />
                </button>
              </div>
              {error && <p className="home__error">{error}</p>}
            </form>
            <p className="home__e2e">
              <LockIcon size={14} />
              End-to-end encrypted
            </p>
          </div>
        </section>
      </ViewTransition>

      {/* where the call screen and its top island go when you hang up: they fade / shrink away */}
      <Ghost name="call-screen" kind="call-away" />
      <Ghost name="top-island" kind="island-away" />
      {/* lets the join screen's bar have its own layer over the camera morph */}
      <Ghost name="join-bar" kind="live" />
    </main>
  );
}
