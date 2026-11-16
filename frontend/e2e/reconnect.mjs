// coming back into a running call: a page reload on either side, and a dropped signaling socket.
// After each, both sides must decode video again, still end-to-end encrypted.
// run: node e2e/reconnect.mjs (backend on :8000, frontend on :3000)
import { createRoom, encryption, hostJoins, joinAs, launch, openStats, person, shotOnFail, waitConnected } from "./helpers.mjs";

const TRACK_PCS = () => {
  const Real = window.RTCPeerConnection;
  window.__koloPcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Real(...args);
    window.__koloPcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Real.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Real);
  localStorage.setItem("kolo:debug", "1");
};

// frames decoded on the connections that are alive right now
const decoded = (page) =>
  page.evaluate(async () => {
    let frames = 0;
    for (const pc of window.__koloPcs ?? []) {
      if (pc.connectionState !== "connected") continue;
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") frames += s.framesDecoded ?? 0;
      });
    }
    return frames;
  });

async function flowing(pages, what, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  const started = Date.now();
  while (Date.now() < until) {
    const before = await Promise.all(pages.map(decoded));
    await pages[0].waitForTimeout(1500);
    const after = await Promise.all(pages.map(decoded));
    if (after.every((n, i) => n - before[i] >= 10)) {
      console.log(`PASS ${what} (video on both sides again after ${((Date.now() - started) / 1000).toFixed(1)} s)`);
      return;
    }
  }
  throw new Error(`${what}: video didn't come back on both sides`);
}

async function e2ee(pages) {
  for (const page of pages) {
    await openStats(page).catch(() => {});
    const security = await encryption(page);
    if (security !== "e2ee") throw new Error(`expected e2ee after coming back, got ${security}`);
  }
}

const browser = await launch();
try {
  const host = await person(browser, "Anya");
  const guest = await person(browser, "Bob");
  for (const page of [host, guest]) await page.addInitScript(TRACK_PCS);

  const room = await createRoom(host, "Anya");
  await hostJoins(host);
  await host.getByTestId("call").waitFor();
  await joinAs(guest, room.url, "Bob");
  await waitConnected(host, "Anya");
  await waitConnected(guest, "Bob");
  await flowing([host, guest], "call is up");

  await guest.reload();
  await guest.getByTestId("call").waitFor({ timeout: 15_000 });
  await flowing([host, guest], "the guest reloads the page");
  await e2ee([host, guest]);

  await host.reload();
  await host.getByTestId("call").waitFor({ timeout: 15_000 });
  await flowing([host, guest], "the host reloads the page");
  await e2ee([host, guest]);

  // the socket dies, the video goes on; signaling comes back by itself
  await guest.evaluate(() => window.__koloDrop());
  await guest.waitForTimeout(4000);
  await flowing([host, guest], "the signaling socket drops");

  // ...and with the socket back, an ICE restart still gets through (sealed, like everything else)
  await host.evaluate(() => window.__koloPcs.filter((pc) => pc.connectionState === "connected").forEach((pc) => pc.restartIce()));
  await host.waitForTimeout(3000);
  await flowing([host, guest], "ice restart in a running call");
  await e2ee([host, guest]);

  console.log("RECONNECT OK: 5/5");
} catch (err) {
  await shotOnFail(browser, "reconnect");
  throw err;
} finally {
  await browser.close();
}
