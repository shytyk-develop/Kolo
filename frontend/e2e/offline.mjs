// backend down and back: offline pill, cached link, recovery without a reload, 4 s give-up on a hang.
// Starts its own backend on BACKEND_PORT (where the frontend proxies /api).
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { launch, person, shotOnFail, WEB } from "./helpers.mjs";
import { MOCK_NOTIFY_KEY, MOCK_NOTIFY_PORT, startMockNotify } from "./mock-notify.mjs";

const PORT = Number(process.env.BACKEND_PORT ?? 8000);
const MOCK = `http://localhost:${MOCK_NOTIFY_PORT}`;
const { server: mock } = await startMockNotify();
const control = (path, body) =>
  fetch(`${MOCK}${path}`, { method: body ? "POST" : "GET", body: body && JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

let backend = null;
async function startBackend() {
  const env = { ...process.env, KOLO_DATABASE_URL: "memory://", KOLO_REDIS_URL: "", KOLO_TURN_URLS: "[]",
    KOLO_CORS_ORIGINS: JSON.stringify([WEB]), NOTIFY_URL: MOCK, NOTIFY_API_KEY: MOCK_NOTIFY_KEY,
    SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123" };
  delete env.VIRTUAL_ENV;
  backend = spawn("../backend/.venv/bin/uvicorn", ["kolo.main:create_app", "--factory", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error("backend didn't start");
}
async function stopBackend() {
  backend?.kill("SIGTERM");
  await new Promise((r) => backend.once("exit", r));
  backend = null;
}

const pill = (page) => page.getByTestId("server-status");

const browser = await launch();
try {
  const page = await person(browser, "Jan");
  // every status the Telegram card shows: "not set up" must never flash
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="tg-status"]')?.textContent;
      if (!t) return;
      const seen = JSON.parse(sessionStorage.getItem("__tgSeen") ?? "[]");
      if (!seen.includes(t)) sessionStorage.setItem("__tgSeen", JSON.stringify([...seen, t]));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });

  // linked while the server is up; a name, so actions skip the name sheet
  await startBackend();
  await page.goto(`${WEB}/?t=${Date.now()}`);
  await page.evaluate(() =>
    localStorage.setItem("kolo.profile.v1", JSON.stringify({ id: "e2e-jan-browser-0001", name: "Jan", rememberPeople: true, lobbyDefault: false })),
  );
  await page.goto(`${WEB}/?t=${Date.now()}`);
  await page.getByRole("button", { name: "Settings" }).click();
  const popup = page.waitForEvent("popup");
  await page.getByTestId("tg-connect").click();
  // the popup gets the bot's link a moment after it opens
  const tg = await popup;
  await tg.waitForURL(/__bot\?start=link_/);
  const token = new URL(tg.url()).searchParams.get("start").replace(/^link_/, "");
  await control("/__link", { token, handle: "jan", name: "Jan" });
  const status = page.getByTestId("tg-status");
  await status.filter({ hasText: "Connected as @jan" }).waitFor({ timeout: 8000 });
  console.log("online: Connected as @jan");

  // server down: a fresh load shows the cached state, then "offline"
  await stopBackend();
  let t = Date.now();
  await page.goto(`${WEB}/?t=${Date.now()}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await status.filter({ hasText: "Connected as @jan" }).waitFor({ timeout: 2000 });
  console.log(`offline load: "Connected as @jan" from cache after ${since(t)}`);
  await pill(page).filter({ hasText: "Server is offline" }).waitFor({ timeout: 6000 });
  await page.getByTestId("tg-offline").waitFor();
  console.log(`offline load: "Server is offline" after ${since(t)}`);
  await page.getByRole("button", { name: "Back from settings" }).click();
  await page.getByTestId("new-meeting").click();
  if ((await page.getByTestId("instant-meeting").getAttribute("aria-disabled")) !== "true") {
    throw new Error("Instant meeting should rest while offline");
  }
  console.log("offline: Instant meeting disabled, 'Server is offline'");

  // server back: no reload needed
  await sleep(6000);
  t = Date.now();
  await startBackend();
  const up = Date.now();
  await pill(page).filter({ hasText: "Back online" }).waitFor({ timeout: 10_000 });
  console.log(`backend up in ${since(t)}; site noticed ${since(up)} after that (probe backoff, no focus)`);
  await page.getByTestId("instant-meeting").and(page.locator(":not([aria-disabled])")).waitFor({ timeout: 2000 });
  await pill(page).waitFor({ state: "detached", timeout: 4000 });
  await page.getByRole("button", { name: "Back" }).first().click();
  await page.getByRole("button", { name: "Settings" }).click();
  await status.filter({ hasText: "Connected as @jan" }).waitFor();
  console.log("recovered: pill gone, Settings 'Connected as @jan', no reload");

  // focus checks right away
  await stopBackend();
  await page.getByRole("button", { name: "Back from settings" }).click();
  await page.getByTestId("new-meeting").click();
  t = Date.now();
  await page.getByTestId("instant-meeting").click();
  await pill(page).filter({ hasText: "Server is offline" }).waitFor({ timeout: 6000 });
  console.log(`down again: a tap on Instant meeting → "Server is offline" after ${since(t)}`);
  await sleep(12_000); // deep in the 5 s backoff
  await startBackend();
  t = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pill(page).filter({ hasText: "Back online" }).waitFor({ timeout: 3000 });
  console.log(`focus after the backend is up: back online in ${since(t)}`);

  // a backend that accepts and never answers
  await stopBackend();
  const sockets = new Set();
  const hang = createServer((s) => sockets.add(s)).listen(PORT);
  await sleep(300);
  await page.goto(`${WEB}/?t=${Date.now()}`);
  await page.getByTestId("new-meeting").click();
  t = Date.now();
  await page.getByTestId("instant-meeting").click();
  await pill(page).filter({ hasText: "Server is offline" }).waitFor({ timeout: 8000 });
  const gaveUp = (Date.now() - t) / 1000;
  console.log(`hanging backend: offline after ${gaveUp.toFixed(1)}s`);
  if (gaveUp > 5.5) throw new Error("the client should give up after about 4 s");
  sockets.forEach((s) => s.destroy());
  hang.close();

  const seen = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__tgSeen") ?? "[]"));
  if (seen.some((s) => /not set up/i.test(s))) throw new Error(`"not set up" was shown: ${seen.join(" | ")}`);
  console.log(`card statuses seen: ${seen.join(" | ")}`);
  console.log("E2E OK");
} catch (err) {
  await shotOnFail(browser, "offline");
  throw err;
} finally {
  await browser.close();
  if (backend) await stopBackend();
  mock.close();
}
