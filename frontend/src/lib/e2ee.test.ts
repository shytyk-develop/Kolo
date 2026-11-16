// run: npm test  (node's own test runner, no extra packages)
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearBytes,
  deriveRoomKeys,
  fingerprintFromSdp,
  FRAME_OVERHEAD,
  FrameCipher,
  fromBase64Url,
  isRoomKey,
  KID_LENGTH,
  newRoomKey,
  open,
  safetyCode,
  seal,
  sealBinding,
  toBase64Url,
} from "./e2ee.ts";
import { preferOpusDtx, sessionIdOf } from "./sdp.ts";

const ROOM = "abc-defg-hij";
const FP_ANYA = "sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08";
const FP_BOB = "sha-256 1F:2E:3D:4C:5B:6A:79:88:97:A6:B5:C4:D3:E2:F1:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01";
const FP_EVE = "sha-256 AA:AA:AA:AA:5B:6A:79:88:97:A6:B5:C4:D3:E2:F1:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:02";

const frame = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const bytesOf = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)];

// ---------- the room key ----------

test("a new room key is 256 random bits, safe to put in a link", () => {
  const key = newRoomKey();
  assert.equal(fromBase64Url(key).length, 32);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(isRoomKey(key));
});

test("a thousand keys, no two the same", () => {
  assert.equal(new Set(Array.from({ length: 1000 }, newRoomKey)).size, 1000);
});

test("what isn't a key is refused", async () => {
  for (const bad of ["", "short", "x".repeat(44), "has space".padEnd(43, "x"), null, undefined, 42]) {
    assert.equal(isRoomKey(bad), false, String(bad));
  }
  await assert.rejects(deriveRoomKeys("nope", ROOM));
});

test("base64url round trip, every byte value", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromBase64Url(toBase64Url(all)), all);
  assert.doesNotMatch(toBase64Url(all), /[+/=]/);
});

test("the same key gives both sides the same id, and the id isn't the key", async () => {
  const key = newRoomKey();
  const [anya, bob] = await Promise.all([deriveRoomKeys(key, ROOM), deriveRoomKeys(key, ROOM)]);
  assert.equal(anya.kid, bob.kid);
  assert.equal(anya.kid.length, KID_LENGTH);
  assert.equal(anya.safetyTag, bob.safetyTag);
  assert.ok(!key.includes(anya.kid) && !key.includes(anya.safetyTag));
});

test("another key or another room: everything derived is different", async () => {
  const key = newRoomKey();
  const mine = await deriveRoomKeys(key, ROOM);
  const otherKey = await deriveRoomKeys(newRoomKey(), ROOM);
  const otherRoom = await deriveRoomKeys(key, "zzz-zzzz-zzz");
  assert.notEqual(mine.kid, otherKey.kid);
  assert.notEqual(mine.kid, otherRoom.kid);
  assert.notEqual(mine.safetyTag, otherKey.safetyTag);
  assert.notEqual(mine.safetyTag, otherRoom.safetyTag);
});

// ---------- signaling ----------

test("a sealed message opens with the same key and reads the same", async () => {
  const key = newRoomKey();
  const anya = await deriveRoomKeys(key, ROOM);
  const bob = await deriveRoomKeys(key, ROOM);
  const bound = sealBinding(ROOM, "p_anya", "p_bob");
  const message = { type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 AA:BB", n: 1 };

  const box = await seal(anya.signaling, bound, message);

  assert.deepEqual(await open(bob.signaling, bound, box), message);
  assert.match(box, /^[A-Za-z0-9_-]+$/);
});

test("the box shows nothing of what's inside", async () => {
  const keys = await deriveRoomKeys(newRoomKey(), ROOM);
  const box = await seal(keys.signaling, "x", { sdp: "a=fingerprint:sha-256 SECRETSECRET" });
  const raw = Buffer.from(fromBase64Url(box)).toString("latin1");
  assert.ok(!raw.includes("fingerprint") && !raw.includes("SECRET"));
});

test("the same message sealed twice looks different each time", async () => {
  const keys = await deriveRoomKeys(newRoomKey(), ROOM);
  assert.notEqual(await seal(keys.signaling, "x", { a: 1 }), await seal(keys.signaling, "x", { a: 1 }));
});

test("someone without the key can't open it", async () => {
  const anya = await deriveRoomKeys(newRoomKey(), ROOM);
  const eve = await deriveRoomKeys(newRoomKey(), ROOM);
  const box = await seal(anya.signaling, "x", { sdp: "v=0" });
  await assert.rejects(open(eve.signaling, "x", box));
});

test("a box changed on the way is refused, whichever byte", async () => {
  const keys = await deriveRoomKeys(newRoomKey(), ROOM);
  const box = fromBase64Url(await seal(keys.signaling, "x", { sdp: "v=0 a=fingerprint:sha-256 AA" }));
  for (const at of [0, 5, 12, 20, box.length - 1]) {
    const changed = new Uint8Array(box);
    changed[at] ^= 1;
    await assert.rejects(open(keys.signaling, "x", toBase64Url(changed)), `byte ${at}`);
  }
  await assert.rejects(open(keys.signaling, "x", toBase64Url(box.subarray(0, 20))));
});

test("a box can't be passed to another person, room or direction", async () => {
  const keys = await deriveRoomKeys(newRoomKey(), ROOM);
  const box = await seal(keys.signaling, sealBinding(ROOM, "p_anya", "p_bob"), { type: "offer" });
  await assert.rejects(open(keys.signaling, sealBinding(ROOM, "p_anya", "p_vera"), box));
  await assert.rejects(open(keys.signaling, sealBinding(ROOM, "p_bob", "p_anya"), box));
  await assert.rejects(open(keys.signaling, sealBinding("zzz-zzzz-zzz", "p_anya", "p_bob"), box));
  await assert.rejects(open(keys.signaling, sealBinding(ROOM, "p_anya", null), box));
});

// ---------- frames ----------

async function ciphers(senderId = "p_anya") {
  const key = newRoomKey();
  const send = new FrameCipher(await (await deriveRoomKeys(key, ROOM)).frameKey(senderId));
  const receive = new FrameCipher(await (await deriveRoomKeys(key, ROOM)).frameKey(senderId));
  return { key, send, receive };
}

test("a frame survives encrypt -> decrypt", async () => {
  const { send, receive } = await ciphers();
  const original = frame(0x90, 0x01, 0x02, 0x9d, 0x01, 0x2a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
  const encrypted = await send.encrypt(original, clearBytes("video", true));
  assert.deepEqual(bytesOf(await receive.decrypt(encrypted)), bytesOf(original));
  assert.equal(encrypted.byteLength, original.byteLength + FRAME_OVERHEAD);
});

test("only the header stays readable, the rest is unrecognizable", async () => {
  const { send } = await ciphers();
  const payload = Array.from({ length: 200 }, (_, i) => i % 7);
  const original = frame(0x10, 0x20, 0x30, ...payload);
  const encrypted = bytesOf(await send.encrypt(original, clearBytes("video", false)));
  assert.deepEqual(encrypted.slice(0, 3), [0x10, 0x20, 0x30]);
  const same = payload.filter((b, i) => encrypted[3 + i] === b).length;
  // a few bytes match by chance, no more
  assert.ok(same < 20, `${same} of 200 bytes unchanged`);
});

test("how much of a frame stays in the clear", () => {
  assert.equal(clearBytes("audio", false), 1);
  assert.equal(clearBytes("video", true), 10);
  assert.equal(clearBytes("video", false), 3);
});

test("the same frame twice gives different bytes (the iv never repeats)", async () => {
  const { send } = await ciphers();
  const original = frame(1, 2, 3, 4, 5, 6, 7, 8);
  const a = bytesOf(await send.encrypt(original, 1));
  const b = bytesOf(await send.encrypt(original, 1));
  assert.notDeepEqual(a, b);
  const ivs = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const out = bytesOf(await send.encrypt(original, 1));
    ivs.add(out.slice(-13, -1).join(","));
  }
  assert.equal(ivs.size, 500);
});

test("tiny and empty frames work too (opus sends 1-3 byte frames in silence)", async () => {
  const { send, receive } = await ciphers();
  for (const original of [frame(), frame(0xf8), frame(0xf8, 0xff, 0xfe)]) {
    const back = await receive.decrypt(await send.encrypt(original, clearBytes("audio", false)));
    assert.deepEqual(bytesOf(back), bytesOf(original));
  }
});

test("another room key can't decrypt", async () => {
  const { send } = await ciphers();
  const eve = (await ciphers()).receive;
  await assert.rejects(eve.decrypt(await send.encrypt(frame(1, 2, 3, 4, 5, 6), 1)));
});

test("frames of one sender don't decrypt as another's", async () => {
  const key = newRoomKey();
  const keys = await deriveRoomKeys(key, ROOM);
  const anya = new FrameCipher(await keys.frameKey("p_anya"));
  const asBob = new FrameCipher(await keys.frameKey("p_bob"));
  await assert.rejects(asBob.decrypt(await anya.encrypt(frame(1, 2, 3, 4, 5, 6), 1)));
});

test("a changed frame is dropped: payload, header or iv", async () => {
  const { send, receive } = await ciphers();
  const encrypted = new Uint8Array(await send.encrypt(frame(9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2), 3));
  for (const at of [0, 2, 5, encrypted.length - 20, encrypted.length - 5, encrypted.length - 1]) {
    const changed = new Uint8Array(encrypted);
    changed[at] ^= 0x01;
    await assert.rejects(receive.decrypt(changed.buffer), `byte ${at}`);
  }
});

test("a plain (never encrypted) frame is refused, not passed through", async () => {
  const { receive } = await ciphers();
  await assert.rejects(receive.decrypt(frame(0x90, 1, 2, 3)));
  await assert.rejects(receive.decrypt(new Uint8Array(400).fill(7).buffer));
  await assert.rejects(receive.decrypt(frame()));
});

// ---------- safety code ----------

test("both sides read the same code, whoever is first", async () => {
  const tag = (await deriveRoomKeys(newRoomKey(), ROOM)).safetyTag;
  const anya = await safetyCode(FP_ANYA, FP_BOB, tag);
  const bob = await safetyCode(FP_BOB, FP_ANYA, tag);
  assert.equal(anya, bob);
  assert.match(anya, /^\d{5} \d{5}$/);
});

test("someone in the middle: the two sides see different codes", async () => {
  const tag = (await deriveRoomKeys(newRoomKey(), ROOM)).safetyTag;
  // Anya's browser really talks to Eve, Bob's too
  const anya = await safetyCode(FP_ANYA, FP_EVE, tag);
  const bob = await safetyCode(FP_EVE, FP_BOB, tag);
  assert.notEqual(anya, bob);
  assert.notEqual(anya, await safetyCode(FP_ANYA, FP_BOB, tag));
});

test("the room key is part of the code", async () => {
  const one = (await deriveRoomKeys(newRoomKey(), ROOM)).safetyTag;
  const two = (await deriveRoomKeys(newRoomKey(), ROOM)).safetyTag;
  assert.notEqual(await safetyCode(FP_ANYA, FP_BOB, one), await safetyCode(FP_ANYA, FP_BOB, two));
  assert.notEqual(await safetyCode(FP_ANYA, FP_BOB, one), await safetyCode(FP_ANYA, FP_BOB));
});

test("without a key it's the same formula as tools/safety_code.py", async () => {
  const a = "sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08";
  assert.equal(await safetyCode(a.toLowerCase(), FP_BOB), await safetyCode(FP_BOB, a));
});

test("the fingerprint comes out of the sdp", () => {
  const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA:BB:CC\r\na=setup:actpass\r\n";
  assert.equal(fingerprintFromSdp(sdp), "sha-256 AA:BB:CC");
  assert.equal(fingerprintFromSdp("v=0\r\n"), null);
  assert.equal(fingerprintFromSdp(undefined), null);
});

// ---------- sdp ----------

test("opus gets fec and dtx, other lines stay", () => {
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "",
  ].join("\r\n");
  const out = preferOpusDtx(sdp);
  assert.ok(out.includes("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n"));
  assert.ok(out.includes("a=fmtp:63 111/111\r\n"));
  assert.equal(preferOpusDtx(out), out);
});

test("opus without an fmtp line gets one; no opus, no change", () => {
  const bare = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
  assert.ok(preferOpusDtx(bare).includes("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 useinbandfec=1;usedtx=1\r\n"));
  const video = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
  assert.equal(preferOpusDtx(video), video);
});

test("the sdp's session id tells one connection from another", () => {
  const first = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n";
  const restarted = "v=0\r\no=- 4611731400430051336 5 IN IP4 127.0.0.1\r\ns=-\r\n";
  const reloaded = "v=0\r\no=- 8125550107 2 IN IP4 127.0.0.1\r\ns=-\r\n";
  assert.equal(sessionIdOf(first), "4611731400430051336");
  assert.equal(sessionIdOf(first), sessionIdOf(restarted));
  assert.notEqual(sessionIdOf(first), sessionIdOf(reloaded));
  assert.equal(sessionIdOf("v=0\r\n"), null);
});
