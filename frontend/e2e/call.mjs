// two browsers call each other: connected, same safety code, stats panel.
// run: node e2e/call.mjs (backend on :8000, frontend on :3000)
import { createRoom, joinAs, launch, openStats, person, safetyCode, waitConnected } from "./helpers.mjs";

const browser = await launch();
try {
  const host = await person(browser, "Anya");
  const guest = await person(browser, "Bob");

  const roomUrl = await createRoom(host);
  console.log("Room:", roomUrl);
  await joinAs(host, null, "Anya");
  await joinAs(guest, roomUrl, "Bob");

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
  console.log("E2E OK");
} finally {
  await browser.close();
}
