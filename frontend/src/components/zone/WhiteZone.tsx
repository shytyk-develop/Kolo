"use client";

import { AnimatePresence, MotionConfig } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { fullSpot, useCamera } from "@/components/CameraLayer";
import { BackIcon, PlusIcon } from "@/components/Icons";
import { useMedia } from "@/components/MediaProvider";
import { useSplit } from "@/hooks/useSplit";
import { useViews, type Nav, type View } from "@/hooks/useViews";
import { reconnect, refreshTelegram, roomGone } from "@/lib/api";
import { DROPPED_SHOWN_MS, lastCall, type LastCall } from "@/lib/people";
import { useStore } from "@/lib/store";

import { CallEndedView, ConnectionLostView } from "./CallViews";
import { CameraStage, type CamSize } from "./CameraStage";
import { DevPanel } from "./DevPanel";
import { HomeView } from "./HomeView";
import { ensureName, NameSheet } from "./NameSheet";
import { ContactMenu, NewMeetingView } from "./NewMeetingView";
import { GuestWaitView, HostLobbyView, InvitingView, RoomReadyView } from "./RoomViews";
import { SettingsView } from "./SettingsView";
import { Tab, type TabPos } from "./Tab";
import { ToastHost } from "./ui";
import { ZoneContext, type ZoneApi } from "./ZoneContext";

import "./zone.css";

const IS_DEV = process.env.NODE_ENV !== "production";
// the card is out of the way before the page changes (the camera doesn't wait)
const PAGE_SWAP_MS = 160;

const back = <BackIcon size={22} strokeWidth={2.4} />;

interface TabSpec {
  pos: TabPos;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  testId?: string;
}

function tabFor(view: View, banner: boolean, nav: Nav, call: LastCall | null): TabSpec {
  switch (view.name) {
    case "home":
      return {
        pos: banner ? "banner" : "home",
        label: "New meeting",
        icon: <PlusIcon size={20} strokeWidth={2.2} />,
        onClick: () => nav.push({ name: "new" }),
        testId: "new-meeting",
      };
    case "new":
    case "ready":
      return { pos: "top", label: "New meeting", icon: back, onClick: nav.back, ariaLabel: "Back" };
    case "inviting":
      return { pos: "top", label: "Back", icon: back, onClick: nav.back };
    case "host":
      return { pos: "top", label: `Room ${view.code}`, icon: back, onClick: nav.back, ariaLabel: `Leave room ${view.code}` };
    case "guest":
      return { pos: "top", label: "Leave", icon: back, onClick: nav.back };
    case "lost": {
      const peer = call?.code === view.code ? call.peer?.name : null;
      return { pos: "top", label: peer ? `Call with ${peer}` : `Room ${view.code}`, icon: back, onClick: nav.home, ariaLabel: "Home" };
    }
    case "ended":
      return { pos: "top", label: "Home", icon: back, onClick: nav.home };
    case "settings":
      return { pos: "top", label: "Settings", icon: back, onClick: nav.back, ariaLabel: "Back from settings" };
  }
}

function renderView(view: View, nav: Nav, banner: LastCall | null) {
  const props = { nav, dir: nav.dir };
  switch (view.name) {
    case "home":
      return <HomeView key="home" {...props} banner={banner} />;
    case "new":
      return <NewMeetingView key="new" {...props} />;
    case "ready":
      return <RoomReadyView key="ready" {...props} view={view} />;
    case "inviting":
      return <InvitingView key="inviting" {...props} view={view} />;
    case "host":
      return <HostLobbyView key="host" {...props} view={view} />;
    case "guest":
      return <GuestWaitView key="guest" {...props} view={view} />;
    case "lost":
      return <ConnectionLostView key="lost" {...props} view={view} />;
    case "ended":
      return <CallEndedView key="ended" {...props} view={view} />;
    case "settings":
      return <SettingsView key="settings" {...props} />;
  }
}

const droppedRecently = (call: LastCall | null): call is LastCall =>
  Boolean(call && call.status === "dropped" && call.droppedAt && Date.now() - call.droppedAt < DROPPED_SHOWN_MS);

/**
 * The home route: camera on one side, the white card on the other, every screen before and
 * after a call. One view state drives the tab, the camera size and the card content.
 */
// back from the call page with something to show: "Connection lost" or "Call ended", shown first
function screenFromCall(): View | null {
  const c = lastCall.get();
  if (!c?.show) return null;
  lastCall.set({ ...c, show: undefined });
  return { name: c.show, code: c.code };
}

export function WhiteZone() {
  const nav = useViews(screenFromCall);
  const media = useMedia();
  const split = useSplit();
  const call = useStore(lastCall);
  const router = useRouter();
  const cam = useCamera();
  const { view } = nav;
  const banner = view.name === "home" && droppedRecently(call) ? call : null;
  const size: CamSize = view.name === "home" ? (banner ? "banner" : "home") : "view";
  const tab = tabFor(view, Boolean(banner), nav, call);
  const panel = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);

  const { start } = media;
  useEffect(() => {
    void start();
  }, [start]);

  // what the server says about Telegram: turns the invite parts on
  useEffect(() => {
    void refreshTelegram();
  }, []);

  // the dropped call's room may be gone by now: then there's nothing to go back to
  const bannerCode = banner?.code;
  useEffect(() => {
    if (!bannerCode) return;
    let alive = true;
    reconnect(bannerCode).catch((err) => {
      if (alive && roomGone(err)) lastCall.set(null);
    });
    return () => {
      alive = false;
    };
  }, [bannerCode]);

  // into the real call: the camera grows from its spot here to the whole screen, the card slides away
  const enterCall = useCallback(
    (code: string) => {
      setLeaving(true);
      const win = document.querySelector<HTMLElement>(".stage__window");
      if (win) {
        const r = win.getBoundingClientRect();
        cam.moveTo({ x: r.left, y: r.top, w: r.width, h: r.height, r: getComputedStyle(win).borderRadius }, { animate: false, fit: "cover" });
        cam.show(true, false);
        requestAnimationFrame(() => requestAnimationFrame(() => cam.moveTo(fullSpot(), { animate: true, fit: "smart" })));
      }
      try {
        sessionStorage.setItem("kolo:back-home", "1");
      } catch {}
      setTimeout(() => router.push(`/r/${code}`), PAGE_SWAP_MS);
    },
    [cam, router],
  );
  const zone = useMemo<ZoneApi>(() => ({ enterCall, ensureName }), [enterCall]);

  // idle warm-up: the first real tap shouldn't pay for compiling these screens
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const idle = (cb: () => void) =>
      "requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 2500 }) : setTimeout(cb, 1200);
    const id = idle(() => setWarm(true));
    return () => ("cancelIdleCallback" in window ? cancelIdleCallback(id as number) : clearTimeout(id));
  }, []);
  useEffect(() => {
    if (!warm) return;
    const id = setTimeout(() => setWarm(false), 300);
    return () => clearTimeout(id);
  }, [warm]);

  // the screen changed under the focus (its button is gone): give it to the tab
  const shownView = useRef(view.name);
  useEffect(() => {
    if (shownView.current === view.name) return;
    shownView.current = view.name;
    const raf = requestAnimationFrame(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) panel.current?.querySelector<HTMLElement>(".tab")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [view.name]);

  return (
    <MotionConfig reducedMotion="user">
      <ZoneContext value={zone}>
        <main className="wz" data-view={view.name} data-leaving={leaving || undefined} inert={leaving}>
          <CameraStage size={size} scrim={view.name === "lost"} />
          <div ref={panel} className="panel">
            {/* a screen shown first (epoch) just appears: no morph, no transition into it */}
            <Tab key={`tab:${nav.epoch}`} {...tab} />
            <div className="panel__views">
              <AnimatePresence key={nav.epoch} mode="popLayout" initial={false} custom={nav.dir}>
                {renderView(view, nav, banner)}
              </AnimatePresence>
            </div>
            <div className="panel__over">
              <ContactMenu nav={nav} split={split} />
              <NameSheet />
            </div>
            <ToastHost />
            {warm && view.name === "home" && (
              <div className="panel__warm" aria-hidden inert>
                <NewMeetingView nav={nav} dir={1} />
                <SettingsView nav={nav} dir={1} />
              </div>
            )}
          </div>
          {IS_DEV && <DevPanel />}
        </main>
      </ZoneContext>
    </MotionConfig>
  );
}
