import { dbg } from "../debug";
import type { JoinTicket, RoomCreated, RoomPublic } from "../types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// a server that hangs must not keep a button spinning forever
const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    // backend codes (room_not_found, ...) plus ours: offline, unreachable, timeout
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      signal: abort.signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    // fetch only throws when there's no answer at all ("Load failed", "Failed to fetch")
    dbg("fetch failed", { path, error: String(err) });
    if (abort.signal.aborted) throw new ApiError(0, "timeout", "No answer from kolo. Try again in a moment.");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new ApiError(0, "offline", "You’re offline. Check your connection and try again.");
    }
    throw new ApiError(0, "unreachable", "Can’t reach kolo right now. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? {};
    throw new ApiError(response.status, error.code ?? "http_error", error.message ?? "Server error");
  }
  return data as T;
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
