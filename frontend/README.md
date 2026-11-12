# Kolo frontend

Next.js app for Kolo calls.

```bash
cp .env.example .env.local   # backend url
npm install
npm run dev                  # http://localhost:3000
npm run typecheck
```

Camera and mic only work on https:// or localhost.

The browser calls only its own origin's `/api/...`; `next.config.ts` rewrites that to `BACKEND_URL`
(server side, read at build time; falls back to `NEXT_PUBLIC_API_URL`, then `http://localhost:8000`).
That keeps the Telegram cookie first-party. WebSockets still go straight to `NEXT_PUBLIC_API_URL`
(they carry the join token, no cookies), so the backend's `KOLO_CORS_ORIGINS` must list this site.

## End-to-end tests

Two real browsers (fake camera) against the real backend, no mocks:

```bash
# backend, all in memory (no Postgres / Redis needed), from ../backend
KOLO_DATABASE_URL=memory:// KOLO_REDIS_URL= KOLO_CORS_ORIGINS='["http://localhost:3000"]' \
  uv run uvicorn kolo.main:create_app --factory --port 8000

# frontend on :3000, then
npm run e2e   # e2e/call.mjs: call + safety code + Recent; e2e/lobby.mjs: waiting room
```

Telegram invites, with notify mocked (`e2e/mock-notify.mjs` starts inside the test on :8799):

```bash
# backend pointed at the mock, from ../backend
KOLO_DATABASE_URL=memory:// KOLO_REDIS_URL= KOLO_CORS_ORIGINS='["http://localhost:3000"]' \
  NOTIFY_URL=http://localhost:8799 NOTIFY_API_KEY=e2e-notify-key-0123456789 \
  SESSION_SECRET=e2e-session-secret-0123456789abcdef0123 \
  uv run uvicorn kolo.main:create_app --factory --port 8000

npm run e2e:telegram   # linking (popup, Back to Kolo landing, other browser, expired), invites, a call
```
