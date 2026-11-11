// shared bits for the e2e scripts: two real chromium "people" with a fake camera.
// Needs the real backend on :8000 and the frontend on :3000 (see README)
import { chromium } from "playwright";

export const WEB = process.env.WEB_URL ?? "http://localhost:3000";

export async function launch() {
  return chromium.launch({
    args: [
      "--use-fake-device-for-media-stream", // test "camera" with a moving picture and a beep
      "--use-fake-ui-for-media-stream", // allow camera and mic without the prompt
    ],
  });
}

// separate context = separate localStorage, so a separate person
export async function person(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}]`, m.text()));
  return page;
}

// first time only: the home screen asks for a name
async function answerName(page, name) {
  const field = page.getByTestId("name-sheet-input");
  // shows after the room or code checks out, so give it a moment
  if (await field.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await field.fill(name);
    await page.getByTestId("name-sheet-save").click();
  }
}

/** Home → New meeting → Instant meeting → "Room is ready". Returns the room's code and link. */
export async function createRoom(page, name, { lobby = false } = {}) {
  // a fresh entry: a reload of "/" would bring back the screen that was open
  await page.goto(`${WEB}/?new`);
  await page.getByTestId("new-meeting").click();
  await page.getByTestId("instant-meeting").click();
  await answerName(page, name);
  const code = (await page.getByTestId("room-code").innerText({ timeout: 10_000 })).trim();
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) throw new Error(`Unexpected room code "${code}"`);
  if (lobby) {
    const toggle = page.getByTestId("lobby-toggle").getByRole("switch");
    await toggle.click();
    // the room's setting on the server, not just the switch
    await page.waitForFunction(() => document.querySelector('[data-testid="lobby-toggle"] [role=switch]')?.getAttribute("aria-checked") === "true");
    await page.waitForFunction(() => !document.querySelector('[data-testid="lobby-toggle"] [role=switch]')?.hasAttribute("disabled"));
  }
  return { code, url: `${WEB}/r/${code}` };
}

/** "Join now" on "Room is ready": the call, or my waiting room if it's on. */
export async function hostJoins(page) {
  await page.getByTestId("join-now").click();
}

/** A guest with the link: the call page's own join screen. */
export async function joinAs(page, url, name) {
  if (url) await page.goto(url);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("join-button").click();
}

/** A guest with the code: typed on the home screen. */
export async function joinWithCode(page, code, name) {
  await page.goto(WEB);
  await page.getByTestId("code-input").fill(code);
  await page.getByTestId("code-submit").click();
  await answerName(page, name);
}

export async function waitConnected(page, who) {
  const tile = page.getByTestId("remote-tile");
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="remote-tile"]');
      const video = el?.querySelector("video");
      return el?.getAttribute("data-state") === "connected" && video && video.videoWidth > 0;
    },
    null,
    { timeout: 20_000 },
  );
  const size = await tile.locator("video").evaluate((v) => `${v.videoWidth}x${v.videoHeight}`);
  console.log(`${who}: connected, remote video ${size}`);
}

// stats live in the right island: hover opens it, then the bars button
export async function openStats(page) {
  await page.getByTestId("call-island").hover();
  await page.getByRole("button", { name: "Stats" }).click();
  await page.locator(".stats").waitFor();
}

export async function safetyCode(page) {
  const code = page.getByTestId("safety");
  // computed a moment after connect
  await page.waitForFunction(() => /\d{5} \d{5}/.test(document.querySelector('[data-testid="safety"]')?.textContent ?? ""), null, {
    timeout: 10_000,
  });
  return (await code.innerText()).trim();
}

/** Leave the call from the island (wide screens). */
export async function hangUp(page) {
  await page.getByTestId("call-island").hover();
  await page.getByTestId("leave").first().click();
}

export async function shotOnFail(browser, name) {
  await Promise.all(browser.contexts().map((c, i) => c.pages()[0]?.screenshot({ path: `e2e/${name}-fail-${i}.png` })));
}
