// One call through the attacker's router. What's expected comes from the environment:
//   EXPECT=connected (default) | blocked     what should happen
//   PLAIN=1                                  the guest opens the link without the key
//   ALLOW_PLAIN=1                            ...and the host presses "Call anyway"
//   HOLD_MS=4000                             how long to stay in the call before reading the numbers
//   WAIT_FILE=/results/go                    mid-call: wait for this file (run.sh changes the network meanwhile)
//   RECOVER_MS=40000                         after WAIT_FILE: how long the call may take to come back
//   OUT=name.json                            where the facts go, under lab/results
import { existsSync, rmSync } from "node:fs";

import { callFacts, closeAll, mediaStats, save, sleep, startCall, waitMedia, warnings } from "./lib.mjs";

const env = process.env;
const expect = env.EXPECT ?? "connected";
const out = env.OUT ?? "call.json";
const result = { scenario: env.SCENARIO ?? "call", expect, ok: false };

const call = await startCall({
  plain: Boolean(env.PLAIN),
  allowPlain: Boolean(env.ALLOW_PLAIN),
  hostEngine: env.HOST_ENGINE,
  guestEngine: env.GUEST_ENGINE,
});
const { host, guest, room, t0 } = call;
try {
  save("room.json", { code: room.code, key: room.key });
  const connected = await waitMedia([host, guest], Number(env.CONNECT_MS ?? 25_000));
  result.connected = connected;
  result.secondsToVideo = connected ? Math.round((Date.now() - t0) / 100) / 10 : null;

  if (connected) {
    await sleep(Number(env.HOLD_MS ?? 4000));
    result.facts = await callFacts(call);

    if (env.WAIT_FILE) {
      rmSync(env.WAIT_FILE, { force: true });
      save("connected.marker", "1");
      while (!existsSync(env.WAIT_FILE)) await sleep(200);
      const changedAt = Date.now();
      const before = await Promise.all([host, guest].map((p) => mediaStats(p.page)));
      // back = frames are being decoded again on both sides
      let backAfter = null;
      const until = changedAt + Number(env.RECOVER_MS ?? 40_000);
      let last = before;
      const timeline = [];
      while (Date.now() < until) {
        await sleep(1000);
        const now = await Promise.all([host, guest].map((p) => mediaStats(p.page)));
        const flowing = now.every((s, i) => s.state === "connected" && s.videoFrames - last[i].videoFrames >= 5);
        if (env.KOLO_DEBUG) {
          const seen = await host.page.evaluate(() => `${location.pathname} | ${document.body.innerText.replace(/\s+/g, " ").slice(0, 70)}`).catch(() => "?");
          timeline.push(`   Anya's screen: ${seen}`);
        }
        timeline.push(`${Math.round((Date.now() - changedAt) / 1000)}s: ${now.map((s) => `${s.state}/${s.path ?? "-"}/+${s.videoFrames}`).join("  ")}`);
        last = now;
        // count only when it really runs again after the disruption (not the last frames before it)
        if (flowing && Date.now() - changedAt > Number(env.SETTLE_MS ?? 6000)) {
          backAfter = Math.round((Date.now() - changedAt) / 1000);
          break;
        }
      }
      result.recovery = { backAfterSeconds: backAfter, timeline };
      result.after = await callFacts(call);
    }
  } else {
    result.facts = await callFacts(call);
    result.notices = {};
    for (const p of [host, guest]) {
      result.notices[p.name] = await p.page.evaluate(() =>
        ["no-key", "need-key", "not-e2ee", "call-error"].filter((id) => document.querySelector(`[data-testid="${id}"]`)),
      );
    }
  }
  result.warnings = [...warnings(host), ...warnings(guest)].slice(0, 12);
  if (env.KOLO_DEBUG) save(out.replace(".json", ".console.txt"), [...host.log, ...guest.log].join("\n"));

  const recovered = !env.WAIT_FILE || result.recovery?.backAfterSeconds != null;
  result.ok = expect === "connected" ? connected && recovered : !connected;
  // not what was expected: keep a picture of both screens
  if (!result.ok) {
    result.screens = {};
    for (const p of [host, guest]) {
      result.screens[p.name] = await p.page
        .evaluate(() => ({
          url: location.pathname,
          lastCall: sessionStorage.getItem("kolo:lastCall") ?? localStorage.getItem("kolo:lastCall"),
          text: document.body.innerText.replace(/\s+/g, " ").slice(0, 160),
        }))
        .catch(() => null);
    }
    for (const p of [host, guest]) await p.page.screenshot({ path: `/results/${out.replace(".json", "")}-${p.name}.png` }).catch(() => {});
  }
} finally {
  save(out, result);
  console.log(JSON.stringify(result, null, 2));
  await closeAll(host, guest);
}
process.exit(result.ok ? 0 : 1);
