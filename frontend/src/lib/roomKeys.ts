import { deriveRoomKeys, isRoomKey, KID_LENGTH, newRoomKey, type RoomKeys } from "./e2ee";

// the room's secret: only in the link's #fragment and in this browser, never sent to a server
const storageKey = (code: string) => `kolo:key:${code}`;
// rooms live a day
const KEEP_MS = 48 * 60 * 60_000;

interface Saved {
  key: string;
  at: number;
}

function prune(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const name = localStorage.key(i);
    if (!name?.startsWith("kolo:key:")) continue;
    try {
      const saved = JSON.parse(localStorage.getItem(name) ?? "") as Saved;
      if (Date.now() - saved.at > KEEP_MS) localStorage.removeItem(name);
    } catch {
      localStorage.removeItem(name);
    }
  }
}

export const roomKeys = {
  get(code: string): string | null {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(code)) ?? "null") as Saved | null;
      return saved && isRoomKey(saved.key) ? saved.key : null;
    } catch {
      return null;
    }
  },

  save(code: string, key: string): void {
    if (!isRoomKey(key)) return;
    try {
      prune();
      localStorage.setItem(storageKey(code), JSON.stringify({ key, at: Date.now() } satisfies Saved));
    } catch {}
  },

  /** For a room this browser just made. */
  create(code: string): string {
    const key = newRoomKey();
    this.save(code, key);
    return key;
  },
};

/** "#k=<key>" from a link, null if it isn't there. */
export function keyFromHash(hash: string): string | null {
  const key = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  return isRoomKey(key) ? key : null;
}

export const keyHash = (key: string | null) => (key ? `#k=${key}` : "");

/** Takes the key out of the address bar into storage. The fragment stays: the address can be shared as is. */
export function adoptKeyFromLocation(code: string): string | null {
  if (typeof window === "undefined") return null;
  const fromLink = keyFromHash(window.location.hash);
  if (fromLink) roomKeys.save(code, fromLink);
  return fromLink ?? roomKeys.get(code);
}

export type FrameSupport = "script" | "streams" | null;

/** Can this browser encrypt single frames, and how. */
export function frameSupport(): FrameSupport {
  if (typeof window === "undefined" || typeof RTCRtpSender === "undefined" || typeof Worker === "undefined") return null;
  // needs VP8 to be set: with H264 the encrypted frames would break
  if (typeof RTCRtpTransceiver === "undefined" || !("setCodecPreferences" in RTCRtpTransceiver.prototype)) return null;
  if ("RTCRtpScriptTransform" in window && "transform" in RTCRtpSender.prototype) return "script";
  if ("createEncodedStreams" in RTCRtpSender.prototype) return "streams";
  return null;
}

export interface RoomCrypto {
  roomKey: string;
  roomCode: string;
  keys: RoomKeys;
  frames: FrameSupport;
  /** What the others see of it: key id + "f" (frames too) or "s" (signaling only). */
  kid: string;
}

export async function roomCrypto(code: string, key: string | null): Promise<RoomCrypto | null> {
  if (!key || typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const keys = await deriveRoomKeys(key, code);
    const frames = frameSupport();
    return { roomKey: key, roomCode: code, keys, frames, kid: keys.kid + (frames ? "f" : "s") };
  } catch {
    return null;
  }
}

/** What a peer's kid says: same key as mine? can they do frames? */
export function readKid(mine: RoomCrypto | null, theirs: string | undefined): { sealed: boolean; frames: boolean } {
  if (!mine || !theirs || theirs.length !== KID_LENGTH + 1) return { sealed: false, frames: false };
  const sealed = theirs.slice(0, KID_LENGTH) === mine.keys.kid;
  return { sealed, frames: sealed && Boolean(mine.frames) && theirs.endsWith("f") };
}
