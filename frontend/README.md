# Kolo frontend

Next.js app for Kolo calls.

```bash
cp .env.example .env.local   # backend url
npm install
npm run dev                  # http://localhost:3000
npm run typecheck
```

Camera and mic only work on https:// or localhost.

## End-to-end tests

Two real browsers (fake camera) against the real backend, no mocks:

```bash
# backend, all in memory (no Postgres / Redis needed), from ../backend
KOLO_DATABASE_URL=memory:// KOLO_REDIS_URL= KOLO_CORS_ORIGINS='["http://localhost:3000"]' \
  uv run uvicorn kolo.main:create_app --factory --port 8000

# frontend on :3000, then
npm run e2e   # e2e/call.mjs: call + safety code + Recent; e2e/lobby.mjs: waiting room
```
