import { createStore, readJson, writeJson } from "./store";

// no accounts: a person is their browser's id (sent over signaling) plus the name they gave
export interface Person {
  id: string;
  name: string;
}

export interface Contact extends Person {
  lastCallAt: number;
  lastDurationMs: number;
  calls: number;
  // the call this row last counted, so a rejoin doesn't count it twice
  lastCallId?: string;
  // renamed here: their own name changes don't overwrite it
  renamed?: boolean;
}

export interface Profile {
  // random, made once per browser: how the people I call recognize me
  id: string;
  name: string;
  rememberPeople: boolean;
  lobbyDefault: boolean;
}

export interface LastCall {
  id: string;
  code: string;
  // the other person, null if nobody came
  peer: Person | null;
  // when the other person connected
  startedAt: number | null;
  status: "live" | "dropped" | "ended";
  droppedAt?: number;
  endedAt?: number;
  // reconnect tries used so far
  attempt?: number;
  saved?: boolean;
  // home opens this screen once
  show?: "lost" | "ended";
}

const RECENTS_KEY = "kolo.recents.v1";
const PROFILE_KEY = "kolo.profile.v1";
// before profile v1: settings and name lived apart
const OLD_PROFILE_KEY = "kolo:profile";
// the call page's join form still reads the name from here
const NAME_KEY = "kolo:name";
const LAST_CALL_KEY = "kolo:lastCall";

// a dropped call stays on home this long, if its room is still there
export const DROPPED_SHOWN_MS = 30 * 60_000;

const normName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

// someone whose browser sent no id (an older client, or a row from before ids): known by name only
export const nameKey = (name: string) => `name:${normName(name)}`;
const byNameOnly = (id: string) => id.startsWith("name:");

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** The other side of a call as signaling describes them. */
export const personOf = (peer: { name: string; client_id?: string }): Person => ({
  id: peer.client_id ?? nameKey(peer.name),
  name: peer.name,
});

// rows from before ids were keyed by the bare name: once, give them the name: prefix
const MIGRATED_KEY = "kolo.recents.ids";
function migrateRecents(list: Contact[]): Contact[] {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return list;
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    return list;
  }
  const out = list.map((c) => (byNameOnly(c.id) ? c : { ...c, id: nameKey(c.name) }));
  writeJson("local", RECENTS_KEY, out);
  return out;
}

export const recents = createStore<Contact[]>(
  () => migrateRecents(readJson<Contact[]>("local", RECENTS_KEY) ?? []),
  [],
  (list) => writeJson("local", RECENTS_KEY, list),
);

export const profile = createStore<Profile>(
  () => {
    const saved = readJson<Partial<Profile>>("local", PROFILE_KEY);
    if (saved?.id) {
      return { id: saved.id, name: saved.name ?? "", rememberPeople: saved.rememberPeople ?? true, lobbyDefault: saved.lobbyDefault ?? false };
    }
    // first time on v1: carry over the old settings and name, make the id once
    const old = readJson<Partial<Profile>>("local", OLD_PROFILE_KEY);
    let name = "";
    try {
      name = localStorage.getItem(NAME_KEY) ?? "";
    } catch {}
    const made: Profile = { id: newId(), name, rememberPeople: old?.rememberPeople ?? true, lobbyDefault: old?.lobbyDefault ?? false };
    writeJson("local", PROFILE_KEY, made);
    writeJson("local", OLD_PROFILE_KEY, null);
    return made;
  },
  { id: "", name: "", rememberPeople: true, lobbyDefault: false },
  (value) => {
    writeJson("local", PROFILE_KEY, value);
    try {
      localStorage.setItem(NAME_KEY, value.name.trim());
    } catch {}
  },
);

// this tab only: a call left behind is about this session
export const lastCall = createStore<LastCall | null>(
  () => {
    const saved = readJson<LastCall & { peer: Person | string | null }>("session", LAST_CALL_KEY);
    // before ids the peer was just a name
    if (saved && typeof saved.peer === "string") return { ...saved, peer: { id: nameKey(saved.peer), name: saved.peer } };
    return saved;
  },
  null,
  (value) => writeJson("session", LAST_CALL_KEY, value),
);

// the waiting room switch on home: what new rooms start with
export const lobby = createStore<boolean>(() => profile.get().lobbyDefault, false);

/** Someone was in a call with me: to the top of Recent, if I keep people. Upserts by their id. */
export function rememberCall(person: Person, durationMs: number, callId: string): boolean {
  const name = person.name.trim();
  if (!name || !profile.get().rememberPeople) return false;
  recents.set((list) => {
    // the same browser, or a row made before they had an id (same name): that's them
    const old = list.find((c) => c.id === person.id) ?? list.find((c) => byNameOnly(c.id) && c.id === nameKey(name));
    const again = old?.lastCallId === callId;
    const entry: Contact = {
      id: person.id,
      // their name now, unless I renamed them here
      name: old?.renamed ? old.name : name,
      renamed: old?.renamed,
      lastCallAt: Date.now(),
      lastDurationMs: again && old ? Math.max(old.lastDurationMs, durationMs) : durationMs,
      calls: (old?.calls ?? 0) + (again ? 0 : 1),
      lastCallId: callId,
    };
    return [entry, ...list.filter((c) => c !== old && c.id !== person.id)];
  });
  return true;
}

/** Removes and hands back a way to put it back where it was. */
export function removeRecent(id: string): () => void {
  const list = recents.get();
  const index = list.findIndex((c) => c.id === id);
  if (index < 0) return () => {};
  const removed = list[index];
  recents.set(list.filter((c) => c.id !== id));
  return () =>
    recents.set((now) => {
      if (now.some((c) => c.id === id)) return now;
      const next = [...now];
      next.splice(Math.min(index, next.length), 0, removed);
      return next;
    });
}

export function clearRecents(): () => void {
  const before = recents.get();
  recents.set([]);
  return () => recents.set((now) => (now.length ? now : before));
}

// the id stays: it's what the next call with them matches on
export function renameRecent(id: string, name: string) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return;
  recents.set((list) => list.map((c) => (c.id === id ? { ...c, name: clean, renamed: true } : c)));
}

export function inviteLink(code: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/r/${code}`;
}

// the link as people see it: no scheme
export const displayLink = (code: string) => inviteLink(code).replace(/^https?:\/\//, "");

// avatars: an initial on a color picked from the name, the same name always gets the same one
const TONES = [
  { bg: "#1c1c1e", fg: "#fff" },
  { bg: "#30d158", fg: "#000" },
  { bg: "#3a3a3c", fg: "#fff" },
  { bg: "#636366", fg: "#fff" },
  { bg: "#8e8e93", fg: "#fff" },
  { bg: "#d1d1d6", fg: "#000" },
];

export function toneOf(name: string): { bg: string; fg: string } {
  let hash = 0;
  for (const ch of normName(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}
