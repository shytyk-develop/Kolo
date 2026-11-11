import { dbg, debugOn } from "./debug";
import type { ClientMessage, ServerMessage } from "./types";

type Handler = (message: ServerMessage) => void;
type CloseHandler = (code: number, reason: string) => void;

// ping often and check the answers: a dead server is noticed in ~15-19 s, not minutes
const PING_EVERY_MS = 4_000;
const DEAD_AFTER_MS = 15_000;
// our own timer came this late: we were asleep (background tab, frozen page, locked phone),
// the silence says nothing about the server
const ASLEEP_AFTER_MS = PING_EVERY_MS * 2.5;
// a server that hangs (up, but not answering) would keep a new socket "connecting" forever:
// past this it counts as a failed try
const CONNECT_TIMEOUT_MS = 6_000;

/** WebSocket wrapper: json both ways, ping + heartbeat watchdog. */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queue: ClientMessage[];
  private lastSeen = 0;
  private lastTick = 0;
  private openTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private url: string,
    private onMessage: Handler,
    private onClose: CloseHandler,
    // messages a previous connection couldn't send (it dropped): they go out on open
    unsent: ClientMessage[] = [],
  ) {
    this.queue = unsent;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    dbg("ws: connecting");
    // debug: a way to test a dropped connection (both ends see an abnormal close)
    if (debugOn()) window.__koloDrop = () => ws.close(3000, "debug drop");
    this.openTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.CONNECTING) return;
      dbg("ws: connect timeout");
      ws.onclose = null;
      ws.close();
      this.onClose(1006, "connect_timeout");
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(this.openTimer);
      dbg("ws: open");
      this.lastSeen = this.lastTick = Date.now();
      this.queue.forEach((m) => ws.send(JSON.stringify(m)));
      this.queue = [];
      this.pingTimer = setInterval(() => this.tick(), PING_EVERY_MS);
      document.addEventListener("visibilitychange", this.onWake);
      window.addEventListener("pageshow", this.onWake);
      document.addEventListener("resume", this.onWake);
      window.addEventListener("pagehide", this.onPageHide);
    };
    ws.onmessage = (event) => {
      this.lastSeen = Date.now();
      this.onMessage(JSON.parse(event.data) as ServerMessage);
    };
    ws.onclose = (event) => {
      clearTimeout(this.openTimer);
      dbg("ws: closed", { code: event.code, reason: event.reason, clean: event.wasClean });
      this.stopPing();
      this.onClose(event.code, event.reason);
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    // still connecting (or gone): kept, the next connection sends it
    else this.queue.push(message);
  }

  /** What never got out, for the next connection after a drop. */
  takeUnsent(): ClientMessage[] {
    const unsent = this.queue;
    this.queue = [];
    return unsent;
  }

  close(): void {
    this.shut(1000, "bye");
  }

  /** Giving this seat to another page: not a bye, the server holds it for its grace period. */
  handOff(): void {
    this.shut(3001, "handoff");
  }

  private shut(code: number, reason: string): void {
    clearTimeout(this.openTimer);
    this.stopPing();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close(code, reason);
    }
  }

  private tick(): void {
    const now = Date.now();
    const late = now - this.lastTick > ASLEEP_AFTER_MS;
    this.lastTick = now;
    if (late) {
      // we were the ones asleep: no pings went out, so no pongs came back. Give the server
      // a fresh window instead of calling it dead (that killed working calls on wake up)
      dbg("ws: woke up late, not a dead server", { lateMs: now - this.lastSeen });
      this.lastSeen = now;
    } else if (now - this.lastSeen > DEAD_AFTER_MS) {
      // no message (not even a pong) for too long, and we were awake: the server is gone
      this.declareDead();
      return;
    }
    this.send({ type: "ping" });
  }

  // the tab is really going away (closed, navigated): say bye, so the others hear it at once.
  // Otherwise the browser's own close (1001) looks like a frozen tab and they wait a bit
  private onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) this.close();
  };

  // back to the tab / out of a freeze: check right away instead of at the next tick
  private onWake = (): void => {
    if (document.visibilityState !== "visible" || this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastSeen = this.lastTick = Date.now();
    this.send({ type: "ping" });
  };

  private declareDead(): void {
    dbg("ws: heartbeat timeout", { silentMs: Date.now() - this.lastSeen });
    this.stopPing();
    const ws = this.ws;
    if (ws) {
      // a dead socket may never fire onclose, so report it ourselves
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {}
    }
    this.onClose(1006, "heartbeat_timeout");
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    document.removeEventListener("visibilitychange", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    document.removeEventListener("resume", this.onWake);
    window.removeEventListener("pagehide", this.onPageHide);
  }
}
