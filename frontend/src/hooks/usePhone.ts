"use client";

import { useSyncExternalStore } from "react";

// a phone: narrow, or a phone on its side (low). Same breakpoints as the css
const QUERY = "(max-width: 640px), (max-height: 500px)";

const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True on phone-sized screens: the call gets the bottom bar instead of the side island. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
