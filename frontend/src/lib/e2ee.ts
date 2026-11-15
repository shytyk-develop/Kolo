// End-to-end crypto of a room. No imports on purpose: the worker and the node tests load this file as is.
//
// One secret per room, made in the creator's browser and carried only in the link's #fragment.
// Everything else is derived from it (HKDF): an id to compare keys, the signaling key,
// one frame key per sender, a tag for the safety code.

const text = new TextEncoder();
const fromText = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const KEY_BYTES = 32;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** 256 random bits, as they go into the link. */
export function newRoomKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

export const isRoomKey = (value: unknown): value is string => typeof value === "string" && KEY_RE.test(value);

// 16 chars of key fingerprint + 1 char: f = can encrypt frames, s = signaling only
export const KID_LENGTH = 16;

export interface RoomKeys {
  /** Same key on both sides gives the same id; says nothing about the key itself. */
  kid: string;
  /** Mixed into the safety code. */
  safetyTag: string;
  signaling: CryptoKey;
  frameKey(senderId: string): Promise<CryptoKey>;
}

export async function deriveRoomKeys(roomKey: string, roomCode: string): Promise<RoomKeys> {
  if (!isRoomKey(roomKey)) throw new Error("bad room key");
  const base = await crypto.subtle.importKey("raw", fromBase64Url(roomKey), "HKDF", false, ["deriveKey", "deriveBits"]);
  // the room code is mixed in: the same key in another room gives other keys
  const salt = text.encode(`kolo/v1/${roomCode}`);
  const params = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt, info: text.encode(info) });
  const bits = async (info: string, length: number) =>
    new Uint8Array(await crypto.subtle.deriveBits(params(info), base, length));
  const aes = (info: string) =>
    crypto.subtle.deriveKey(params(info), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

  const [kid, tag, signaling] = await Promise.all([bits("kid", 96), bits("safety", 128), aes("signaling")]);
  return {
    kid: toBase64Url(kid),
    safetyTag: toBase64Url(tag),
    signaling,
    frameKey: (senderId) => aes(`frame/${senderId}`),
  };
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts a signaling message. `bound` ties it to room, sender and receiver: it can't be replayed elsewhere. */
export async function seal(key: CryptoKey, bound: string, message: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = text.encode(JSON.stringify(message));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(bound) }, key, data);
  const box = new Uint8Array(IV_BYTES + sealed.byteLength);
  box.set(iv);
  box.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64Url(box);
}

/** Throws if the box was changed, made with another key, or meant for someone else. */
export async function open<T>(key: CryptoKey, bound: string, box: string): Promise<T> {
  const bytes = fromBase64Url(box);
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("box too short");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: text.encode(bound) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(fromText.decode(plain)) as T;
}

export const sealBinding = (room: string, from: string, to: string | null) => `${room}|${from}|${to ?? "*"}`;

/**
 * The first bytes of a frame stay readable: the browser needs them to tell a key frame from the
 * rest and to route the packets. VP8: 10 on a key frame, 3 otherwise. Opus: the 1 byte header.
 */
export function clearBytes(kind: "audio" | "video", keyFrame: boolean): number {
  if (kind === "audio") return 1;
  return keyFrame ? 10 : 3;
}

// header | ciphertext + tag | iv | header length
const TRAILER_BYTES = IV_BYTES + 1;
export const FRAME_OVERHEAD = TAG_BYTES + TRAILER_BYTES;

/** One direction of one track. A counter in the iv: never the same iv twice with this key. */
export class FrameCipher {
  // random part per instance: two tracks with the same key don't collide
  private prefix = crypto.getRandomValues(new Uint8Array(4));
  private counter = 0;
  private key: CryptoKey;

  constructor(key: CryptoKey) {
    this.key = key;
  }

  private nextIv(): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(IV_BYTES);
    iv.set(this.prefix);
    const view = new DataView(iv.buffer);
    this.counter += 1;
    view.setUint32(4, Math.floor(this.counter / 2 ** 32));
    view.setUint32(8, this.counter >>> 0);
    return iv;
  }

  async encrypt(frame: ArrayBuffer, clear: number): Promise<ArrayBuffer> {
    const data = new Uint8Array(frame);
    const head = Math.min(clear, data.length);
    const iv = this.nextIv();
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: data.subarray(0, head) },
      this.key,
      data.subarray(head),
    );
    const out = new Uint8Array(head + sealed.byteLength + TRAILER_BYTES);
    out.set(data.subarray(0, head));
    out.set(new Uint8Array(sealed), head);
    out.set(iv, head + sealed.byteLength);
    out[out.length - 1] = head;
    return out.buffer;
  }

  /** Throws on anything that wasn't encrypted with this key: plain frames, changed frames, other senders. */
  async decrypt(frame: ArrayBuffer): Promise<ArrayBuffer> {
    const data = new Uint8Array(frame);
    const head = data[data.length - 1];
    if (data.length < FRAME_OVERHEAD || head + FRAME_OVERHEAD > data.length) throw new Error("not an encrypted frame");
    const ivAt = data.length - TRAILER_BYTES;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(ivAt, ivAt + IV_BYTES), additionalData: data.subarray(0, head) },
      this.key,
      data.subarray(head, ivAt),
    );
    const out = new Uint8Array(head + plain.byteLength);
    out.set(data.subarray(0, head));
    out.set(new Uint8Array(plain), head);
    return out.buffer;
  }
}

/** Gets the a=fingerprint:... value out of an SDP. */
export function fingerprintFromSdp(sdp: string | undefined): string | null {
  const line = sdp?.split(/\r?\n/).find((l) => l.startsWith("a=fingerprint:"));
  return line ? line.slice("a=fingerprint:".length).trim() : null;
}

/**
 * Ten digits both people can read out loud. Made from both DTLS fingerprints (who the browsers
 * really talk to) and, when the room has a key, a tag only its holders can compute.
 * Someone in the middle has other fingerprints, so the two sides see different codes.
 */
export async function safetyCode(fingerprintA: string, fingerprintB: string, safetyTag = ""): Promise<string> {
  const material = [fingerprintA.toUpperCase(), fingerprintB.toUpperCase()].sort().join("|") + (safetyTag ? `|${safetyTag}` : "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(material)));
  // first 8 bytes as a number
  let value = 0n;
  for (const byte of digest.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  const digits = (value % 10_000_000_000n).toString().padStart(10, "0");
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}
