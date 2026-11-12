"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { SendIcon, Spinner, TrashIcon } from "@/components/Icons";
import { cancelLink, disconnectTelegram, errorText, linking, refreshTelegram, resumeLink, startLink, telegram } from "@/lib/api";
import { useMotionSet } from "@/lib/motion";
import { clearRecents, lobby, profile, recents } from "@/lib/people";
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

type CardState = "off" | "idle" | "waiting" | "expired" | "linked";

function TelegramCard() {
  const m = useMotionSet();
  const tg = useStore(telegram);
  const phase = useStore(linking);
  const [busy, setBusy] = useState(false);
  // one tap arms it, the second disconnects: it deletes the Kolo ID in the bot
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    void refreshTelegram();
    resumeLink();
  }, []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  const state: CardState = !tg.ready ? "off" : tg.handle ? "linked" : phase;

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
    off: "Not set up on this server",
    idle: "Not connected",
    waiting: "Waiting for Telegram…",
    expired: "Link expired — try again",
    linked: `Linked as @${tg.handle}`,
  }[state];

  return (
    <Row className="tgcard" data-state={state} data-testid="tg-card">
      <div className="tgcard__head">
        <span className="tgcard__icon">{state === "waiting" ? <Spinner size={18} /> : <SendIcon size={20} strokeWidth={2} />}</span>
        <p className="tgcard__title">Telegram</p>
        <AnimatePresence mode="popLayout" initial={false}>
          {state !== "off" && (
            <motion.div
              key={state}
              className="tgcard__actions"
              initial={{ opacity: 0, y: m.reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0, transition: m.sweep }}
              exit={{ opacity: 0, transition: m.leave }}
            >
              {(state === "idle" || state === "expired") && (
                <Press className="tgcard__btn" onClick={() => void connect()} aria-label="Connect Telegram" data-testid="tg-connect">
                  {state === "expired" ? "Try again" : "Connect"}
                </Press>
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
      <p className="tgcard__text">Invite people from Recent straight to Telegram, in one tap.</p>
    </Row>
  );
}
