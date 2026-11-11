import { api, hostSecrets } from "./api/http";
import { lastCall, profile, rememberCall, type Person } from "./people";
import { readJson, writeJson } from "./store";
import type { JoinTicket } from "./types";

const ticketKey = (code: string) => `kolo:ticket:${code}`;

// the call page takes the seat the home screen got: same participant, no second admit
export function stashTicket(code: string, ticket: JoinTicket) {
  writeJson("session", ticketKey(code), { ticket, until: Date.now() + ticket.expires_in * 1000 });
}

export function storedTicket(code: string): JoinTicket | null {
  const saved = readJson<{ ticket: JoinTicket; until: number }>("session", ticketKey(code));
  // a minute left at least, or it dies mid-connect
  if (!saved || saved.until - Date.now() < 60_000) return null;
  return saved.ticket;
}

export function dropTicket(code: string) {
  writeJson("session", ticketKey(code), null);
}

/** A seat in the room (host if this browser made it), kept for the call page. */
export async function joinRoom(code: string, name: string): Promise<JoinTicket> {
  const ticket = await api.join(code, name, hostSecrets.get(code), profile.get().id);
  stashTicket(code, ticket);
  return ticket;
}

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

// same call if it's the same room and it didn't end: a rejoin goes on with it
function current(code: string) {
  const prev = lastCall.get();
  return prev && prev.code === code && prev.status !== "ended" ? prev : null;
}

/** What the call page tells the home screen about the call. */
export const callLog = {
  live(code: string, peer: Person | null, connectedAt: number | null) {
    const prev = current(code);
    lastCall.set({
      id: prev?.id ?? newId(),
      code,
      peer: peer ?? prev?.peer ?? null,
      startedAt: prev?.startedAt ?? connectedAt,
      status: "live",
    });
  },

  // show: open "Connection lost" on home; otherwise just the dropped banner
  dropped(code: string, peer: Person | null, connectedAt: number | null, show: boolean) {
    const prev = current(code);
    const id = prev?.id ?? newId();
    const startedAt = prev?.startedAt ?? connectedAt;
    const who = peer ?? prev?.peer ?? null;
    const now = Date.now();
    // counts as a call already: they may never come back
    const saved = who && startedAt ? rememberCall(who, now - startedAt, id) : false;
    lastCall.set({ id, code, peer: who, startedAt, status: "dropped", droppedAt: now, attempt: prev?.attempt ?? 0, saved, show: show ? "lost" : undefined });
  },

  ended(code: string, peer: Person | null, connectedAt: number | null, endedAt = Date.now()) {
    const prev = current(code);
    const id = prev?.id ?? newId();
    const startedAt = prev?.startedAt ?? connectedAt;
    const who = peer ?? prev?.peer ?? null;
    const talked = Boolean(who && startedAt);
    const saved = talked ? rememberCall(who!, endedAt - startedAt!, id) : false;
    lastCall.set({ id, code, peer: who, startedAt, status: "ended", endedAt, saved, show: talked ? "ended" : undefined });
  },
};
