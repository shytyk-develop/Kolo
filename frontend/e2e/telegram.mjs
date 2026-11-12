// Telegram invites with notify mocked: link in Settings, invite by Kolo ID (every 03 state),
// a real call between two linked people, then the plane in Recent.
// Needs the backend started against the mock (see README), frontend on :3000.
import { hangUp, joinAs, launch, person, shotOnFail, waitConnected, WEB } from "./helpers.mjs";
import { MOCK_NOTIFY_PORT, startMockNotify } from "./mock-notify.mjs";

const MOCK = `http://localhost:${MOCK_NOTIFY_PORT}`;
const { server } = await startMockNotify();
const control = (path, body) =>
  fetch(`${MOCK}${path}`, { method: body ? "POST" : "GET", body: body && JSON.stringify(body) }).then((r) => r.json());

// a fresh entry each time: going to the same url again would restore the open screen
const fresh = (page) => page.goto(`${WEB}/?t=${Date.now()}`);

async function link(page, handle, name) {
  await fresh(page);
  await page.getByRole("button", { name: "Settings" }).click();
  const status = page.getByTestId("tg-status");
  await status.filter({ hasText: "Not connected" }).waitFor();
  const tab = page.context().waitForEvent("page");
  await page.getByTestId("tg-connect").click();
  // the "bot" opened in a new tab
  await (await tab).close();
  await status.filter({ hasText: "Waiting for Telegram…" }).waitFor();
  await control("/__link", { handle, name });
  await status.filter({ hasText: `Connected as @${handle}` }).waitFor({ timeout: 8000 });
  console.log(`${name}: linked as @${handle}`);
  await page.getByRole("button", { name: "Back from settings" }).click();
}

async function inviteById(page, handle) {
  await page.getByTestId("new-meeting").click();
  await page.getByTestId("id-invite-input").fill(handle);
  await page.getByTestId("id-invite-send").click();
  const status = page.getByTestId("invite-status");
  await status.waitFor({ timeout: 10_000 });
  return status;
}

async function expectStatus(page, handle, state, text) {
  const status = await inviteById(page, handle);
  const shown = (await status.innerText()).trim();
  if ((await status.getAttribute("data-status")) !== state || !shown.includes(text)) {
    throw new Error(`@${handle}: expected ${state} "${text}", got "${shown}"`);
  }
  console.log(`@${handle}: "${shown}"`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Back" }).click();
}

const browser = await launch();
try {
  const yan = await person(browser, "Yan");
  const alex = await person(browser, "Alex");

  // not linked yet: no field, a way to Settings instead
  await fresh(yan);
  await yan.evaluate(() => localStorage.setItem("kolo.profile.v1", JSON.stringify({ id: "e2e-yan-browser-0001", name: "Yan", rememberPeople: true, lobbyDefault: false })));
  await fresh(yan);
  await yan.getByTestId("new-meeting").click();
  await yan.getByTestId("connect-to-invite").waitFor();
  console.log("Not linked: 'Connect Telegram to invite by ID'");

  await link(yan, "yan_k", "Yan");

  // a bad ID never leaves the browser
  await yan.getByTestId("new-meeting").click();
  await yan.getByTestId("id-invite-input").fill("a!");
  await yan.getByTestId("id-invite-send").click();
  await yan.getByText("A Kolo ID is 3–20 characters").waitFor();
  await yan.getByRole("button", { name: "Back" }).first().click();

  await expectStatus(yan, "alex718", "sent", "Sent via Telegram ·");
  await expectStatus(yan, "newfriend", "needs_acceptance", "Sent · newfriend needs to accept first");
  await expectStatus(yan, "muted_one", "undeliverable", "Couldn’t reach muted_one on Telegram");
  await expectStatus(yan, "spammy", "limited", "Too many invites, try again later");

  const invites = (await control("/__calls")).filter((c) => c.path === "/v1/invite");
  if (invites.some((c) => c.body.caller !== "yan_k" || c.body.caller_name !== "Yan")) {
    throw new Error(`caller must come from the cookie: ${JSON.stringify(invites)}`);
  }
  console.log(`notify got ${invites.length} invites, all from @yan_k`);

  // a real call: Yan invites Alex, enters, Alex comes by the link
  await fresh(alex);
  await alex.evaluate(() => localStorage.setItem("kolo.profile.v1", JSON.stringify({ id: "e2e-alex-browser-01", name: "Alex", rememberPeople: true, lobbyDefault: false })));
  await link(alex, "alex718", "Alex");
  await inviteById(yan, "alex718");
  const code = (await yan.locator(".zchip--mono").innerText()).trim();
  await yan.getByRole("button", { name: "Enter room" }).click();
  await yan.waitForURL(`${WEB}/r/${code}`);
  await joinAs(alex, `${WEB}/r/${code}`, "Alex");
  await waitConnected(yan, "Yan");
  await waitConnected(alex, "Alex");
  await hangUp(yan);
  await yan.getByTestId("call-ended").waitFor({ timeout: 10_000 });

  // the server told notify: these two have called, the invite is over
  await yan.waitForTimeout(800);
  const after = await control("/__calls");
  const completed = after.find((c) => c.path === "/v1/calls/completed");
  if (!completed || [completed.body.a, completed.body.b].sort().join() !== "alex718,yan_k") {
    throw new Error(`no calls/completed: ${JSON.stringify(after.map((c) => c.path))}`);
  }
  if (!after.some((c) => c.path.endsWith("/ended"))) throw new Error("the invite was never ended");
  console.log("notify heard: call completed, invite ended");

  // Recent knows Alex's Kolo ID: the plane, straight to "Inviting"
  const row = await yan.evaluate(() => JSON.parse(localStorage.getItem("kolo.recents.v1"))[0]);
  if (row.handle !== "alex718") throw new Error(`recent without handle: ${JSON.stringify(row)}`);
  await yan.getByRole("button", { name: "Home", exact: true }).last().click();
  await yan.getByTestId("new-meeting").click();
  await yan.getByTestId("recent-invite").first().click();
  await yan.getByTestId("invite-status").filter({ hasText: "Sent via Telegram" }).waitFor({ timeout: 10_000 });
  console.log("Recent: plane → 'Inviting Alex', sent");

  console.log("E2E OK");
} catch (err) {
  await shotOnFail(browser, "telegram");
  throw err;
} finally {
  await browser.close();
  server.close();
}
