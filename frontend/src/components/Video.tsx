"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
  stream: MediaStream | null;
  mirror?: boolean;
  className?: string;
  // fit: "cover" fills the box (crops); "smart" fills it when the shapes are close, and when
  // they are far apart (a wide video on a tall phone) shows the whole picture over a blurred
  // copy of itself, so nobody is cut in half
  fit?: "cover" | "smart";
}

// cropping more than this much of the picture is too much: show it whole instead
const MAX_CROP = 0.22;
// ... but not as a thin strip: the whole picture is zoomed in from the center until this
// much of it is cut off the sides (or top and bottom), the faces in the middle stay
const SIDE_CROP = 0.45;

// always muted: sound goes through one <audio>, or copies of the same video would play it twice
export const Video = memo(function Video({ stream, mirror, className, fit = "cover" }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const backdrop = useRef<HTMLVideoElement>(null);
  // hidden until the first frame, so a new <video> fades in instead of flashing black
  const [ready, setReady] = useState(false);
  // whole = the whole picture (contain) zoomed in by `zoom`; otherwise it fills the box (cover).
  // Contain zoomed by 1 / fit looks exactly like cover, so switching between the two is
  // invisible and the change is a smooth zoom (instant = that invisible switch frame)
  const [view, setView] = useState({ whole: false, zoom: 1, instant: false });
  const viewRef = useRef(view);
  viewRef.current = view;
  const { whole, zoom } = view;
  // the very first decision just applies: a picture showing up doesn't zoom around
  const decided = useRef(false);

  // srcObject can't be a jsx attribute. Layout effect: attached in the same commit, so a
  // fresh element (a new page) gets its first frame as early as possible
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    setReady(Boolean(stream) && el.readyState >= 2);
  }, [stream]);

  // smart fit: compare the picture's shape with the box's, again whenever either changes
  // (the other side turns the phone, the window resizes, split view). Never while the box is
  // being moved around (a split change, a swipe, a swap): decided once it has settled
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let leave: ReturnType<typeof setTimeout> | undefined;
    let later: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    // how much of the picture "fill the box" keeps (1 = same shape)
    const shape = () => {
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      if (!vw || !vh || !bw || !bh) return null;
      return Math.min(vw / vh / (bw / bh), bw / bh / (vw / vh));
    };
    // back to filling the box: zoom up until it fills, then switch (looks the same)
    const toCover = () => {
      const v = viewRef.current;
      if (!v.whole) return;
      const f = shape();
      setView({ whole: true, zoom: f ? 1 / f : v.zoom, instant: false });
      clearTimeout(leave);
      leave = setTimeout(() => setView({ whole: false, zoom: 1, instant: false }), 440);
    };
    // to the whole picture: switch at the zoom that looks like cover, then zoom out to z
    const toWhole = (z: number, cover: number, initial: boolean) => {
      clearTimeout(leave);
      const v = viewRef.current;
      if (initial) {
        setView({ whole: true, zoom: Number(z.toFixed(3)), instant: true });
        raf = requestAnimationFrame(() => setView((x) => ({ ...x, instant: false })));
        return;
      }
      if (v.whole) {
        if (Math.abs(v.zoom - z) > 0.005) setView({ whole: true, zoom: z, instant: false });
        return;
      }
      setView({ whole: true, zoom: cover, instant: true });
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setView({ whole: true, zoom: Number(z.toFixed(3)), instant: false })),
      );
    };
    const decide = () => {
      if (el.closest("[data-staging], [data-sliding], [data-swapping]")) {
        clearTimeout(later);
        later = setTimeout(decide, 150);
        return;
      }
      const f = shape();
      if (!f) return;
      const initial = !decided.current;
      decided.current = true;
      // cropping that much is fine (or asked to fill): fill the box
      if (fit !== "smart" || 1 - f <= MAX_CROP) return toCover();
      toWhole(Math.min(1 / f, 1 / (1 - SIDE_CROP)), 1 / f, initial);
    };
    decide();
    el.addEventListener("resize", decide);
    el.addEventListener("loadedmetadata", decide);
    const ro = new ResizeObserver(decide);
    ro.observe(el);
    return () => {
      el.removeEventListener("resize", decide);
      el.removeEventListener("loadedmetadata", decide);
      ro.disconnect();
      clearTimeout(leave);
      clearTimeout(later);
      cancelAnimationFrame(raf);
    };
  }, [fit]);

  // the blurred copy behind a whole picture
  useLayoutEffect(() => {
    const el = backdrop.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream, whole]);

  const cls = `video${mirror ? " video--mirror" : ""}${ready ? " video--ready" : ""}${className ? ` ${className}` : ""}`;
  return (
    <>
      <video
        ref={ref}
        className={cls}
        data-fit={whole ? "contain" : undefined}
        data-fit-instant={(whole && view.instant) || undefined}
        style={whole ? ({ "--zoom": zoom } as React.CSSProperties) : undefined}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        onLoadedData={() => setReady(true)}
        onPlaying={() => setReady(true)}
        onEmptied={() => setReady(false)}
      />
      {whole && <video ref={backdrop} className={`${cls} video--backdrop`} autoPlay playsInline muted aria-hidden />}
    </>
  );
});

/** Plays the other side's sound. */
export function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}
