"use client";

import { AnimatePresence, motion, useAnimate } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ArrowIcon, BoltIcon, LinkIcon, MoreIcon, PencilIcon, SendIcon, Spinner, TrashIcon } from "@/components/Icons";
import type { Nav } from "@/hooks/useViews";
import { createRoom, errorText, HANDLE_RULES, isHandle, normalizeHandle, telegram } from "@/lib/api";
import { useMotionSet } from "@/lib/motion";
import { lobby, profile, recents, removeRecent, renameRecent, type Contact } from "@/lib/people";
import { OFFLINE_HINT, useOnline } from "@/lib/server";
import { createStore, useStore } from "@/lib/store";
import { dayLabel, lengthLabel } from "@/lib/time";

import { Avatar, copyText, Footnote, IconButton, Press, SectionLabel, toast } from "./ui";
import { Row, ViewBody, ViewFoot, ViewFrame, ViewHead, type ViewProps } from "./ViewFrame";
import { useInvite } from "./useInvite";
import { useZone } from "./ZoneContext";

// where the "…" that opened the menu is, relative to the panel
const anchor = createStore<{ top: number; bottom: number; right: number } | null>(() => null, null);
// rename happens right in the row
const renaming = createStore<string | null>(() => null, null);

/** A new room for someone from Recent: link copied, "Room is ready" shows them as the guest. */
export function useStartWith(nav: Nav) {
  const zone = useZone();
  const [busy, setBusy] = useState<string | null>(null);
  const start = useCallback(
    // replace: from the menu, so Back doesn't reopen it
    async (c: Contact, replace = false) => {
      setBusy(c.id);
      try {
        // with a name already the copy starts right in the tap (safari wants that)
        const known = profile.get().name.trim();
        const name = known || (await zone.ensureName());
        if (!name) return;
        const made = createRoom({ lobby: lobby.get(), name });
        const copied = known ? copyText(made.then((r) => r.link)) : Promise.resolve(false);
        const room = await made;
        const ok = await copied;
        const view = { name: "ready", code: room.code, lobby: room.lobby, guest: c.name, copied: ok } as const;
        if (replace) nav.replace(view);
        else nav.push(view);
        if (ok) toast("Link copied");
      } catch (err) {
        toast(errorText(err, "Couldn’t make a room. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [nav, zone],
  );
  return { busy, start };
}

export function NewMeetingView({ nav, dir }: ViewProps) {
  const zone = useZone();
  const list = useStore(recents);
  const menuFor = nav.view.name === "new" ? nav.view.menu : undefined;
  const [instantBusy, setInstantBusy] = useState(false);
  const { busy, start } = useStartWith(nav);
  const invite = useInvite(nav);
  const tg = useStore(telegram);
  const online = useOnline();
  const navRef = useRef(nav);
  navRef.current = nav;

  const instant = async () => {
    if (instantBusy || !online) return;
    setInstantBusy(true);
    try {
      const name = await zone.ensureName();
      if (!name) return;
      const room = await createRoom({ lobby: lobby.get(), name });
      nav.push({ name: "ready", code: room.code, lobby: room.lobby });
    } catch (err) {
      toast(errorText(err, "Couldn’t make a room. Try again."));
    } finally {
      setInstantBusy(false);
    }
  };

  const onStart = useCallback((c: Contact) => void start(c), [start]);
  const send = invite.send;
  const onInvite = useCallback((c: Contact) => c.handle && void send(c.handle, c.name), [send]);
  const onMenu = useCallback((id: string, button: HTMLElement) => {
    const panel = button.closest(".panel")?.getBoundingClientRect();
    const r = button.getBoundingClientRect();
    if (panel) anchor.set({ top: r.top - panel.top, bottom: r.bottom - panel.top, right: r.right - panel.left });
    navRef.current.push({ name: "new", menu: id });
  }, []);

  return (
    <ViewFrame name="new" dir={dir}>
      <ViewHead onClose={nav.home} />
      <ViewBody>
        <Row>
          <Press
            className="instant"
            onClick={instant}
            aria-busy={instantBusy || undefined}
            aria-disabled={!online || undefined}
            data-testid="instant-meeting"
          >
            <span className="instant__icon">
              <BoltIcon size={22} strokeWidth={2} />
            </span>
            <span className="instant__text">
              <span className="instant__title">Instant meeting</span>
              <span className="instant__sub">{online ? "New link · start right now" : "Server is offline"}</span>
            </span>
            <span className="instant__go">{instantBusy ? <Spinner size={18} /> : <ArrowIcon size={22} strokeWidth={2} />}</span>
          </Press>
        </Row>
        <KoloIdInvite nav={nav} />
        <Row>
          <SectionLabel aside={list.length ? "on this device" : undefined}>Recent</SectionLabel>
        </Row>
        {list.length > 0 ? (
          <div className="recents">
            <AnimatePresence mode="popLayout">
              {list.map((c) => (
                <RecentRow
                  key={c.id}
                  contact={c}
                  busy={busy === c.id || (Boolean(c.handle) && invite.busy === c.handle)}
                  active={menuFor === c.id}
                  viaTelegram={Boolean(tg.handle && c.handle)}
                  offline={!online}
                  onStart={onStart}
                  onInvite={onInvite}
                  onMenu={onMenu}
                />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <Row className="empty" data-testid="recents-empty">
            <span className="empty__dots" aria-hidden>
              <i />
              <i />
            </span>
            <p className="empty__title">No one here yet</p>
            <p className="empty__text">People you call show up here, so next time you can invite them in one tap.</p>
          </Row>
        )}
      </ViewBody>
      <ViewFoot>
        <Row className={list.length ? "only-split" : undefined}>
          <Footnote>
            {list.length ? "Recents are saved only in this browser. Nothing is stored on our servers." : "Stored only in this browser."}
          </Footnote>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}

const meta = (c: Contact) => `${dayLabel(c.lastCallAt)} · ${lengthLabel(c.lastDurationMs)}`;

const RecentRow = memo(function RecentRow({
  contact: c,
  busy,
  active,
  viaTelegram,
  offline,
  onStart,
  onInvite,
  onMenu,
}: {
  contact: Contact;
  busy: boolean;
  active: boolean;
  offline: boolean;
  // they have a Kolo ID and I'm linked
  viaTelegram: boolean;
  onStart: (c: Contact) => void;
  onInvite: (c: Contact) => void;
  onMenu: (id: string, button: HTMLElement) => void;
}) {
  const go = (c: Contact) => !offline && (viaTelegram ? onInvite : onStart)(c);
  const m = useMotionSet();
  const editing = useStore(renaming) === c.id;
  return (
    <motion.div
      className="recent"
      data-active={active || undefined}
      data-testid="recent-row"
      layout="position"
      variants={m.row}
      exit={{ opacity: 0, scale: m.reduced ? 1 : 0.96, transition: m.leave }}
      transition={m.morph}
    >
      {editing ? (
        <div className="recent__main">
          <Avatar name={c.name} size={44} />
          <div className="recent__text">
            <RenameField contact={c} />
            <span className="recent__meta">{meta(c)}</span>
          </div>
        </div>
      ) : (
        <button type="button" className="recent__main" onClick={() => go(c)} aria-label={`New meeting with ${c.name}`}>
          <Avatar name={c.name} size={44} />
          <span className="recent__text">
            <span className="recent__name">{c.name}</span>
            <span className="recent__meta">{meta(c)}</span>
          </span>
        </button>
      )}
      {viaTelegram ? (
        <IconButton
          className="recent__act"
          label={offline ? OFFLINE_HINT : `Invite ${c.name} on Telegram`}
          disabled={offline}
          onClick={() => onInvite(c)}
          aria-busy={busy || undefined}
          data-testid="recent-invite"
        >
          {busy ? <Spinner size={16} /> : <SendIcon size={18} strokeWidth={1.9} />}
        </IconButton>
      ) : (
        <IconButton
          className="recent__act"
          label={offline ? OFFLINE_HINT : `Copy a new link for ${c.name}`}
          disabled={offline}
          onClick={() => onStart(c)}
          aria-busy={busy || undefined}
          data-testid="recent-start"
        >
          {busy ? <Spinner size={16} /> : <LinkIcon size={18} strokeWidth={1.9} />}
        </IconButton>
      )}
      <IconButton
        tone="plain"
        id={`more-${c.id}`}
        className="recent__more"
        label={`More for ${c.name}`}
        aria-haspopup="menu"
        aria-expanded={active}
        onClick={(e) => onMenu(c.id, e.currentTarget)}
      >
        <MoreIcon size={20} />
      </IconButton>
    </motion.div>
  );
});

function RenameField({ contact }: { contact: Contact }) {
  const [value, setValue] = useState(contact.name);
  const done = (save: boolean) => {
    if (save) renameRecent(contact.id, value);
    renaming.set(null);
  };
  return (
    <input
      className="recent__rename"
      value={value}
      autoFocus
      maxLength={40}
      aria-label={`New name for ${contact.name}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  );
}

/** "…" on a recent: a popover from its row on wide screens, a sheet inside the white panel on phones. */
export function ContactMenu({ nav, split }: { nav: Nav; split: boolean }) {
  const id = nav.view.name === "new" ? nav.view.menu : undefined;
  const list = useStore(recents);
  const contact = id ? list.find((c) => c.id === id) : undefined;
  const m = useMotionSet();
  const { busy, start } = useStartWith(nav);
  const invite = useInvite(nav);
  const tg = useStore(telegram);
  const online = useOnline();

  // the menu is a history entry: closing it is Back
  const close = useCallback(() => nav.back(), [nav]);

  useEffect(() => {
    if (!contact) return;
    // Esc closes, and so does tabbing out of it
    const onKey = (e: globalThis.KeyboardEvent) => (e.key === "Escape" || e.key === "Tab") && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.getElementById(`more-${contact.id}`)?.focus({ preventScroll: true });
    };
  }, [contact, close]);

  const actions: Action[] | undefined = contact && [
    {
      key: "invite",
      label: "Invite via Telegram",
      icon: invite.busy ? <Spinner size={18} /> : <SendIcon size={20} strokeWidth={1.8} />,
      disabled: !online || !tg.handle || !contact.handle,
      hint: !online
        ? "Server is offline"
        : !tg.ready
        ? "Not set up on this server"
        : !tg.handle
          ? "Connect Telegram in Settings"
          : !contact.handle
            ? "They haven’t linked Telegram"
            : undefined,
      // replace: Back from "Inviting" shouldn't reopen the menu
      run: () => contact.handle && void invite.send(contact.handle, contact.name, { replace: true }),
    },
    {
      key: "copy",
      label: "Copy invite link",
      disabled: !online,
      hint: online ? undefined : "Server is offline",
      icon: busy ? <Spinner size={18} /> : <LinkIcon size={20} strokeWidth={1.8} />,
      run: () => void start(contact, true),
    },
    {
      key: "rename",
      label: "Rename",
      icon: <PencilIcon size={19} strokeWidth={1.8} />,
      run: () => {
        renaming.set(contact.id);
        close();
      },
    },
    {
      key: "remove",
      label: "Remove from recents",
      icon: <TrashIcon size={20} strokeWidth={1.8} />,
      danger: true,
      run: () => {
        close();
        const undo = removeRecent(contact.id);
        toast(`${contact.name} removed`, { label: "Undo", run: undo });
      },
    },
  ];

  return (
    <AnimatePresence>
      {contact && actions && (
        <motion.div key="veil" className="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={m.sweep} onClick={close} />
      )}
      {contact &&
        actions &&
        (split ? (
          <Popover key="pop" contact={contact} actions={actions} />
        ) : (
          <motion.div
            key="sheet"
            className="sheet"
            initial={{ y: m.reduced ? 0 : "105%", opacity: m.reduced ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: m.reduced ? 0 : "105%", opacity: m.reduced ? 0 : 1 }}
            transition={m.morph}
          >
            <MenuCard contact={contact} actions={actions} />
            <Press className="sheet__cancel" onClick={close}>
              Cancel
            </Press>
          </motion.div>
        ))}
    </AnimatePresence>
  );
}

interface Action {
  key: string;
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  run: () => void;
}

function Popover({ contact, actions }: { contact: Contact; actions: Action[] }) {
  const m = useMotionSet();
  const at = useStore(anchor);
  const ref = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  // not enough room under the row: open above it
  useLayoutEffect(() => {
    const el = ref.current;
    const panel = el?.closest(".panel");
    if (!el || !panel || !at) return;
    setAbove(at.bottom + 22 + el.offsetHeight > panel.clientHeight - 12);
  }, [at]);
  const right = at ? `calc(100% - ${at.right + 12}px)` : 24;
  return (
    <motion.div
      ref={ref}
      className="pop"
      style={{
        right,
        top: at && !above ? at.bottom + 22 : undefined,
        bottom: at && above ? `calc(100% - ${at.top - 10}px)` : undefined,
        transformOrigin: above ? "100% 100%" : "100% 0%",
      }}
      variants={m.pop}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      <MenuCard contact={contact} actions={actions} />
    </motion.div>
  );
}

const ITEMS = "[role=menuitem]:not([aria-disabled=true])";

function MenuCard({ contact, actions }: { contact: Contact; actions: Action[] }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className="menu" role="menu" aria-label={contact.name} ref={list} onKeyDown={onKey}>
      <div className="menu__head">
        <Avatar name={contact.name} size={40} />
        <div>
          <p className="menu__name">{contact.name}</p>
          <p className="menu__meta">
            {contact.calls} {contact.calls === 1 ? "call" : "calls"} · {dayLabel(contact.lastCallAt)}
          </p>
        </div>
      </div>
      {actions.map((a) => (
        <Press
          key={a.key}
          role="menuitem"
          className="menu__item"
          data-danger={a.danger || undefined}
          aria-disabled={a.disabled || undefined}
          disabled={a.disabled}
          onClick={a.run}
        >
          <span className="menu__icon">{a.icon}</span>
          <span className="menu__label">
            {a.label}
            {a.hint && <span className="menu__hint">{a.hint}</span>}
          </span>
        </Press>
      ))}
    </div>
  );
}

function KoloIdInvite({ nav }: { nav: Nav }) {
  const m = useMotionSet();
  const tg = useStore(telegram);
  const list = useStore(recents);
  const { busy, send } = useInvite(nav);
  const online = useOnline();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [field, animate] = useAnimate<HTMLDivElement>();

  // unknown yet, or not set up: nothing to show
  if (!tg.ready) return null;
  if (!tg.handle) {
    return (
      <Row>
        <Press className="idlink" onClick={() => nav.push({ name: "settings" })} data-testid="connect-to-invite">
          <SendIcon size={15} strokeWidth={2} />
          Connect Telegram to invite by ID
        </Press>
      </Row>
    );
  }

  const fail = (text: string) => {
    setError(text);
    if (!m.reduced && field.current) animate(field.current, { x: [0, -8, 7, -5, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !online) return;
    const handle = normalizeHandle(value);
    if (!isHandle(handle)) return fail(`A Kolo ID is ${HANDLE_RULES}`);
    if (handle === tg.handle) return fail("That’s your own Kolo ID");
    const who = list.find((c) => c.handle === handle)?.name ?? handle;
    void send(handle, who);
  };

  return (
    <Row className="idinvite">
      <form onSubmit={submit} noValidate>
        <label htmlFor="kolo-id" className="idinvite__label">
          Invite by Kolo ID
        </label>
        <div ref={field} className="codefield codefield--id" data-error={error ? "" : undefined}>
          <span className="codefield__at" aria-hidden>
            @
          </span>
          <input
            id="kolo-id"
            data-testid="id-invite-input"
            placeholder="alex718"
            value={value}
            maxLength={21}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "kolo-id-error" : undefined}
          />
          <motion.span className="codefield__ring" initial={false} animate={{ opacity: error ? 1 : 0 }} transition={m.sweep} aria-hidden />
          <button
            type="submit"
            aria-label={online ? "Send invite" : OFFLINE_HINT}
            title={online ? undefined : OFFLINE_HINT}
            disabled={!online}
            aria-busy={busy ? true : undefined}
            data-testid="id-invite-send"
          >
            {busy ? <Spinner size={16} /> : <SendIcon size={17} strokeWidth={2} />}
          </button>
        </div>
      </form>
      <AnimatePresence initial={false}>
        {error && (
          <motion.p
            key={error}
            id="kolo-id-error"
            className="home__error"
            role="alert"
            initial={{ opacity: 0, y: m.reduced ? 0 : -4 }}
            animate={{ opacity: 1, y: 0, transition: m.sweep }}
            exit={{ opacity: 0, transition: m.leave }}
          >
            <span aria-hidden>×</span>
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </Row>
  );
}
