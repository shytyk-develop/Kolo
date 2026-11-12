import { dbg } from "../debug";
import { createStore, readJson, writeJson } from "../store";
import type { InviteStatus } from "../types";
import { ApiError, telegramApi } from "./http";

export type { InviteStatus };

export interface TelegramState {
  // the server has Telegram set up; null = don't know yet
  ready: boolean | null;
  // my Kolo ID, null until linked
  handle: string | null;
}

// the last /me: shown at once, checked again in the background
const ME_KEY = "kolo.me.v1";
const UNKNOWN: TelegramState = { ready: null, handle: null };

export const telegram = createStore<TelegramState>(
  () => readJson<TelegramState>("local", ME_KEY) ?? UNKNOWN,
  UNKNOWN,
  (value) => writeJson("local", ME_KEY, value),
);

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export const normalizeHandle = (raw: string) => raw.trim().replace(/^@/, "").toLowerCase();
export const isHandle = (handle: string) => HANDLE_RE.test(handle);
export const HANDLE_RULES = "3–20 characters: a–z, 0–9 and _";

export const POLL_MS = 2500;

/** /me; on failure the last known answer stays. */
export async function refreshTelegram(): Promise<TelegramState> {
  try {
    const me = await telegramApi.me();
    const next = { ready: me.telegram, handle: me.handle ?? null };
    // same answer: no re-render
    telegram.set((t) => (t.ready === next.ready && t.handle === next.handle ? t : next));
  } catch {
    // offline or a blip: keep what we had
  }
  return telegram.get();
}

// ---------- linking ----------

// elsewhere: Back to Kolo opened in another browser
export type LinkPhase = "idle" | "waiting" | "expired" | "elsewhere";

// localStorage: a new tab (Back to Kolo) can finish the link too
const LINK_KEY = "kolo.tg-link";
interface Pending {
  token: string;
  until: number;
  deepLink: string;
}

const LINK_TTL_MS = 10 * 60_000;

function pending(): Pending | null {
  const p = readJson<Pending>("local", LINK_KEY);
  return p && p.until > Date.now() ? p : null;
}

export const linking = createStore<LinkPhase>(() => (pending() ? "waiting" : "idle"), "idle");
// when linking finished, for the card's success moment
export const linkedAt = createStore<number>(() => 0, 0);

// the Telegram tab we opened, closed once linked
let tgWindow: Window | null = null;
let running = false;

function settle(phase: LinkPhase) {
  writeJson("local", LINK_KEY, null);
  linking.set(phase);
}

function linked(handle: string) {
  telegram.set((t) => ({ ...t, handle }));
  settle("idle");
  linkedAt.set(Date.now());
  try {
    tgWindow?.close();
  } catch {
    // not ours to close anymore
  }
  tgWindow = null;
  window.focus();
}

// POLL_MS, or sooner when the tab is back in front
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
      const p = pending();
      if (!p) {
        // done in another tab, or ran out
        const handle = (await refreshTelegram()).handle;
        if (handle) return linked(handle);
        return settle(readJson("local", LINK_KEY) ? "expired" : "idle");
      }
      try {
        const status = await telegramApi.linkStatus(p.token);
        dbg("link: status", { status: status.status });
        if (status.status === "linked" && status.handle) return linked(status.handle);
        if (status.status === "expired") return settle("expired");
      } catch (err) {
        dbg("link: status failed", { code: err instanceof ApiError ? err.code : String(err) });
        // the link is gone, or another Connect replaced it; anything else is a blip
        if (err instanceof ApiError && (err.code === "link_not_found" || err.code === "link_other_browser")) {
          const handle = (await refreshTelegram()).handle;
          return handle ? linked(handle) : settle("expired");
        }
      }
      // linked in another tab: /me knows
      const handle = (await refreshTelegram()).handle;
      if (handle) return linked(handle);
      if (linking.get() !== "waiting") return;
      dbg("link: waiting", { handle });
      await nextTick();
    }
  } finally {
    running = false;
  }
}

// ---------- Connect: a real link, ready before the tap ----------
// phones open the Telegram app only for a link the person taps

interface Prepared {
  token: string;
  deepLink: string;
  until: number;
}

const PREPARED_KEY = "kolo.tg-prepared";
// not offered this close to expiry
const PREPARED_MARGIN_MS = 60_000;

const usable = (p: Prepared | null) => (p && p.until - Date.now() > PREPARED_MARGIN_MS ? p : null);

export const prepared = createStore<Prepared | null>(
  () => usable(readJson<Prepared>("local", PREPARED_KEY)),
  null,
  (value) => writeJson("local", PREPARED_KEY, value),
);

let preparing: Promise<void> | null = null;

/** A bot link for Connect; on failure Connect falls back to startLink. */
export function prepareLink(): Promise<void> {
  if (usable(prepared.get())) return Promise.resolve();
  preparing ??= (async () => {
    try {
      const link = await telegramApi.startLink();
      prepared.set({ token: link.token, deepLink: link.deep_link, until: Date.now() + link.expires_in * 1000 });
    } catch {
      prepared.set(null);
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

export const usablePrepared = () => usable(prepared.get());

/** t.me/<bot>?start=x -> tg://resolve?domain=<bot>&start=x, the app itself. */
export function appLink(deepLink: string): string | null {
  try {
    const url = new URL(deepLink);
    if (url.hostname !== "t.me") return null;
    const start = url.searchParams.get("start");
    return `tg://resolve?domain=${encodeURIComponent(url.pathname.slice(1))}${start ? `&start=${encodeURIComponent(start)}` : ""}`;
  } catch {
    return null;
  }
}

/** The same chat in Telegram Web, for a computer without the app. */
export function webLink(deepLink: string): string {
  const app = appLink(deepLink);
  return app ? `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(app)}` : deepLink;
}

// Chromium blocks t.me's own app launch (no tap there), so we launch it
const chromium = () =>
  /Chrome\/\d+/.test(navigator.userAgent) ||
  Boolean((navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands?.some((b) => b.brand === "Chromium"));

/** Phones follow the <a>; desktop Chromium launches tg:// here; others get our t.me window. */
export function openFromTap(event: { preventDefault: () => void }, url: string): void {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  const app = appLink(url);
  if (app && chromium()) {
    event.preventDefault();
    // a link click inside this click counts as the person's own
    const a = document.createElement("a");
    a.href = app;
    a.click();
    return;
  }
  const tab = window.open(url, "_blank");
  if (!tab) return;
  // the window opened: the <a> mustn't open a second one
  event.preventDefault();
  tgWindow = tab;
}

/** Connect was tapped on a prepared link: from now on we wait for the bot. */
export function beginLink(link: Prepared): void {
  writeJson("local", LINK_KEY, { token: link.token, until: link.until, deepLink: link.deepLink });
  prepared.set(null);
  linking.set("waiting");
  void poll();
}

/** The bot link of the link we're waiting for ("" when this tab only knows the token). */
export const waitingDeepLink = () => pending()?.deepLink ?? "";

/** Fallback when no link was ready: open a tab in the tap, point it at the bot once the link exists. */
export async function startLink(): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    tab?.document.write(
      '<meta name="viewport" content="width=device-width"><title>Telegram</title>' +
        '<p style="font:16px -apple-system,sans-serif;text-align:center;margin-top:40vh">Opening Telegram…</p>',
    );
  } catch {
    // not ours to write into
  }
  let link;
  try {
    link = await telegramApi.startLink();
  } catch (err) {
    tab?.close();
    throw err;
  }
  writeJson("local", LINK_KEY, { token: link.token, until: Date.now() + LINK_TTL_MS, deepLink: link.deep_link });
  linking.set("waiting");
  if (tab) {
    // keep the opener, or we can't close it later
    tab.location.href = link.deep_link;
    tgWindow = tab;
  }
  void poll();
}

/** A link started earlier (another tab, or before a reload): keep waiting for it. */
export function resumeLink(): void {
  if (linking.get() !== "waiting" && pending()) linking.set("waiting");
  if (linking.get() === "waiting") void poll();
}

export function cancelLink(): void {
  settle("idle");
}

// ---------- ?link=<token>: the bot's Back to Kolo ----------

/** Takes ?link= (and #settings) off the url, so a reload or Back can't replay it. */
export function takeLandingLink(): { token: string | null; settings: boolean } {
  if (typeof window === "undefined") return { token: null, settings: false };
  const url = new URL(window.location.href);
  const token = url.searchParams.get("link");
  const settings = url.hash === "#settings";
  if (!token && !settings) return { token: null, settings: false };
  url.searchParams.delete("link");
  url.hash = "";
  history.replaceState(history.state, "", url.pathname + url.search);
  return { token, settings: true };
}

/** Finish the link the bot sent back. Only works in the browser that pressed Connect (its cookie). */
export async function finishLanding(token: string): Promise<void> {
  linking.set("waiting");
  try {
    const status = await telegramApi.linkStatus(token);
    if (status.status === "linked" && status.handle) return linked(status.handle);
    if (status.status === "expired") return settle("expired");
    // no ID picked yet: wait like the Connect tab
    if (!pending()) writeJson("local", LINK_KEY, { token, until: Date.now() + LINK_TTL_MS, deepLink: "" });
    void poll();
  } catch (err) {
    const handle = (await refreshTelegram()).handle;
    if (handle) return linked(handle);
    if (err instanceof ApiError && err.code === "link_other_browser") return settle("elsewhere");
    if (err instanceof ApiError && err.code === "link_not_found") return settle("expired");
    settle("idle");
    throw err;
  }
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
