"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ArrowIcon, CamIcon, CamOffIcon, LockIcon, MicIcon, MicOffIcon, PlusIcon } from "@/components/Icons";
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
      router.push(`/r/${room.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a room");
      setBusy(false);
    }
  }

  const status = media.error ?? (!media.stream ? "Starting camera…" : media.videoOn ? "You’re on camera" : "Camera is off");

  return (
    <main className="home">
      <section className="home__preview">
        <Video stream={media.stream} mirror />
        {/* kept on top of the video, so toggling doesn't re-attach the stream */}
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
            {media.audioOn ? <MicIcon /> : <MicOffIcon />}
          </button>
          <button
            className="glass"
            onClick={media.toggleVideo}
            disabled={!media.stream}
            aria-pressed={!media.videoOn}
            aria-label={media.videoOn ? "Turn off camera" : "Turn on camera"}
          >
            {media.videoOn ? <CamIcon /> : <CamOffIcon />}
          </button>
          <span className="home__status">{status}</span>
        </div>
      </section>

      <section className="home__card">
        <div className="home__brand">
          <Logo className="home__logo" />
          <p className="home__tagline">
            Video calls for two.
            <br />
            No rooms. No clutter.
          </p>
        </div>

        <div className="notch">
          <span className="notch__fillet notch__fillet--a" aria-hidden />
          <button className="notch__btn" onClick={createRoom} disabled={busy} data-testid="create-room">
            <PlusIcon size={16} strokeWidth={2} />
            {busy ? "Creating…" : "New meeting"}
          </button>
          <span className="notch__fillet notch__fillet--b" aria-hidden />
        </div>

        <div className="home__bottom">
          <label className="toggle">
            <span className="toggle__text">
              <span className="toggle__title">Waiting room</span>
              <span className="toggle__hint">You let each guest in</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={lobby}
              onChange={(e) => setLobby(e.target.checked)}
              data-testid="lobby-checkbox"
            />
          </label>
          <form
            className="home__join"
            onSubmit={(e) => {
              e.preventDefault();
              const value = code.trim().toLowerCase();
              if (value) router.push(`/r/${encodeURIComponent(value)}`);
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
    </main>
  );
}
