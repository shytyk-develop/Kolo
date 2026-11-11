"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { EndedNotice } from "@/components/EndedNotice";
import { ArrowIcon, CamGlyph, CamOffIcon, LockIcon, PlusIcon, Spinner } from "@/components/Icons";
import { MicMeter } from "@/components/LevelBars";
import { fullSpot, useCamera, useCameraSlot } from "@/components/CameraLayer";
import { Logo } from "@/components/Logo";
import { useMedia } from "@/components/MediaProvider";
import { api, hostSecrets } from "@/lib/api";

// how long the card takes to slide away, the page changes after it
const PAGE_SWAP_MS = 140;

export default function Home() {
  const router = useRouter();
  const media = useMedia();
  const { start } = media;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [lobby, setLobby] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<HTMLElement>(null);
  const cam = useCamera();
  // the camera lives above the pages (CameraLayer): this panel is just where it sits here
  useCameraSlot(preview, "cover", "home");
  // the card steps aside as you leave, and comes back in when you return from a room
  const [leaving, setLeaving] = useState(false);
  const [entering] = useState(() => {
    try {
      const back = sessionStorage.getItem("kolo:back-home") === "1";
      sessionStorage.removeItem("kolo:back-home");
      return back;
    } catch {
      return false;
    }
  });

  // off to a room: the camera grows to the whole screen right on the tap, live, and the card
  // slides away; the room page then finds the camera already there
  const go = (href: string) => {
    cam.moveTo(fullSpot(), { animate: true, fit: "smart" });
    setLeaving(true);
    // the page itself changes once the card is out of the way (the camera doesn't wait)
    setTimeout(() => router.push(href), PAGE_SWAP_MS);
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
    <main className="home" data-leaving={leaving || undefined} data-entering={entering || undefined}>
      {/* the camera's spot here; the picture itself is the app-wide camera, under this */}
      <section ref={preview} className="home__preview">
        <div className="nocam" data-on={!media.stream || !media.videoOn || undefined}>
          <CamOffIcon size={28} />
        </div>
        <div className="home__controls">
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
      </section>

      <section className="home__card">
        <div className="home__brand">
          <Logo className="home__logo" />
          <p className="home__tagline">
            Video calls for two.
            {/* the second line is left out on phones, see .home__more */}
            <span className="home__more">
              <br />
              No rooms. No clutter.
            </span>
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
            {/* why the last call ended; Suspense is required for useSearchParams */}
            <Suspense fallback={null}>
              <EndedNotice />
            </Suspense>
          </form>
          <p className="home__e2e">
            <LockIcon size={14} />
            End-to-end encrypted
          </p>
        </div>
      </section>
    </main>
  );
}