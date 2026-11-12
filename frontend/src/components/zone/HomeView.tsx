"use client";

import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useState, type CSSProperties, type FormEvent } from "react";

import { ArrowIcon, EnterIcon, GearIcon, LockIcon, Spinner } from "@/components/Icons";
import { Logo } from "@/components/Logo";
import { checkCode, errorText, reconnect, roomGone } from "@/lib/api";
import { joinRoom } from "@/lib/calls";
import { useMotionSet } from "@/lib/motion";
import { lastCall, lobby, type LastCall } from "@/lib/people";
import { OFFLINE_HINT, useOnline } from "@/lib/server";
import { useStore } from "@/lib/store";
import { agoLabel } from "@/lib/time";

import { Avatar, Button, IconButton, Switch, toast } from "./ui";
import { Row, ViewFrame, type ViewProps } from "./ViewFrame";
import { useZone } from "./ZoneContext";

export function HomeView({ nav, dir, banner }: ViewProps & { banner: LastCall | null }) {
  const m = useMotionSet();
  const zone = useZone();
  const lobbyOn = useStore(lobby);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, animate] = useAnimate<HTMLDivElement>();
  const online = useOnline();

  const shake = () => {
    if (!m.reduced && field.current) animate(field.current, { x: [0, -8, 7, -5, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !online) return;
    if (!code.trim()) {
      field.current?.querySelector("input")?.focus();
      shake();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await checkCode(code);
      const name = await zone.ensureName();
      if (!name) return;
      if (res.status === "lobby") {
        nav.push({ name: "guest", code: res.code, host: res.host });
      } else {
        await joinRoom(res.code, name);
        zone.enterCall(res.code);
      }
    } catch (err) {
      setError(errorText(err, "Couldn’t check the code. Try again."));
      shake();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ViewFrame
      name="home"
      dir={dir}
      className="home"
      style={{ "--lift": banner ? "var(--lift-banner)" : "var(--lift-home)" } as CSSProperties}
    >
      <div className="home__top" data-banner={banner ? "" : undefined}>
        <Row className="home__brand">
          <Logo className="home__logo" />
          <IconButton className="home__gear" label="Settings" onClick={() => nav.push({ name: "settings" })}>
            <GearIcon size={20} strokeWidth={1.7} />
          </IconButton>
          <p className="home__tagline">
            Video calls for two.
            <span className="home__more"> No rooms. No clutter.</span>
          </p>
        </Row>
        {banner && (
          <Row className="home__banner">
            <CallBanner call={banner} onBack={() => zone.enterCall(banner.code)} />
          </Row>
        )}
      </div>

      {/* phones: the switch sits next to the tab */}
      {!banner && (
        <Row className="home__lobby home__lobby--side">
          <label htmlFor="lobby-side" className="home__lobby-label">
            Waiting room
          </label>
          <Switch id="lobby-side" label="Waiting room" checked={lobbyOn} onChange={(v) => lobby.set(v)} />
        </Row>
      )}

      <div className="home__bottom">
        {!banner && (
          <Row className="home__lobby home__lobby--row" layout="position" transition={m.morph}>
            <label htmlFor="lobby-row" className="zrow__title">
              Waiting room
            </label>
            <Switch id="lobby-row" label="Waiting room" checked={lobbyOn} onChange={(v) => lobby.set(v)} />
          </Row>
        )}
        <Row layout="position" transition={m.morph}>
          <form className="home__join" onSubmit={submit} noValidate>
            <label htmlFor="code" className="home__label">
              Have a code?
            </label>
            <div ref={field} className="codefield" data-error={error ? "" : undefined}>
              <input
                id="code"
                data-testid="code-input"
                placeholder="abc-defg-hij"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (error) setError(null);
                }}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="go"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "code-error" : undefined}
              />
              <motion.span className="codefield__ring" initial={false} animate={{ opacity: error ? 1 : 0 }} transition={m.sweep} aria-hidden />
              <button
                type="submit"
                aria-label={online ? "Join" : OFFLINE_HINT}
                title={online ? undefined : OFFLINE_HINT}
                disabled={!online}
                aria-busy={busy || undefined}
                data-testid="code-submit"
              >
                {busy ? <Spinner size={18} /> : <ArrowIcon size={18} strokeWidth={2} />}
              </button>
            </div>
          </form>
        </Row>
        <AnimatePresence initial={false} mode="popLayout">
          {error && (
            <motion.p
              key={error}
              id="code-error"
              className="home__error"
              role="alert"
              initial={{ opacity: 0, y: m.reduced ? 0 : -4 }}
              animate={{ opacity: 1, y: 0, transition: m.sweep }}
              exit={{ opacity: 0, transition: m.leave }}
              layout="position"
            >
              <span aria-hidden>×</span>
              {error}
            </motion.p>
          )}
        </AnimatePresence>
        <Row className="home__e2e" layout="position" transition={m.morph}>
          <LockIcon size={14} />
          End-to-end encrypted
        </Row>
      </div>
    </ViewFrame>
  );
}

/** Home after a call dropped: the room is still open, one tap back in. */
function CallBanner({ call, onBack }: { call: LastCall; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  // forces a rejoin: no waiting for the next try
  const back = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await reconnect(call.code);
      onBack();
    } catch (err) {
      toast(errorText(err, "Couldn’t get back in. Try again."));
      if (roomGone(err)) lastCall.set(null);
      setBusy(false);
    }
  };
  const who = call.peer?.name ?? "Your call";
  return (
    <div className="banner">
      <div className="banner__head">
        <Avatar name={who} size={40} />
        <div className="banner__text">
          <p className="banner__title">{call.peer ? `Call with ${call.peer.name} dropped` : "Your call dropped"}</p>
          <p className="banner__meta">
            {call.code} · {agoLabel(call.droppedAt ?? Date.now())} · room still open
          </p>
        </div>
        <span className="banner__dot" aria-hidden />
      </div>
      <Button tone="green" icon={<EnterIcon size={20} strokeWidth={2} />} busy={busy} onClick={back} data-testid="back-to-meeting">
        Back to meeting
      </Button>
    </div>
  );
}
