import { dbg } from "../debug";
import { reportOffline, reportOnline } from "../server";
import type { InviteStatus, JoinTicket, LinkStart, LinkStatus, Me, RoomCreated, RoomPublic } from "../types";

// the backend itself, for websockets only (they carry the join token, no cookies).
// Every http call goes to our own origin's /api, which next.config rewrites to the backend
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// a backend that's down can hang behind the /api proxy: give up fast and show "offline"
const TIMEOUT_MS = 4000;
// calls the backend passes on to Telegram (notify): slow there isn't "down" here
const SLOW_MS = 20_000;

interface Options {
  timeoutMs?: number;
  // a timeout here doesn't mean the server is down
  slow?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    // backend codes (room_not_found, ...) plus ours: offline, unreachable, timeout
    public code: string,
    message: string,
    // seconds, from Retry-After
    public retryAfter?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit, opts: Options = {}): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? (opts.slow ? SLOW_MS : TIMEOUT_MS));
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      signal: abort.signal,
      // never from a cache: a stale /me or health is worse than none
      cache: "no-store",
      // same origin: the httpOnly Telegram cookie rides along; js never sees it
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    // fetch only throws when there's no answer at all ("Load failed", "Failed to fetch")
    dbg("fetch failed", { path, error: String(err) });
    if (abort.signal.aborted) {
      if (!opts.slow) reportOffline();
      throw new ApiError(0, "timeout", "No answer from kolo. Try again in a moment.");
    }
    reportOffline();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError(0, "offline", "You’re offline. Check your connection and try again.");
    }
    throw new ApiError(0, "unreachable", "Can’t reach kolo right now. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // the /api proxy's own error page: the backend didn't answer
    if (!data && response.status >= 500) {
      reportOffline();
      throw new ApiError(response.status, "unreachable", "Can’t reach kolo right now. Try again in a moment.");
    }
    reportOnline();
    const error = data?.error ?? {};
    const retry = Number(response.headers.get("Retry-After")) || undefined;
    throw new ApiError(response.status, error.code ?? "http_error", error.message ?? "Server error", retry);
  }
  reportOnline();
  return (data ?? {}) as T;
}

export const api = {
  createRoom: (body: { name?: string; lobby_enabled?: boolean; max_participants?: number }) =>
    request<RoomCreated>("/rooms", { method: "POST", body: JSON.stringify(body) }),

  getRoom: (code: string) => request<RoomPublic>(`/rooms/${encodeURIComponent(code)}`),

  // host only
  updateRoom: (code: string, body: { host_secret: string; lobby_enabled: boolean }) =>
    request<RoomPublic>(`/rooms/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(body) }),

  // clientId: who I am across calls, the others' recents use it
  join: async (code: string, displayName: string, hostSecret?: string | null, clientId?: string) => {
    dbg("join: request");
    const ticket = await request<JoinTicket>(`/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({
        display_name: displayName,
        host_secret: hostSecret ?? undefined,
        client_id: clientId || undefined,
      }),
    });
    dbg("join: ticket", { ice: ticket.ice_servers.map((s) => s.urls) });
    return ticket;
  },
};

export const telegramApi = {
  me: () => request<Me>("/me"),
  startLink: () => request<LinkStart>("/me/telegram/link", { method: "POST" }, { slow: true }),
  linkStatus: (token: string) => request<LinkStatus>(`/me/telegram/link/${encodeURIComponent(token)}`, undefined, { slow: true }),
  unlink: () => request<void>("/me/telegram", { method: "DELETE" }, { slow: true }),
  // the caller is whoever this browser linked, the server reads it from the cookie
  invite: (code: string, target: string) =>
    request<{ status: InviteStatus }>(
      `/rooms/${encodeURIComponent(code)}/invite`,
      { method: "POST", body: JSON.stringify({ target }) },
      { slow: true },
    ),
};

export function wsUrl(ticket: JoinTicket): string {
  // http -> ws, https -> wss
  const base = API_URL.replace(/^http/, "ws");
  return `${base}${ticket.ws_path}?token=${encodeURIComponent(ticket.token)}`;
}

// host secret lives only in the creator's browser
export const hostSecrets = {
  save(code: string, secret: string) {
    try {
      localStorage.setItem(`kolo:host:${code}`, secret);
    } catch {}
  },
  get(code: string): string | null {
    // safari private mode can throw here
    try {
      return localStorage.getItem(`kolo:host:${code}`);
    } catch {
      return null;
    }
  },
};
