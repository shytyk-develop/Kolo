import { joinRoom, stashTicket, storedTicket } from "../calls";
import { SignalingClient } from "../signaling";
import type { JoinTicket, ServerMessage } from "../types";
import { RECONNECT_DELAYS } from "./call";
import { closeError } from "./errors";
import { ApiError, wsUrl } from "./http";

export interface Knock {
  id: string;
  name: string;
  at: number;
}

export interface LobbyEvents {
  change: (queue: Knock[]) => void;
  error: (err: unknown) => void;
}

// a seat that's still good, or a new one
async function seat(code: string, name: string, role?: "host"): Promise<JoinTicket> {
  const kept = storedTicket(code);
  if (kept && (!role || kept.role === role)) return kept;
  return joinRoom(code, name);
}

// 4xxx = the server said no for good, anything else is worth another try
const final = (code: number) => code >= 4000 && code < 5000;

/** Host side of the waiting room: who's knocking, admit, deny. */
export class HostLobby {
  private client: SignalingClient | null = null;
  private ticket: JoinTicket | null = null;
  private stopped = false;
  private tries = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private queue: Knock[] = [];

  constructor(
    private code: string,
    private name: string,
    private on: LobbyEvents,
  ) {}

  async open(): Promise<void> {
    try {
      this.ticket = await seat(this.code, this.name, "host");
    } catch (err) {
      if (!this.stopped) this.on.error(err);
      return;
    }
    if (this.ticket.role !== "host") {
      this.on.error(new ApiError(403, "forbidden", "Only the host can do that"));
      return;
    }
    this.connect();
  }

  private connect() {
    if (this.stopped || !this.ticket) return;
    const client = new SignalingClient(
      wsUrl(this.ticket),
      (msg) => this.onMessage(msg),
      (code) => this.onClose(code),
    );
    this.client = client;
    client.connect();
  }

  private set(queue: Knock[]) {
    this.queue = queue;
    this.on.change(queue);
  }

  private onMessage(msg: ServerMessage) {
    if (msg.type === "welcome") {
      this.tries = 0;
      this.set((msg.lobby ?? []).map((p) => ({ id: p.id, name: p.name, at: Date.now() })));
    } else if (msg.type === "lobby-request") {
      const knock = { id: msg.peer.id, name: msg.peer.name, at: Date.now() };
      this.set([...this.queue.filter((k) => k.id !== knock.id), knock]);
    } else if (msg.type === "lobby-left") {
      this.set(this.queue.filter((k) => k.id !== msg.peer_id));
    }
  }

  private onClose(code: number) {
    if (this.stopped) return;
    if (final(code) || this.tries >= RECONNECT_DELAYS.length) {
      this.on.error(final(code) ? closeError(code) : new ApiError(0, "unreachable", "Lost the connection"));
      return;
    }
    this.retry = setTimeout(() => this.connect(), RECONNECT_DELAYS[this.tries++]);
  }

  admit(id: string) {
    this.client?.send({ type: "admit", peer_id: id });
    this.set(this.queue.filter((k) => k.id !== id));
  }

  deny(id: string) {
    this.client?.send({ type: "deny", peer_id: id });
    this.set(this.queue.filter((k) => k.id !== id));
  }

  /** Into the call: the call page joins with this same seat (a plain bye here, so it's the one newcomer). */
  handOff() {
    this.stopped = true;
    clearTimeout(this.retry);
    // exactly the seat this socket used
    if (this.ticket) stashTicket(this.code, this.ticket);
    this.client?.close();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.client?.close();
  }
}

export function openLobby(code: string, name: string, on: LobbyEvents): HostLobby {
  const lobby = new HostLobby(code, name, on);
  void lobby.open();
  return lobby;
}

export function admitGuest(lobby: HostLobby, guestId: string) {
  lobby.admit(guestId);
}

export function denyGuest(lobby: HostLobby, guestId: string) {
  lobby.deny(guestId);
}

/**
 * Guest side: knock and wait. Resolves when the host lets me in, with a way to hand the seat to
 * the call page; throws "denied" if they don't. Leaving (abort) tells the host I'm gone.
 */
export async function waitForAdmission(
  code: string,
  name: string,
  opts: { onWaiting: () => void; signal: AbortSignal },
): Promise<{ handOff: () => void }> {
  const ticket = await seat(code, name);
  if (opts.signal.aborted) throw opts.signal.reason;
  return new Promise((resolve, reject) => {
    let client: SignalingClient | null = null;
    let settled = false;
    let denied = false;
    let tries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(retry);
      fn();
    };
    const connect = () => {
      client = new SignalingClient(
        wsUrl(ticket),
        (msg) => {
          if (msg.type === "lobby") opts.onWaiting();
          else if (msg.type === "welcome") {
            done(() =>
              resolve({
                // admitted stays with the seat: the call page goes straight in
                handOff: () => {
                  stashTicket(code, ticket);
                  client?.close();
                },
              }),
            );
          }
          else if (msg.type === "denied") {
            denied = true;
            done(() => reject(new ApiError(403, "denied", "The host didn’t let you in")));
          }
        },
        (closed) => {
          if (settled || denied) return;
          if (final(closed) || tries >= RECONNECT_DELAYS.length) {
            done(() => reject(final(closed) ? closeError(closed) : new ApiError(0, "unreachable", "Lost the connection")));
            return;
          }
          // the same seat knocks again
          retry = setTimeout(connect, RECONNECT_DELAYS[tries++]);
        },
      );
      client.connect();
    };
    opts.signal.addEventListener("abort", () =>
      done(() => {
        client?.close();
        reject(opts.signal.reason);
      }),
    );
    connect();
  });
}
