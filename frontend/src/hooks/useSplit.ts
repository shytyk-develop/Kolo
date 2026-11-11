"use client";

import { useSyncExternalStore } from "react";

// keep in sync with the split @media in zone.css
export const SPLIT_QUERY = "(min-width: 900px), (orientation: landscape) and (max-height: 560px) and (min-width: 560px)";

const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(SPLIT_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** Camera on the left, card on the right (wide screens and landscape phones). */
export function useSplit(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(SPLIT_QUERY).matches, () => true);
}
