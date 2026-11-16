// end-to-end encryption, checked from the outside:
//  1. a normal call is "e2ee" on both sides and the media really flows
//  2. the room key never leaves the browsers, and the server sees no sdp / candidates
//  3. frames can't be decoded with another key
//  4. a guest without the key waits until the host agrees, and then both see it isn't end-to-end
//  5. a third person can't get into a room for two
// run: node e2e/e2ee.mjs (backend on :8000, frontend on :3000)
import { createRoom, encryption, hostJoins, joinAs, launch, openStats, person, safetyCode, shotOnFail, waitConnected, WEB } from "./helpers.mjs";

const results = [];
const ok = (name, detail = "") => {
  results.push(name);
  console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
};
const check = (cond, message) => {
  if (!cond) throw new Error(message);
};

// everything a page sends to or gets from a server
function wiretap(page) {
  const seen = [];
  page.on("request", (r) => seen.push(`${r.method()} ${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ""}`));
  page.on("websocket", (ws) => {
    seen.push(`WS ${ws.url()}`);
    ws.on("framesent", (f) => seen.push(`> ${f.payload}`));
    ws.on("framereceived", (f) => seen.push(`< ${f.payload}`));
  });
  return seen;
}

// what the browser itself says about the incoming media
async function inbound(page) {
  return page.evaluate(async () => {
    const out = { videoFrames: 0, videoBytes: 0, audioBytes: 0, audioEnergy: 0, codec: "" };
    for (const pc of window.__koloPcs ?? []) {
      if (pc.connectionState !== "connected") continue;
      const report = await pc.getStats();
      report.forEach((s) => {
        if (s.type !== "inbound-rtp") return;
        if (s.kind === "video") {
          out.videoFrames += s.framesDecoded ?? 0;
          out.videoBytes += s.bytesReceived ?? 0;
          out.codec = report.get(s.codecId)?.mimeType ?? out.codec;
        } else {
          out.audioBytes += s.bytesReceived ?? 0;
          out.audioEnergy += s.totalAudioEnergy ?? 0;
        }
      });
    }
    return out;
  });
}

// remember every RTCPeerConnection the page makes, to ask it for stats
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
};

// this browser decrypts incoming frames with a key that isn't the room's
const WRONG_RECEIVE_KEY = () => {
  const Real = window.RTCRtpScriptTransform;
  window.RTCRtpScriptTransform = function (worker, options) {
    const bad = options?.side === "receive" ? { ...options, roomKey: "A".repeat(43) } : options;
    return new Real(worker, bad);
  };
  window.RTCRtpScriptTransform.prototype = Real.prototype;
};

async function someone(browser, name, ...scripts) {
  const page = await person(browser, name);
  for (const script of [TRACK_PCS, ...scripts]) await page.addInitScript(script);
  return page;
}

const browser = await launch();
try {
  // ---------- 1 + 2 ----------
  {
    const host = await someone(browser, "Anya");
    const guest = await someone(browser, "Bob");
    const taps = [wiretap(host), wiretap(guest)];

    const room = await createRoom(host, "Anya");
    await hostJoins(host);
    await host.getByTestId("call").waitFor();
    await joinAs(guest, room.url, "Bob");
    await waitConnected(host, "Anya");
    await waitConnected(guest, "Bob");
    await openStats(host);
    await openStats(guest);

    const security = [await encryption(host), await encryption(guest)];
    check(security.every((s) => s === "e2ee"), `expected e2ee on both sides, got ${security}`);
    const codes = [await safetyCode(host), await safetyCode(guest)];
    check(codes[0] === codes[1], `safety codes differ: ${codes}`);

    const before = [await inbound(host), await inbound(guest)];
    await host.waitForTimeout(3000);
    const after = [await inbound(host), await inbound(guest)];
    after.forEach((now, i) => {
      check(now.videoFrames - before[i].videoFrames > 10, `side ${i}: video isn't being decoded`);
      check(now.audioBytes > before[i].audioBytes, `side ${i}: no audio coming in`);
      check(now.audioEnergy > 0, `side ${i}: the audio is silence, the beep didn't survive`);
      check(/vp8/i.test(now.codec), `side ${i}: expected VP8 with encrypted frames, got ${now.codec}`);
    });
    ok("call is end-to-end encrypted, video and audio flow", `codes ${codes[0]}, ${after[0].codec}, +${after[0].videoFrames - before[0].videoFrames} frames in 3 s`);

    const all = taps.flat().join("\n");
    check(!all.includes(room.key), "the room key was sent to a server");
    check(!/[#?&]k=/.test(all), "a link fragment with the key reached a server");
    check(!all.includes("a=fingerprint") && !all.includes("candidate:"), "sdp or ice candidates went over signaling in the clear");
    const sealed = taps.flat().filter((line) => line.includes('"type":"sealed"')).length;
    check(sealed >= 4, `expected sealed signaling messages, saw ${sealed}`);
    ok("the key never leaves the browsers, signaling is sealed", `${taps.flat().length} requests and frames checked, ${sealed} sealed`);

    await host.context().close();
    await guest.context().close();
  }

  // ---------- 3 ----------
  {
    const host = await someone(browser, "Anya");
    const eve = await someone(browser, "Eve", WRONG_RECEIVE_KEY);
    const room = await createRoom(host, "Anya");
    await hostJoins(host);
    await host.getByTestId("call").waitFor();
    await joinAs(eve, room.url, "Eve");
    // the host still decodes Eve's frames: her sending side uses the real key
    await waitConnected(host, "Anya");
    await eve.waitForFunction(() => document.querySelector('[data-testid="remote-tile"]')?.getAttribute("data-state") === "connected");
    await eve.waitForTimeout(4000);
    const got = await inbound(eve);
    check(got.videoBytes > 20_000, "no media reached the wrong-key browser at all, the test proves nothing");
    check(got.videoFrames === 0, `frames were decoded with a wrong key: ${got.videoFrames}`);
    check(got.audioEnergy === 0, "audio was heard with a wrong key");
    ok("with another key the frames are noise", `${got.videoBytes} bytes of video received, 0 frames decoded, audio energy 0`);
    await host.context().close();
    await eve.context().close();
  }

  // ---------- 4 ----------
  {
    const host = await someone(browser, "Anya");
    const guest = await someone(browser, "Bob");
    const room = await createRoom(host, "Anya");
    await hostJoins(host);
    await host.getByTestId("call").waitFor();
    // the code only, as if typed in or sent without the #part
    await joinAs(guest, room.plainUrl, "Bob");
    // the host holds the key, Bob doesn't: nothing connects until the host says so
    await host.getByTestId("no-key").waitFor({ timeout: 8000 });
    await guest.getByTestId("need-key").waitFor({ timeout: 8000 });
    await host.waitForTimeout(2500);
    const early = await host.locator('[data-testid="remote-tile"]').getAttribute("data-state");
    check(early !== "connected", "a guest without the key was connected before the host agreed");
    await host.getByTestId("allow-plain").click();
    await waitConnected(host, "Anya");
    await waitConnected(guest, "Bob");
    await host.getByTestId("not-e2ee").waitFor({ timeout: 5000 });
    await guest.getByTestId("not-e2ee").waitFor({ timeout: 5000 });
    await openStats(host);
    await openStats(guest);
    const security = [await encryption(host), await encryption(guest)];
    check(security.every((s) => s === "none"), `expected "none" on both sides, got ${security}`);
    const codes = [await safetyCode(host), await safetyCode(guest)];
    check(codes[0] === codes[1], `safety codes differ: ${codes}`);
    ok("without the key: no call until the host agrees, then it says it isn't end-to-end", `codes ${codes[0]}`);

    // ---------- 5 ----------
    const third = await someone(browser, "Mallory");
    const answers = [];
    third.on("response", (r) => r.url().includes("/join") && answers.push(r.status()));
    await joinAs(third, room.url, "Mallory");
    await third.waitForTimeout(2500);
    check(answers.includes(409), `the third join wasn't refused: ${answers}`);
    check((await third.getByTestId("call").count()) === 0, "the third person got into the call");
    check((await host.locator('[data-testid="remote-tile"]').getAttribute("data-state")) === "connected", "the call of the two broke");
    ok("a third person can't join a room for two", `join answered ${answers.join(", ")}`);
    await host.context().close();
    await guest.context().close();
    await third.context().close();
  }

  console.log(`E2EE OK: ${results.length}/5`);
} catch (err) {
  await shotOnFail(browser, "e2ee");
  throw err;
} finally {
  await browser.close();
}
