// shared by the lab scenarios: two browsers in two containers, each behind the attacker's router
import { writeFileSync } from "node:fs";

import { chromium, firefox } from "playwright";

import { createRoom, encryption, hostJoins, joinAs, openStats, safetyCode } from "../e2e/helpers.mjs";

export const RESULTS = "/results";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// remember every RTCPeerConnection the page makes, to read its stats
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

export async function connect(url, name, { engine = "chromium" } = {}) {
  const browser = await (engine === "firefox" ? firefox : chromium).connect(url);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.addInitScript(TRACK_PCS);
  // KOLO_DEBUG=1: the app's own call timeline goes to the console (and into the saved log)
  if (process.env.KOLO_DEBUG) await page.addInitScript(() => localStorage.setItem("kolo:debug", "1"));
  const log = [];
  page.on("console", (m) => {
    const line = `[${name}] ${m.type()}: ${m.text()}`;
    log.push(line);
    if (process.env.VERBOSE) console.log(line);
  });
  // api answers and failures, for the saved log
  page.on("response", (r) => r.url().includes("/api/") && !r.url().includes("/health") && log.push(`[${name}] http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  page.on("requestfailed", (r) => r.url().includes("/api/") && log.push(`[${name}] http failed ${r.request?.().method?.() ?? r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  page.on("framenavigated", (f) => f === page.mainFrame() && log.push(`[${name}] page ${new URL(f.url()).pathname}`));
  return { browser, context, page, log, name };
}

export async function mediaStats(page) {
  return page.evaluate(async () => {
    const out = { state: "none", path: null, protocol: null, relayProtocol: null, rttMs: null, videoFrames: 0, fps: null, videoBytes: 0, audioBytes: 0, lossPct: null, audioEnergy: 0, freezes: 0 };
    for (const pc of window.__koloPcs ?? []) {
      if (pc.connectionState === "closed") continue;
      out.state = pc.connectionState;
      const report = await pc.getStats();
      let lost = 0;
      let got = 0;
      // the pair that carries the media, not just any pair that worked
      let selected = null;
      report.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) selected = s.selectedCandidatePairId;
      });
      report.forEach((s) => {
        if (s.type === "candidate-pair" && (selected ? s.id === selected : s.nominated && s.state === "succeeded")) {
          const local = report.get(s.localCandidateId);
          const remote = report.get(s.remoteCandidateId);
          out.path = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : local?.candidateType;
          out.protocol = local?.protocol ?? null;
          out.relayProtocol = local?.relayProtocol ?? null;
          if (s.currentRoundTripTime != null) out.rttMs = Math.round(s.currentRoundTripTime * 1000);
        }
        if (s.type === "inbound-rtp") {
          lost += s.packetsLost ?? 0;
          got += s.packetsReceived ?? 0;
          if (s.kind === "video") {
            out.videoFrames += s.framesDecoded ?? 0;
            out.videoBytes += s.bytesReceived ?? 0;
            out.fps = s.framesPerSecond ?? out.fps;
            out.freezes += s.freezeCount ?? 0;
          } else {
            out.audioBytes += s.bytesReceived ?? 0;
            out.audioEnergy += s.totalAudioEnergy ?? 0;
          }
        }
      });
      if (got + lost > 0) out.lossPct = Math.round((lost / (got + lost)) * 1000) / 10;
    }
    return out;
  });
}

const tileState = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="remote-tile"]')?.getAttribute("data-state") ?? "none");

/** Both sides: the tile says connected and frames are really being decoded. */
export async function waitMedia(people, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const now = await Promise.all(people.map(async (p) => ({ tile: await tileState(p.page), ...(await mediaStats(p.page)) })));
    if (now.every((s) => s.tile === "connected" && s.videoFrames > 5)) return true;
    await sleep(500);
  }
  return false;
}

/** Host makes a room and enters; the guest opens the link (with or without the key). */
export async function startCall({ plain = false, allowPlain = false, hostEngine, guestEngine } = {}) {
  const host = await connect(process.env.CLIENT_A, "Anya", { engine: hostEngine });
  const guest = await connect(process.env.CLIENT_B, "Bob", { engine: guestEngine });
  const t0 = Date.now();
  const room = await createRoom(host.page, "Anya");
  await hostJoins(host.page);
  await host.page.getByTestId("call").waitFor();
  await joinAs(guest.page, plain ? room.plainUrl : room.url, "Bob");
  if (plain && allowPlain) {
    await host.page.getByTestId("no-key").waitFor({ timeout: 15_000 });
    await host.page.getByTestId("allow-plain").click();
  }
  return { host, guest, room, t0 };
}

export async function callFacts({ host, guest }) {
  const facts = {};
  for (const p of [host, guest]) {
    await openStats(p.page).catch(() => {});
    facts[p.name] = {
      encryption: await encryption(p.page).catch(() => null),
      safety: await safetyCode(p.page).catch(() => null),
      ...(await mediaStats(p.page)),
    };
  }
  return facts;
}

export async function closeAll(...people) {
  for (const p of people) {
    await p.context.close().catch(() => {});
    await p.browser.close().catch(() => {});
  }
}

export function save(name, data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  writeFileSync(`${RESULTS}/${name}`, text.endsWith("\n") ? text : `${text}\n`);
}

export const warnings = (person) => person.log.filter((l) => /signaling:|e2ee|dropped/i.test(l));
