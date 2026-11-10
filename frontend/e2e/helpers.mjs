// shared bits for the e2e scripts: two real chromium "people" with a fake camera
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

export async function joinAs(page, url, name) {
  if (url) await page.goto(url);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("join-button").click();
}

export async function createRoom(page, { lobby = false } = {}) {
  await page.goto(WEB);
  if (lobby) await page.getByTestId("lobby-checkbox").check();
  await page.getByTestId("create-room").click();
  await page.waitForURL(/\/r\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  return page.url();
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
