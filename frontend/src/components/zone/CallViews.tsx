"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { CheckIcon, EnterIcon, WifiOffIcon } from "@/components/Icons";
import type { View } from "@/hooks/useViews";
import { createRoom, errorText, reconnect, RECONNECT_ATTEMPTS, RECONNECT_DELAYS, roomGone } from "@/lib/api";
import { callLog, joinRoom, storedTicket } from "@/lib/calls";
import { formatDuration } from "@/lib/format";
import { useMotionSet } from "@/lib/motion";
import { inviteLink, lastCall, lobby } from "@/lib/people";
import { useStore } from "@/lib/store";

import { Avatar, Button, CopyGlyph, toast, useCopy } from "./ui";
import { Row, ViewBody, ViewFoot, ViewFrame, ViewHead, type ViewProps } from "./ViewFrame";
import { useZone } from "./ZoneContext";

type ViewOf<N extends View["name"]> = Extract<View, { name: N }>;

// ---------- 08 Connection lost ----------

export function ConnectionLostView({ nav, dir, view }: ViewProps & { view: ViewOf<"lost"> }) {
  const m = useMotionSet();
  const zone = useZone();
  const call = useStore(lastCall);
  const mine = call?.code === view.code ? call : null;
  const peer = mine?.peer?.name ?? null;
  const navRef = useRef(nav);
  navRef.current = nav;
  // which try is next, and when (null = trying right now)
  const [round, setRound] = useState<{ n: number; until: number | null; wait: number }>(() => {
    const n = Math.min((mine?.attempt ?? 0) + 1, RECONNECT_ATTEMPTS);
    return { n, until: null, wait: RECONNECT_DELAYS[n - 1] };
  });
  const kick = useRef<() => void>(() => {});
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    stop.current = ac;
    const used = lastCall.get()?.attempt ?? 0;
    const note = (attempt: number) => lastCall.set((c) => (c && c.code === view.code ? { ...c, attempt, show: undefined } : c));
    void (async () => {
      for (let n = used + 1; n <= RECONNECT_ATTEMPTS; n++) {
        const wait = RECONNECT_DELAYS[n - 1];
        setRound({ n, until: Date.now() + wait, wait });
        await new Promise<void>((resolve) => {
          const id = setTimeout(resolve, wait);
          // "Back to meeting": this try, right now
          kick.current = () => {
            clearTimeout(id);
            resolve();
          };
          ac.signal.addEventListener("abort", () => clearTimeout(id));
        });
        if (ac.signal.aborted) return;
        setRound({ n, until: null, wait });
        note(n);
        try {
          await reconnect(view.code);
          if (ac.signal.aborted) return;
          zone.enterCall(view.code);
          return;
        } catch (err) {
          if (ac.signal.aborted) return;
          if (roomGone(err)) {
            lastCall.set(null);
            toast("This meeting has ended.");
            navRef.current.home();
            return;
          }
        }
      }
      // out of tries: home, where the dropped call waits
      navRef.current.home();
    })();
    return () => ac.abort();
  }, [view.code, zone]);

  const leave = () => {
    stop.current?.abort();
    const c = lastCall.get();
    callLog.ended(view.code, mine?.peer ?? null, c?.startedAt ?? null, c?.droppedAt ?? Date.now());
    if (lastCall.get()?.show === "ended") nav.replace({ name: "ended", code: view.code });
    else nav.home();
  };

  const trying = round.until === null;
  return (
    <ViewFrame name="lost" dir={dir}>
      <ViewHead />
      <ViewBody>
        <Row>
          <span className="losticon">
            <WifiOffIcon size={24} strokeWidth={2} />
          </span>
        </Row>
        <Row>
          <h1 className="vtitle" data-testid="connection-lost">
            Connection lost
          </h1>
          <p className="vtext">
            {peer ? `Your call with ${peer} dropped. ` : "Your call dropped. "}
            The room <b>{view.code}</b> is still open — we’re trying to bring you back.
          </p>
        </Row>
        <Row className="retry">
          <div className="retry__track">
            <motion.span
              key={`${round.n}:${trying}`}
              className="retry__fill"
              initial={{ scaleX: trying ? 1 : 0 }}
              animate={{ scaleX: 1 }}
              transition={trying || m.reduced ? { duration: 0 } : { duration: round.wait / 1000, ease: "linear" }}
            />
          </div>
          <div className="retry__meta">
            <span>
              Attempt {round.n} of {RECONNECT_ATTEMPTS}
            </span>
            <span>{trying ? "trying…" : <Countdown until={round.until!} />}</span>
          </div>
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row>
          <Button icon={<EnterIcon size={20} strokeWidth={2} />} busy={trying} onClick={() => kick.current()}>
            Back to meeting
          </Button>
        </Row>
        <Row>
          <Button tone="danger" className="zbtn--text" onClick={leave}>
            Leave call
          </Button>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [until]);
  return <>next in {Math.max(1, Math.ceil((until - now) / 1000))} s</>;
}

// ---------- 12 Call ended ----------

export function CallEndedView({ nav, dir, view }: ViewProps & { view: ViewOf<"ended"> }) {
  const zone = useZone();
  const call = useStore(lastCall);
  const mine = call?.code === view.code && call.status === "ended" ? call : null;
  const peer = mine?.peer?.name ?? "them";
  const durationMs = mine?.startedAt && mine.endedAt ? mine.endedAt - mine.startedAt : 0;
  // null = still asking the server
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();

  useEffect(() => {
    let alive = true;
    reconnect(view.code)
      .then(() => alive && setOpen(true))
      .catch((err) => alive && setOpen(roomGone(err) ? false : true));
    return () => {
      alive = false;
    };
  }, [view.code]);

  // the same room again, only while it exists
  const rejoin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!storedTicket(view.code)) {
        const name = await zone.ensureName();
        if (!name) return;
        await joinRoom(view.code, name);
      }
      zone.enterCall(view.code);
    } catch (err) {
      toast(errorText(err, "Couldn’t rejoin. Try again."));
      if (roomGone(err)) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  // the room is gone: a new one for the same person
  const fresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const name = await zone.ensureName();
      if (!name) return;
      const room = await createRoom({ lobby: lobby.get(), name });
      nav.push({ name: "ready", code: room.code, lobby: room.lobby, guest: mine?.peer?.name });
    } catch (err) {
      toast(errorText(err, "Couldn’t make a room. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ViewFrame name="ended" dir={dir}>
      <ViewHead />
      <ViewBody>
        <Row className="callhead">
          <Avatar name={peer} size={64} />
          <div>
            <h1 className="vtitle" data-testid="call-ended">
              Call ended
            </h1>
            <p className="vsub">
              with {peer} · {formatDuration(durationMs)}
            </p>
          </div>
        </Row>
        {mine?.saved && (
          <Row className="savedcard">
            <span className="okdot okdot--lg">
              <CheckIcon size={15} strokeWidth={3} />
            </span>
            <p>
              {peer} is saved to <b>Recent</b> on this device — invite again in one tap.
            </p>
          </Row>
        )}
      </ViewBody>
      <ViewFoot>
        <Row>
          <Button
            icon={<EnterIcon size={20} strokeWidth={2} />}
            busy={busy || open === null}
            disabled={open === false}
            onClick={() => void rejoin()}
            data-testid="rejoin"
          >
            {open === false ? "Room has closed" : "Rejoin"}
          </Button>
        </Row>
        <Row className="pair">
          {open === false ? (
            <Button tone="secondary" onClick={() => void fresh()}>
              New meeting
            </Button>
          ) : (
            <Button tone="secondary" icon={<CopyGlyph done={copied} size={18} />} onClick={() => void copy(inviteLink(view.code))}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          )}
          <Button tone="secondary" onClick={nav.home}>
            Home
          </Button>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}
