"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { CheckIcon, EnterIcon, LinkIcon, ShareIcon } from "@/components/Icons";
import { useMedia } from "@/components/MediaProvider";
import type { View } from "@/hooks/useViews";
import {
  admitGuest,
  denyGuest,
  errorText,
  openLobby,
  setRoomLobby,
  telegram,
  waitForAdmission,
  type HostLobby,
  type Knock,
} from "@/lib/api";
import { joinRoom } from "@/lib/calls";
import { useMotionSet } from "@/lib/motion";
import { displayLink, inviteLink, profile, recents } from "@/lib/people";
import { OFFLINE_HINT, useOnline } from "@/lib/server";
import { useStore } from "@/lib/store";
import { clockLabel } from "@/lib/time";

import { Avatar, Button, CopyGlyph, copyText, Footnote, IconButton, Press, SectionLabel, Switch, toast, useCopy } from "./ui";
import { Row, ViewBody, ViewFoot, ViewFrame, ViewHead, type ViewProps } from "./ViewFrame";
import { useInvite } from "./useInvite";
import { useZone } from "./ZoneContext";

type ViewOf<N extends View["name"]> = Extract<View, { name: N }>;

const enterIcon = <EnterIcon size={20} strokeWidth={2} />;

/** My own room: through my waiting room if it's on, else straight into the call. */
function useEnterRoom({ nav }: ViewProps) {
  const zone = useZone();
  const [busy, setBusy] = useState(false);
  const enter = async (code: string, lobbyOn: boolean) => {
    if (lobbyOn) {
      nav.push({ name: "host", code });
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const name = await zone.ensureName();
      if (!name) return;
      await joinRoom(code, name);
      zone.enterCall(code);
    } catch (err) {
      toast(errorText(err, "Couldn’t join the room. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, enter };
}

async function shareLink(link: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "kolo", url: link });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  toast((await copyText(link)) ? "Link copied" : "Couldn’t copy the link");
}

// ---------- 04 Room is ready ----------

export function RoomReadyView(props: ViewProps & { view: ViewOf<"ready"> }) {
  const { nav, dir, view } = props;
  const tg = useStore(telegram);
  // only people I can reach there: they have a Kolo ID, and I'm linked
  const people = useStore(recents)
    .filter((c) => c.handle && tg.handle)
    .slice(0, 4);
  const { busy: inviting, send } = useInvite(nav);
  const online = useOnline();
  const [lobbyOn, setLobbyOn] = useState(view.lobby);
  const [saving, setSaving] = useState(false);
  const { copied, copy } = useCopy();
  // copied on the way here (a person from Recent): the icon says so for a moment
  const [arrivedCopied, setArrivedCopied] = useState(Boolean(view.copied));
  useEffect(() => {
    if (!arrivedCopied) return;
    const id = setTimeout(() => setArrivedCopied(false), 1600);
    return () => clearTimeout(id);
  }, [arrivedCopied]);
  const { busy, enter } = useEnterRoom(props);
  const link = inviteLink(view.code);
  const navRef = useRef(nav);
  navRef.current = nav;

  // the room's own setting, on the server: new joins follow it
  const toggleLobby = async (next: boolean) => {
    if (saving) return;
    setLobbyOn(next);
    setSaving(true);
    try {
      const real = await setRoomLobby(view.code, next);
      setLobbyOn(real);
      navRef.current.replace({ ...view, lobby: real, copied: false });
    } catch (err) {
      setLobbyOn(!next);
      toast(errorText(err, "Couldn’t change the waiting room. Try again."));
    } finally {
      setSaving(false);
    }
  };


  return (
    <ViewFrame name="ready" dir={dir}>
      <ViewHead onClose={nav.home} />
      <ViewBody>
        <Row>
          <h1 className="vtitle">Room is ready</h1>
          <p className="vsub">
            {view.guest ? `${view.copied ? "Link copied. " : ""}Send it to ${view.guest}.` : "Share the code or send it to someone."}
          </p>
        </Row>
        <Row className="codecard">
          <div className="codecard__text">
            <p className="codecard__code" data-testid="room-code">
              {view.code}
            </p>
            <p className="codecard__link">{displayLink(view.code)}</p>
          </div>
          <IconButton tone="fill" className="codecard__share only-phone" label="Share invite link" onClick={() => void shareLink(link)}>
            <ShareIcon size={20} strokeWidth={1.9} />
          </IconButton>
          <IconButton
            tone="ink"
            className="codecard__copy"
            label={copied || arrivedCopied ? "Link copied" : "Copy invite link"}
            onClick={() => void copy(link)}
            data-testid="copy-link"
          >
            <CopyGlyph done={copied || arrivedCopied} size={20} />
          </IconButton>
        </Row>
        {/* phones: the room's waiting room as one tap, no switch row */}
        <Row className="only-phone">
          <Press
            className="lobbychip"
            data-on={lobbyOn || undefined}
            aria-pressed={lobbyOn}
            aria-busy={saving || undefined}
            onClick={() => void toggleLobby(!lobbyOn)}
          >
            <i aria-hidden />
            {lobbyOn ? "Waiting room on" : "Waiting room off"}
          </Press>
        </Row>
        {people.length > 0 && (
          <>
            <Row>
              <SectionLabel>Send via Telegram</SectionLabel>
            </Row>
            <Row className="people" data-few={people.length < 4 || undefined}>
              {people.map((p) => (
                <Press
                  key={p.id}
                  className="people__one"
                  disabled={!online}
                  onClick={() => void send(p.handle!, p.name, { code: view.code, lobby: lobbyOn })}
                  aria-label={`Send to ${p.name} via Telegram`}
                  data-testid="ready-invite"
                >
                  <span className="people__av" data-busy={inviting === p.handle || undefined}>
                    <Avatar name={p.name} size={46} />
                  </span>
                  <span className="people__name">{p.name}</span>
                </Press>
              ))}
            </Row>
          </>
        )}
        <Row className="zrow only-split">
          <label htmlFor="lobby-ready" className="zrow__title">
            Waiting room
          </label>
          <span data-testid="lobby-toggle">
            <Switch id="lobby-ready" label="Waiting room" checked={lobbyOn} disabled={saving} onChange={(v) => void toggleLobby(v)} />
          </span>
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row className="pair pair--share">
          <Button
            icon={enterIcon}
            busy={busy}
            disabled={!online}
            title={online ? undefined : OFFLINE_HINT}
            onClick={() => void enter(view.code, lobbyOn)}
            data-testid="join-now"
          >
            Join now
          </Button>
          <IconButton className="share only-split" label="Share invite link" onClick={() => void shareLink(link)}>
            <ShareIcon size={20} strokeWidth={1.9} />
          </IconButton>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

/** Initials in a green ring, a soft ripple going out while we wait. */
function PulseAvatar({ name, still }: { name: string; still?: boolean }) {
  const m = useMotionSet();
  return (
    <div className="pulseav" data-still={still || undefined}>
      <span className="pulseav__halo" />
      {!m.reduced && !still && (
        <motion.span
          className="pulseav__ripple"
          initial={{ scale: 1, opacity: 0 }}
          animate={{ scale: [1, 1.36], opacity: [0.7, 0] }}
          transition={{ duration: 1.8, ease: [0.22, 1, 0.36, 1], repeat: Infinity, repeatDelay: 0.25 }}
        />
      )}
      <span className="pulseav__ring">
        <Avatar name={name} size={84} />
      </span>
    </div>
  );
}

// ---------- 03 Inviting ----------

export function InvitingView(props: ViewProps & { view: ViewOf<"inviting"> }) {
  const { nav, dir, view } = props;
  const m = useMotionSet();
  const name = view.who;
  const { copied, copy } = useCopy();
  const { busy, enter } = useEnterRoom(props);
  const online = useOnline();
  // it didn't go out: the link is the way now
  const failed = view.status === "undeliverable" || view.status === "limited";

  const line = {
    sent: `Sent via Telegram · ${clockLabel(view.sentAt)}`,
    needs_acceptance: `Sent · ${name} needs to accept first`,
    undeliverable: `Couldn’t reach ${name} on Telegram`,
    limited: "Too many invites, try again later",
  }[view.status];

  const copyButton = (
    <Button
      tone={failed ? "primary" : "secondary"}
      icon={<CopyGlyph done={copied} size={failed ? 20 : 18} />}
      onClick={() => void copy(inviteLink(view.code))}
      data-testid="inviting-copy"
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
  const enterButton = (
    <Button
      tone={failed ? "secondary" : "primary"}
      icon={failed ? undefined : enterIcon}
      busy={busy}
      disabled={!online}
      title={online ? undefined : OFFLINE_HINT}
      onClick={() => void enter(view.code, view.lobby)}
    >
      Enter room
    </Button>
  );

  return (
    <ViewFrame name="inviting" dir={dir}>
      <ViewHead />
      <ViewBody className="vbody--center">
        <Row>
          <PulseAvatar name={name} still={failed} />
        </Row>
        <Row>
          <h1 className="vtitle vtitle--center">Inviting {name}</h1>
        </Row>
        <Row className="sent" data-failed={failed || undefined} data-testid="invite-status" data-status={view.status}>
          <motion.span
            key={view.status}
            className="sent__line"
            initial={{ opacity: 0, y: m.reduced ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.sweep}
          >
            {failed ? (
              <span className="faildot" aria-hidden>
                !
              </span>
            ) : (
              <span className="okdot">
                <CheckIcon size={13} strokeWidth={3} />
              </span>
            )}
            {line}
          </motion.span>
        </Row>
        <Row>
          <p className="waitline">{failed ? `Send ${name} the link instead.` : `Waiting for ${name} to join…`}</p>
        </Row>
        <Row>
          <span className="zchip zchip--mono">
            <LinkIcon size={15} strokeWidth={2} />
            {view.code}
          </span>
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row>{failed ? copyButton : enterButton}</Row>
        <Row className="pair">
          {failed ? enterButton : copyButton}
          <Button tone="secondary" onClick={nav.back}>
            Cancel
          </Button>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

// ---------- 06 Waiting room, host side ----------

export function HostLobbyView({ nav, dir, view }: ViewProps & { view: ViewOf<"host"> }) {
  const m = useMotionSet();
  const zone = useZone();
  const [queue, setQueue] = useState<Knock[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const lobbyRef = useRef<HostLobby | null>(null);

  // in the room as the host while I wait: knocks come over the room's socket
  useEffect(() => {
    let alive = true;
    void (async () => {
      const name = profile.get().name.trim() || (await zone.ensureName());
      if (!name || !alive) return;
      lobbyRef.current = openLobby(view.code, name, {
        change: (q) => alive && setQueue(q),
        error: (err) => alive && setProblem(errorText(err, "Lost the connection to the room.")),
      });
    })();
    return () => {
      alive = false;
      lobbyRef.current?.close();
      lobbyRef.current = null;
    };
  }, [view.code, zone]);

  // the call page takes my seat, the guest never sees me go
  const intoCall = () => {
    setLeaving(true);
    lobbyRef.current?.handOff();
    zone.enterCall(view.code);
  };

  const admit = (k: Knock) => {
    if (!lobbyRef.current || leaving) return;
    admitGuest(lobbyRef.current, k.id);
    intoCall();
  };
  const deny = (k: Knock) => lobbyRef.current && denyGuest(lobbyRef.current, k.id);

  const [head, ...rest] = queue;
  return (
    <ViewFrame name="host" dir={dir}>
      <ViewHead />
      <ViewBody>
        <Row>
          <h1 className="vtitle">Knock, knock</h1>
          <p className="vsub">Waiting room is on. You decide who gets in.</p>
        </Row>
        <Row className="knockslot" data-testid="host-lobby">
          <AnimatePresence mode="popLayout" initial={false}>
            {head ? (
              <motion.div key={head.id} className="knock" variants={m.pop} initial="hidden" animate="shown" exit="gone" layout transition={m.morph}>
                <div className="knock__head">
                  <motion.span layoutId={`knock-av-${head.id}`} className="knock__av" transition={m.morph}>
                    <Avatar name={head.name} size={56} />
                  </motion.span>
                  <div>
                    <p className="knock__title">{head.name} wants to join</p>
                    <p className="knock__meta">{view.code} · just now</p>
                  </div>
                </div>
                <div className="pair">
                  <Button tone="green" icon={<CheckIcon size={18} strokeWidth={2.4} />} busy={leaving} onClick={() => admit(head)} data-testid="knock-admit">
                    Admit
                  </Button>
                  <Button tone="dark" onClick={() => deny(head)} disabled={leaving} data-testid="knock-deny">
                    Deny
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="idle" className="knock knock--idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: m.leave }}>
                <p className="knock__idle" role="status">
                  {problem ?? `Nobody’s knocking yet. Share ${view.code} and they’ll show up here.`}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </Row>
        <AnimatePresence initial={false}>
          {rest.length > 0 && (
            <motion.div key="line" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={m.sweep}>
              <SectionLabel aside={rest.length}>Also in line</SectionLabel>
              <AnimatePresence mode="popLayout">
                {rest.map((k) => (
                  <motion.div
                    key={k.id}
                    className="line"
                    layout="position"
                    initial={{ opacity: 0, y: m.reduced ? 0 : 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: m.leave }}
                    transition={m.sweep}
                  >
                    <motion.span layoutId={`knock-av-${k.id}`} className="line__av" transition={m.morph}>
                      <Avatar name={k.name} size={40} />
                    </motion.span>
                    <span className="line__name">{k.name}</span>
                    <Press className="line__admit" onClick={() => admit(k)} aria-label={`Admit ${k.name}`}>
                      Admit
                    </Press>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </ViewBody>
      <ViewFoot>
        <Row>
          <Button tone="secondary" icon={enterIcon} onClick={intoCall} disabled={leaving} data-testid="host-enter">
            Enter room
          </Button>
        </Row>
        <Row>
          <Footnote>Only people you admit can see or hear you.</Footnote>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

// ---------- 07 Waiting room, guest side ----------

export function GuestWaitView({ nav, dir, view }: ViewProps & { view: ViewOf<"guest"> }) {
  const m = useMotionSet();
  const zone = useZone();
  const media = useMedia();
  const me = useStore(profile).name.trim();
  const navRef = useRef(nav);
  navRef.current = nav;

  // knock over the room's socket; let in: the call page takes the seat
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const name = profile.get().name.trim() || (await zone.ensureName());
      if (ac.signal.aborted) return;
      if (!name) {
        navRef.current.back();
        return;
      }
      try {
        const seat = await waitForAdmission(view.code, name, { onWaiting: () => {}, signal: ac.signal });
        seat.handOff();
        zone.enterCall(view.code);
      } catch (err) {
        if (ac.signal.aborted) return;
        toast(errorText(err, "Couldn’t reach the room. Try again."));
        navRef.current.back();
      }
    })();
    return () => ac.abort();
  }, [view.code, zone]);

  return (
    <ViewFrame name="guest" dir={dir}>
      <ViewHead />
      <ViewBody className="vbody--center">
        <Row>
          <PulseAvatar name={view.host ?? "Host"} />
        </Row>
        <Row>
          <h1 className="vtitle vtitle--center" data-testid="guest-waiting">
            Waiting for {view.host ?? "the host"}
            <br />
            to let you in
          </h1>
        </Row>
        <Row>
          <span className="zchip zchip--mono zchip--code">{view.code}</span>
        </Row>
        <Row>
          <p className="joining">
            Joining as <b>{me || "Guest"}</b> · mic {media.audioOn ? "on" : "off"} · camera {media.videoOn ? "on" : "off"}
          </p>
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row className="indet" aria-hidden>
          {m.reduced ? (
            <span className="indet__bar" />
          ) : (
            <motion.span
              className="indet__bar"
              initial={{ x: "-100%" }}
              animate={{ x: ["-100%", "385%"] }}
              transition={{ duration: 1.6, ease: [0.45, 0, 0.55, 1], repeat: Infinity }}
            />
          )}
        </Row>
        <Row>
          <Button tone="secondary" onClick={nav.back}>
            Cancel
          </Button>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}
