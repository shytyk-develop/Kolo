import { createStore } from "../store";
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

/** Opens the bot in a new tab and waits until it says who they are. null = gave up or expired. */
export async function connectTelegram(signal: AbortSignal): Promise<string | null> {
  // opened inside the tap, or the popup blocker eats it
  const tab = window.open("", "_blank");
  let link;
  try {
    link = await telegramApi.startLink();
  } catch (err) {
    tab?.close();
    throw err;
  }
  if (tab) tab.location.href = link.deep_link;
  else window.location.href = link.deep_link;

  const until = Date.now() + link.expires_in * 1000;
  while (!signal.aborted && Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (signal.aborted) break;
    try {
      const status = await telegramApi.linkStatus(link.token);
      if (status.status === "linked" && status.handle) {
        telegram.set((t) => ({ ...t, handle: status.handle! }));
        return status.handle;
      }
      if (status.status === "expired") return null;
    } catch (err) {
      // a blip: keep polling; the link itself gone: stop
      if (err instanceof ApiError && err.status === 404) return null;
    }
  }
  return null;
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
