import { createStore, useStore } from "./store";

// offline = no answer from the backend (network, proxy 5xx, timeout)
export type ServerStatus = "online" | "offline";

export const server = createStore<ServerStatus>(() => "online", "online");

const HEALTH = "/api/v1/health";
const PROBE_TIMEOUT_MS = 3000;
// then every 5s
const PROBE_DELAYS = [1000, 2000, 3000];

const backListeners = new Set<() => void>();

/** Runs every time the server comes back after being offline. */
export function onServerBack(listener: () => void): () => void {
  backListeners.add(listener);
  return () => backListeners.delete(listener);
}

export function reportOnline(): void {
  if (server.get() === "online") return;
  server.set("online");
  backListeners.forEach((l) => l());
}

export function reportOffline(): void {
  if (server.get() === "offline") return;
  server.set("offline");
  void probeUntilBack();
}

async function probe(): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(HEALTH, { cache: "no-store", signal: abort.signal });
    return r.ok && (await r.json().catch(() => null))?.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ends early on focus, visibility or the network coming back
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("focus", done);
      window.removeEventListener("online", done);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => document.visibilityState === "visible" && done();
    const timer = setTimeout(done, ms);
    window.addEventListener("focus", done);
    window.addEventListener("online", done);
    document.addEventListener("visibilitychange", onVisible);
  });
}

let probing = false;

async function probeUntilBack(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    for (let i = 0; server.get() === "offline"; i++) {
      await wait(PROBE_DELAYS[i] ?? 5000);
      if (server.get() !== "offline") return;
      if (await probe()) return reportOnline();
    }
  } finally {
    probing = false;
  }
}

export const OFFLINE_HINT = "Server is offline. Kolo reconnects by itself.";

export function useOnline(): boolean {
  return useStore(server) === "online";
}
