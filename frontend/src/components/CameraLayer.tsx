"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { useMedia } from "./MediaProvider";
import { Video } from "./Video";

/** A spot on the screen, px, with its corners (a css border-radius). */
export interface Spot {
  x: number;
  y: number;
  w: number;
  h: number;
  r: string;
}

type Fit = "cover" | "smart";

interface CameraApi {
  // go there: a live, smooth move (animate) or a jump; fit = how the picture fills it
  moveTo: (spot: Spot, opts?: { animate?: boolean; fit?: Fit }) => void;
  // fade in / out (or at once)
  show: (on: boolean, animate?: boolean) => void;
  visible: () => boolean;
}

const CameraContext = createContext<CameraApi | null>(null);

// one move, from the css (.camlayer[data-animate])
const MOVE_MS = 560;

const spotKey = (name: string) => `kolo:spot:${name}`;

/** Where a page last had the camera, so the way back can start before that page is there. */
export function rememberedSpot(name: string): Spot | null {
  try {
    return JSON.parse(sessionStorage.getItem(spotKey(name)) ?? "null");
  } catch {
    return null;
  }
}

/** The whole window, with the corners videos get there. */
export function fullSpot(): Spot {
  const r = getComputedStyle(document.documentElement).getPropertyValue("--video-r").trim() || "0px";
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, r };
}

/**
 * The camera as one live video for the whole app, above every page's background. Pages only
 * mark where it goes (useCameraSlot); between pages it moves and resizes itself, live, the
 * moment you tap: home's panel grows into the join screen and back, nothing is ever a still.
 * The call has its own videos; the camera hands over to them and steps aside (hidden).
 */
export function CameraLayer({ children }: { children: ReactNode }) {
  const media = useMedia();
  const [state, setState] = useState<{ spot: Spot | null; fit: Fit; animate: boolean; on: boolean }>({
    spot: null,
    fit: "cover",
    animate: false,
    on: false,
  });
  const [moving, setMoving] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const api = useMemo<CameraApi>(
    () => ({
      moveTo: (spot, opts = {}) => {
        const animate = Boolean(opts.animate);
        setState((s) => ({ ...s, spot, fit: opts.fit ?? s.fit, animate: animate || (s.animate && sameSpot(s.spot, spot)) }));
        if (animate) {
          // while it moves the picture keeps its fill, it re-decides once it's there
          setMoving(true);
          clearTimeout(moveTimer.current);
          moveTimer.current = setTimeout(() => setMoving(false), MOVE_MS + 40);
        }
      },
      show: (on, animate = true) => setState((s) => ({ ...s, on, animate: animate || s.animate })),
      visible: () => stateRef.current.on && stateRef.current.spot !== null,
    }),
    [],
  );

  const { spot, fit, animate, on } = state;
  return (
    <CameraContext value={api}>
      <div
        className="camlayer"
        data-animate={animate || undefined}
        data-moving={moving || undefined}
        data-on={(on && spot) || undefined}
        style={
          spot
            ? { left: spot.x, top: spot.y, width: spot.w, height: spot.h, borderRadius: spot.r }
            : { left: 0, top: 0, width: 0, height: 0 }
        }
        aria-hidden
      >
        {/* the fit follows the move: worked out for the spot it's heading to, in step with it */}
        <Video
          stream={media.stream}
          mirror
          fit={fit}
          box={spot ? { w: spot.w, h: spot.h } : null}
          zoomMs={MOVE_MS}
        />
      </div>
      {children}
    </CameraContext>
  );
}

const sameSpot = (a: Spot | null, b: Spot) => Boolean(a) && a!.x === b.x && a!.y === b.y && a!.w === b.w && a!.h === b.h;

export function useCamera(): CameraApi {
  const cam = useContext(CameraContext);
  if (!cam) throw new Error("useCamera outside CameraLayer");
  return cam;
}

/**
 * This element is where the camera goes on this page. Arriving from another page the camera
 * moves here smoothly (it's already on its way if the tap started it); on a fresh load it's
 * just there. Follows the element on resize. `name` remembers the spot for the way back.
 */
export function useCameraSlot(ref: RefObject<HTMLElement | null>, fit: Fit, name?: string) {
  const cam = useCamera();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = (animate: boolean) => {
      const r = el.getBoundingClientRect();
      const spot = { x: r.left, y: r.top, w: r.width, h: r.height, r: getComputedStyle(el).borderRadius };
      cam.moveTo(spot, { animate, fit });
      cam.show(true, animate);
      if (name) {
        try {
          sessionStorage.setItem(spotKey(name), JSON.stringify(spot));
        } catch {}
      }
    };
    place(cam.visible());
    // the first callback is just the observe itself
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) first = false;
      else place(false);
    });
    ro.observe(el);
    const onResize = () => place(false);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
    // the slot is placed once per page, then follows resizes
  }, []);
}

// home's camera panel when it was never measured in this tab (a room opened from a link)
function homeSpotGuess(): Spot {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = getComputedStyle(document.documentElement).getPropertyValue("--video-r").trim() || "0px";
  // phones: the top 60%; wide: everything left of the card
  if (vw <= 760) return { x: 0, y: 0, w: vw, h: vh * 0.6, r: `0 0 ${r} ${r}` };
  const card = Math.min(Math.max(360, vw * 0.29), 480) + 28;
  return { x: 0, y: 0, w: vw - card, h: vh, r: `0 ${r} ${r} 0` };
}

/**
 * Back home from a room: the camera starts gliding to its home panel on this very tap, the
 * home page then finds it there and slides its card back in.
 * from: "here" = the camera is on screen already (the join screen); "full" = put it over the
 * whole screen first, under the call fading away (I was the big one); "hidden" = it appears on
 * its home spot, fading in (the other person was the big one)
 */
export function leaveHome(cam: CameraApi, router: { push: (href: string) => void }, from: "here" | "full" | "hidden") {
  const home = rememberedSpot("home") ?? homeSpotGuess();
  const twoFrames = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));
  if (from === "full") {
    cam.moveTo(fullSpot(), { animate: false });
    cam.show(true, false);
    twoFrames(() => cam.moveTo(home, { animate: true, fit: "cover" }));
  } else if (from === "hidden") {
    cam.moveTo(home, { animate: false, fit: "cover" });
    twoFrames(() => cam.show(true, true));
  } else {
    cam.moveTo(home, { animate: true, fit: "cover" });
  }
  try {
    sessionStorage.setItem("kolo:back-home", "1");
  } catch {}
  // the page changes once the room's own things are out of the way (the camera doesn't wait):
  // the join screen's bar sinking, or the call fading
  setTimeout(() => router.push("/"), from === "here" ? 300 : 160);
}
