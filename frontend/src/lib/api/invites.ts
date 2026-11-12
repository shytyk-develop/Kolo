import { createStore, readJson, writeJson } from "../store";
import type { InviteStatus } from "../types";
import { ApiError, telegramApi } from "./http";

export type { InviteStatus };

export interface TelegramState {
  // the server has Telegram set up
  ready: boolean;
  // my Kolo ID, null until linked
  handle: string | null;
}

export const telegram = createStore<TelegramState>(() => ({ ready: false, handle: null }), { ready: false, handle: null });

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export const normalizeHandle = (raw: string) => raw.trim().replace(/^@/, "").toLowerCase();
export const isHandle = (handle: string) => HANDLE_RE.test(handle);
export const HANDLE_RULES = "3–20 characters: a–z, 0–9 and _";

export const POLL_MS = 2500;

/** Ask the server what's set up and who this browser is. Quiet on failure: Telegram just stays off. */
export async function refreshTelegram(): Promise<TelegramState> {
  try {
    const me = await telegramApi.me();
    telegram.set({ ready: me.telegram, handle: me.handle ?? null });
  } catch {
    // keep what we had
  }
  return telegram.get();
}

// ---------- linking: Settings → the bot in Telegram → back here ----------

export type LinkPhase = "idle" | "waiting" | "expired";

// the token survives a reload: phones often drop the tab while Telegram is in front
const LINK_KEY = "kolo:tg-link";
interface Pending {
  token: string;
  until: number;
}

export const linking = createStore<LinkPhase>(() => (readJson<Pending>("session", LINK_KEY) ? "waiting" : "idle"), "idle");

let running = false;

function finish(phase: LinkPhase) {
  writeJson("session", LINK_KEY, null);
  linking.set(phase);
}

// the next poll: after POLL_MS, or right away when the tab is back in front
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", done);
      resolve();
    };
    const onVisible = () => document.visibilityState === "visible" && done();
    const timer = setTimeout(done, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", done);
  });
}

async function poll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (linking.get() === "waiting") {
      const pending = readJson<Pending>("session", LINK_KEY);
      if (!pending || Date.now() > pending.until) return finish(pending ? "expired" : "idle");
      try {
        const status = await telegramApi.linkStatus(pending.token);
        if (status.status === "linked" && status.handle) {
          telegram.set((t) => ({ ...t, handle: status.handle! }));
          return finish("idle");
        }
        if (status.status === "expired") return finish("expired");
      } catch (err) {
        // the link is gone (or this browser never asked for it); anything else is a blip
        if (err instanceof ApiError && err.code === "link_not_found") return finish("expired");
      }
      // /me may know already (linked in another tab): show it at once
      if ((await refreshTelegram()).handle) return finish("idle");
      if (linking.get() !== "waiting") return;
      await nextTick();
    }
  } finally {
    running = false;
  }
}

/** Opens the bot in a new tab and waits for it. Call from the tap itself (popup blockers). */
export async function startLink(): Promise<void> {
  const tab = window.open("", "_blank");
  let link;
  try {
    link = await telegramApi.startLink();
  } catch (err) {
    tab?.close();
    throw err;
  }
  writeJson("session", LINK_KEY, { token: link.token, until: Date.now() + link.expires_in * 1000 });
  linking.set("waiting");
  if (tab) tab.location.href = link.deep_link;
  else window.location.href = link.deep_link;
  void poll();
}

/** A link started before a reload: keep waiting for it. */
export function resumeLink(): void {
  if (linking.get() === "waiting") void poll();
}

export function cancelLink(): void {
  finish("idle");
}

export async function disconnectTelegram(): Promise<void> {
  await telegramApi.unlink();
  telegram.set((t) => ({ ...t, handle: null }));
}

export async function inviteByHandle(code: string, handle: string): Promise<InviteStatus> {
  try {
    return (await telegramApi.invite(code, handle)).status;
  } catch (err) {
    // the server forgot the link: show Settings' Connect again
    if (err instanceof ApiError && err.code === "telegram_not_linked") telegram.set((t) => ({ ...t, handle: null }));
    throw err;
  }
}
