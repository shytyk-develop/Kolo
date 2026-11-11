import { dbg } from "./debug";
import type { JoinTicket, RoomCreated, RoomPublic } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? {};
    throw new ApiError(response.status, error.code ?? "http_error", error.message ?? "Network error");
  }
  return data as T;
}

export const api = {
  createRoom: (body: { name?: string; lobby_enabled?: boolean; max_participants?: number }) =>
    request<RoomCreated>("/rooms", { method: "POST", body: JSON.stringify(body) }),

  getRoom: (code: string) => request<RoomPublic>(`/rooms/${encodeURIComponent(code)}`),

  join: async (code: string, displayName: string, hostSecret?: string | null) => {
    dbg("join: request");
    const ticket = await request<JoinTicket>(`/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({ display_name: displayName, host_secret: hostSecret ?? undefined }),
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
