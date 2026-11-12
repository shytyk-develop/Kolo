// a stand-in for the notify service (notify/README.md), for e2e only.
// The backend talks to it like to the real one; the test drives it through /__ routes.
//   node e2e/mock-notify.mjs   → listens on :8799 (MOCK_NOTIFY_PORT)
import { createServer } from "node:http";

export const MOCK_NOTIFY_PORT = Number(process.env.MOCK_NOTIFY_PORT ?? 8799);
export const MOCK_NOTIFY_KEY = process.env.MOCK_NOTIFY_KEY ?? "e2e-notify-key-0123456789";
const URL_BASE = `http://localhost:${MOCK_NOTIFY_PORT}`;

// what notify answers per target
const ANSWERS = { newfriend: "needs_acceptance", muted_one: "undeliverable" };

export function startMockNotify() {
  const links = new Map();
  const calls = [];
  let last = null;
  let n = 0;

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const path = new URL(req.url, URL_BASE).pathname;
    const send = (status, data) => {
      res.writeHead(status, data ? { "Content-Type": "application/json" } : {});
      res.end(data ? JSON.stringify(data) : undefined);
    };

    // test controls
    if (path === "/__bot") return send(200, { bot: "pretend this is Telegram" });
    if (path === "/__link") {
      // the person picked an ID in the bot
      links.set(last, { status: "linked", handle: json.handle, display_name: json.name });
      return send(200, { ok: true });
    }
    if (path === "/__expire") {
      links.set(last, { status: "expired", handle: null, display_name: null });
      return send(200, { ok: true });
    }
    if (path === "/__last") return send(200, { token: last });
    if (path === "/__calls") return send(200, calls);

    if (req.headers["x-api-key"] !== MOCK_NOTIFY_KEY) return send(401, { detail: "bad key" });
    calls.push({ method: req.method, path, body: json });

    if (req.method === "POST" && path === "/v1/link") {
      last = `tok_e2e_${++n}_abcdefghijkl`;
      links.set(last, { status: "pending", handle: null, display_name: null });
      return send(201, { token: last, deep_link: `${URL_BASE}/__bot?start=link_${last}`, expires_in: 600 });
    }
    if (req.method === "GET" && path.startsWith("/v1/link/")) {
      const state = links.get(path.slice("/v1/link/".length));
      return state ? send(200, state) : send(404, { detail: "no such link token" });
    }
    if (path === "/v1/invite") {
      if (json.target === "spammy") return send(429, { detail: "too many invites", reason: "hourly", retry_after: 900 });
      return send(202, { invite_id: `inv-${calls.length}`, status: ANSWERS[json.target] ?? "sent" });
    }
    return send(path.endsWith("/ended") ? 200 : 204, path.endsWith("/ended") ? { status: "ended" } : null);
  });

  return new Promise((resolve) => server.listen(MOCK_NOTIFY_PORT, () => resolve({ server, calls })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startMockNotify();
  console.log(`mock notify on ${URL_BASE}, key ${MOCK_NOTIFY_KEY}`);
}
