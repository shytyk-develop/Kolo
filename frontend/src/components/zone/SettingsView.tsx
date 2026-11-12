"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { CheckIcon, SendIcon, Spinner, TrashIcon } from "@/components/Icons";
import {
  cancelLink,
  disconnectTelegram,
  errorText,
  linkedAt,
  linking,
  beginLink,
  openFromTap,
  prepared,
  prepareLink,
  refreshTelegram,
  resumeLink,
  startLink,
  telegram,
  waitingDeepLink,
} from "@/lib/api";
import { useMotionSet } from "@/lib/motion";
import { clearRecents, lobby, profile, recents } from "@/lib/people";
import { onServerBack, OFFLINE_HINT, useOnline } from "@/lib/server";
import { useStore } from "@/lib/store";

import { Footnote, Press, Switch, toast } from "./ui";
import { Row, ViewBody, ViewFoot, ViewFrame, ViewHead, type ViewProps } from "./ViewFrame";

export function SettingsView({ dir }: ViewProps) {
  const me = useStore(profile);
  const count = useStore(recents).length;

  const patch = (next: Partial<typeof me>) => profile.set((p) => ({ ...p, ...next }));

  return (
    <ViewFrame name="settings" dir={dir}>
      <ViewHead />
      <ViewBody>
        <Row>
          <label htmlFor="my-name" className="flabel">
            Your name
          </label>
          <input
            id="my-name"
            data-testid="settings-name"
            className="zfield"
            value={me.name}
            maxLength={40}
            placeholder="How others see you"
            autoComplete="name"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Row>
        <TelegramCard />
        <Row className="zrow">
          <div>
            <label htmlFor="remember" className="zrow__title">
              Remember people I call
            </label>
            <p className="zrow__sub">Shown in Recent</p>
          </div>
          <Switch id="remember" label="Remember people I call" checked={me.rememberPeople} onChange={(v) => patch({ rememberPeople: v })} />
        </Row>
        <Row className="zrow">
          <div>
            <label htmlFor="lobby-default" className="zrow__title">
              Waiting room by default
            </label>
            <p className="zrow__sub">Approve guests first</p>
          </div>
          <Switch
            id="lobby-default"
            label="Waiting room by default"
            checked={me.lobbyDefault}
            onChange={(v) => {
              patch({ lobbyDefault: v });
              lobby.set(v);
            }}
          />
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row>
          <Press
            className="dangerlink"
            disabled={!count}
            onClick={() => {
              const undo = clearRecents();
              toast("Recents cleared", { label: "Undo", run: undo });
            }}
          >
            <TrashIcon size={20} strokeWidth={1.9} />
            Clear recents
          </Press>
        </Row>
        <Row>
          <Footnote>Recents live in this browser only. Clearing site data removes them.</Footnote>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

// offline: the server didn't answer (never "off", which means it answered "not set up")
type CardState = "offline" | "checking" | "off" | "idle" | "waiting" | "expired" | "elsewhere" | "linked";

// how long the "connected" moment plays
const SUCCESS_MS = 1800;

function TelegramCard() {
  const m = useMotionSet();
  const tg = useStore(telegram);
  const phase = useStore(linking);
  const at = useStore(linkedAt);
  const [busy, setBusy] = useState(false);
  // one tap arms it, the second disconnects: it deletes the Kolo ID in the bot
  const [armed, setArmed] = useState(false);
  const [success, setSuccess] = useState(false);
  const online = useOnline();
  const prep = useStore(prepared);
  const head = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshTelegram();
    resumeLink();
    // the card was open while the server was down: fresh as soon as it's back
    return onServerBack(() => void refreshTelegram());
  }, []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  // just linked (here, or this view opened from Back to Kolo): a short green moment
  useEffect(() => {
    const left = at + SUCCESS_MS - Date.now();
    if (left <= 0) return;
    setSuccess(true);
    const id = setTimeout(() => setSuccess(false), left);
    return () => clearTimeout(id);
  }, [at]);
  // Connect needs its link before the tap (see prepareLink); a new one before this one runs out
  const wantLink = online && tg.ready === true && !tg.handle && phase !== "waiting";
  useEffect(() => {
    // the hidden warm-up copy of this screen doesn't ask
    if (!wantLink || head.current?.closest("[inert]")) return;
    if (!prep) {
      void prepareLink();
      return;
    }
    const id = setTimeout(() => prepared.set(null), Math.max(0, prep.until - Date.now() - 90_000));
    return () => clearTimeout(id);
  }, [wantLink, prep]);

  const state: CardState = !online
    ? "offline"
    : tg.ready === null
      ? "checking"
      : !tg.ready
        ? "off"
        : tg.handle
          ? "linked"
          : phase;

  const connect = async () => {
    try {
      await startLink();
    } catch (err) {
      toast(errorText(err, "Couldn’t reach Telegram. Try again."));
    }
  };

  const disconnect = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await disconnectTelegram();
      toast("Telegram disconnected");
    } catch (err) {
      toast(errorText(err, "Couldn’t disconnect. Try again."));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const meta = {
    // the last thing we knew, while we can't ask
    offline: tg.handle ? `Connected as @${tg.handle}` : "Server is offline",
    checking: "Checking…",
    off: "Not set up on this server",
    idle: "Not connected",
    waiting: "Waiting for Telegram…",
    expired: "Link expired — try again",
    elsewhere: "Not connected in this browser",
    linked: `Connected as @${tg.handle}`,
  }[state];

  const icon =
    state === "waiting" ? (
      <Spinner size={18} />
    ) : success && state === "linked" ? (
      <motion.span
        key="ok"
        className="tgcard__ok"
        initial={{ scale: m.reduced ? 1 : 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={m.morph}
      >
        <CheckIcon size={18} strokeWidth={2.6} />
      </motion.span>
    ) : (
      <SendIcon size={20} strokeWidth={2} />
    );

  return (
    <Row className="tgcard" data-state={state} data-success={(success && state === "linked") || undefined} data-testid="tg-card">
      <div className="tgcard__head" ref={head}>
        <span className="tgcard__icon">{icon}</span>
        <p className="tgcard__title">Telegram</p>
        <AnimatePresence mode="popLayout" initial={false}>
          {!["offline", "checking", "off", "elsewhere"].includes(state) && (
            <motion.div
              key={state}
              className="tgcard__actions"
              initial={{ opacity: 0, y: m.reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0, transition: m.sweep }}
              exit={{ opacity: 0, transition: m.leave }}
            >
              {(state === "idle" || state === "expired") && (
                <ConnectLink className="tgcard__btn" label={state === "expired" ? "Try again" : "Connect"} testId="tg-connect" fallback={connect} />
              )}
              {state === "waiting" && (
                <Press className="tgcard__btn tgcard__btn--quiet" onClick={cancelLink} data-testid="tg-cancel">
                  Cancel
                </Press>
              )}
              {state === "linked" && (
                <Press
                  className="tgcard__btn tgcard__btn--quiet"
                  data-armed={armed || undefined}
                  aria-busy={busy || undefined}
                  onClick={() => void disconnect()}
                  data-testid="tg-disconnect"
                >
                  {busy ? <Spinner size={16} /> : armed ? "Confirm" : "Disconnect"}
                </Press>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="tgcard__metabox">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={meta}
              className="tgcard__meta"
              data-testid="tg-status"
              initial={{ opacity: 0, y: m.reduced ? 0 : 4 }}
              animate={{ opacity: 1, y: 0, transition: m.sweep }}
              exit={{ opacity: 0, transition: m.leave }}
            >
              {meta}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      {state === "elsewhere" ? (
        <>
          <p className="tgcard__text" data-testid="tg-elsewhere">
            Open Kolo in the browser where you pressed Connect.
          </p>
          <ConnectLink className="tgcard__btn tgcard__btn--wide" label="Connect here instead" testId="tg-connect-here" fallback={connect} />
        </>
      ) : state === "offline" ? (
        <p className="tgcard__text" data-testid="tg-offline">
          {OFFLINE_HINT}
        </p>
      ) : state === "waiting" ? (
        <p className="tgcard__text">
          Choose your Kolo ID in the bot, then come back.
          {waitingDeepLink() && (
            <>
              {" "}
              <a
                className="tgcard__again"
                href={waitingDeepLink()}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => openFromTap(e, waitingDeepLink())}
                data-testid="tg-open"
              >
                Open Telegram
              </a>
            </>
          )}
        </p>
      ) : (
        <p className="tgcard__text">Invite people from Recent straight to Telegram, in one tap.</p>
      )}
    </Row>
  );
}

/**
 * Connect as a real link to the bot, so one tap opens Telegram (the app, on phones).
 * Until the link is ready (or if getting it failed) it's a button that gets one on tap.
 */
function ConnectLink({
  className,
  label,
  testId,
  fallback,
}: {
  className: string;
  label: string;
  testId: string;
  fallback: () => Promise<void>;
}) {
  const m = useMotionSet();
  const prep = useStore(prepared);
  const ready = prep && prep.until - Date.now() > 60_000 ? prep : null;
  if (!ready) {
    return (
      <Press className={className} onClick={() => void fallback()} aria-label="Connect Telegram" data-testid={testId}>
        {label}
      </Press>
    );
  }
  return (
    <motion.a
      className={className}
      href={ready.deepLink}
      target="_blank"
      rel="noreferrer"
      aria-label="Connect Telegram"
      whileTap={m.reduced ? undefined : m.press}
      transition={m.snap}
      onClick={(e) => {
        openFromTap(e, ready.deepLink);
        beginLink(ready);
      }}
      data-testid={testId}
    >
      {label}
    </motion.a>
  );
}
