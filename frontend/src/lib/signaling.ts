import type { ClientMessage, ServerMessage } from "./types";

type Handler = (message: ServerMessage) => void;
type CloseHandler = (code: number, reason: string) => void;

/** WebSocket wrapper: json both ways, ping every 20s. */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queue: ClientMessage[] = [];

  constructor(
    private url: string,
    private onMessage: Handler,
    private onClose: CloseHandler,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.queue.forEach((m) => ws.send(JSON.stringify(m)));
      this.queue = [];
      // 3 missed pings still fit the 60s presence ttl, and proxies drop quiet sockets
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 20_000);
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(event.data) as ServerMessage);
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

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
