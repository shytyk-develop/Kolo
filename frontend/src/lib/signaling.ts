import type { ClientMessage, ServerMessage } from "./types";

type Handler = (message: ServerMessage) => void;
type CloseHandler = (code: number, reason: string) => void;

// ping often and check the answers: a dead server is noticed in ~10-14 s, not minutes
const PING_EVERY_MS = 4_000;
const DEAD_AFTER_MS = 10_000;

/** WebSocket wrapper: json both ways, ping + heartbeat watchdog. */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queue: ClientMessage[] = [];
  private lastSeen = 0;

  constructor(
    private url: string,
    private onMessage: Handler,
    private onClose: CloseHandler,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastSeen = Date.now();
      this.queue.forEach((m) => ws.send(JSON.stringify(m)));
      this.queue = [];
      this.pingTimer = setInterval(() => {
        // no message (not even a pong) for too long: the server is gone
        if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
          this.declareDead();
          return;
        }
        this.send({ type: "ping" });
      }, PING_EVERY_MS);
    };
    ws.onmessage = (event) => {
      this.lastSeen = Date.now();
      this.onMessage(JSON.parse(event.data) as ServerMessage);
    };
    ws.onclose = (event) => {
      this.stopPing();
      this.onClose(event.code, event.reason);
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    // still connecting, send after onopen
    else this.queue.push(message);
  }

  close(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "bye");
    }
  }

  private declareDead(): void {
    this.stopPing();
    const ws = this.ws;
    if (ws) {
      // a dead socket may never fire onclose, so report it ourselves
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
      }
    }
    this.onClose(1006, "heartbeat_timeout");
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}