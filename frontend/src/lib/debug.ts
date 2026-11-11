/**
 * Call timeline for debugging, off unless localStorage "kolo:debug" is set.
 * Every line: ms since the page opened, what happened, details. Printed to the console and
 * kept in window.__kolo (an array), so a test or you in devtools can read the whole story:
 *   localStorage.setItem("kolo:debug", "1"), reload, make a call, then copy(window.__kolo)
 */

export interface DebugLine {
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

declare global {
  interface Window {
    __kolo?: DebugLine[];
    // debug only: cut the signaling socket like a network drop would
    __koloDrop?: () => void;
  }
}

/** Debug mode is on (the same flag as the timeline). */
export function debugOn(): boolean {
  return on();
}

let enabled: boolean | null = null;

function on(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = typeof window !== "undefined" && Boolean(localStorage.getItem("kolo:debug"));
  } catch {
    enabled = false;
  }
  return enabled;
}

// first time each event happened, for "first ICE candidate" and the like
const seen = new Set<string>();

export function dbg(event: string, data?: Record<string, unknown>): void {
  if (!on()) return;
  const line: DebugLine = { t: Math.round(performance.now()), event, data };
  (window.__kolo ??= []).push(line);
  console.info(`[kolo +${line.t}ms] ${event}`, data ?? "");
}

/** Same as dbg, but only the first time this event fires (per page). */
export function dbgOnce(event: string, data?: Record<string, unknown>): void {
  if (!on() || seen.has(event)) return;
  seen.add(event);
  dbg(event, data);
}
