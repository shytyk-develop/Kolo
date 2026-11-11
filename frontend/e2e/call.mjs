// two browsers call each other through the home screen: connected, same safety code, stats,
// then the host hangs up and finds the guest in Recent.
// run: node e2e/call.mjs (backend on :8000, frontend on :3000)
import {
  createRoom,
  hangUp,
  hostJoins,
  joinAs,
  launch,
  openStats,
  person,
  safetyCode,
  shotOnFail,
  waitConnected,
  WEB,
} from "./helpers.mjs";

const browser = await launch();
try {
  const host = await person(browser, "Anya");
  const guest = await person(browser, "Bob");

  const room = await createRoom(host, "Anya");
  console.log("Room:", room.url);
  await hostJoins(host);
  await host.waitForURL(`${WEB}/r/${room.code}`);
  // the home screen handed its seat over: no join screen here
  await host.getByTestId("call").waitFor();
  await joinAs(guest, room.url, "Bob");

  await waitConnected(host, "Anya");
  await waitConnected(guest, "Bob");

  await openStats(host);
  await openStats(guest);
  const codeA = await safetyCode(host);
  const codeB = await safetyCode(guest);
  console.log(`Safety code: Anya "${codeA}", Bob "${codeB}"`);
  if (codeA !== codeB) throw new Error("Safety codes differ, possible man in the middle!");

  // bitrate needs two reads 2s apart
  await host.waitForTimeout(4500);
  console.log("Anya's stats:\n" + (await host.locator(".stats").innerText()));
  await host.screenshot({ path: process.env.SHOT ?? "e2e/call.png" });

  // hang up: "Call ended" with the real length, and Bob is in Recent now
  await hangUp(host);
  await host.getByTestId("call-ended").waitFor({ timeout: 10_000 });
  const ended = await host.locator(".view--ended .vsub").innerText();
  if (!/with Bob · \d\d:\d\d/.test(ended)) throw new Error(`Unexpected call ended line "${ended}"`);
  await host.getByTestId("rejoin").waitFor();
  console.log(`Call ended: "${ended}"`);

  await host.getByRole("button", { name: "Home", exact: true }).last().click();
  await host.getByTestId("new-meeting").click();
  const row = host.getByTestId("recent-row").first();
  await row.waitFor();
  const text = await row.innerText();
  if (!text.includes("Bob") || !text.includes("Today")) throw new Error(`Recent row doesn't show the call: "${text}"`);
  console.log(`Recent: ${text.replace(/\s+/g, " ")}`);
  console.log("E2E OK");
} catch (err) {
  await shotOnFail(browser, "call");
  throw err;
} finally {
  await browser.close();
}
