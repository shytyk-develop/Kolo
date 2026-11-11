"use client";

import { useSyncExternalStore } from "react";

// same breakpoints as the css
const QUERY = "(max-width: 640px), (max-height: 500px)";

const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** Phone-sized screen: bottom bar instead of the side island. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

export type PortSide = "bottom" | "left" | "right";

function portSide(): PortSide {
  if (window.innerWidth <= window.innerHeight) return "bottom";
  // 90: port on the right, -90 / 270: on the left
  const legacy = (window as { orientation?: unknown }).orientation;
  const angle =
    typeof legacy === "number" ? legacy : (screen.orientation?.angle ?? 0);
  const a = ((angle % 360) + 360) % 360;
  if (a === 90) return "right";
  if (a === 270) return "left";
  // a low desktop window: no port
  return "bottom";
}

const subscribePort = (cb: () => void) => {
  window.addEventListener("resize", cb);
  window.addEventListener("orientationchange", cb);
  screen.orientation?.addEventListener("change", cb);
  return () => {
    window.removeEventListener("resize", cb);
    window.removeEventListener("orientationchange", cb);
    screen.orientation?.removeEventListener("change", cb);
  };
};

/** Side of the charging port, the call bar goes there. */
export function usePortSide(): PortSide {
  return useSyncExternalStore(subscribePort, portSide, () => "bottom");
}
