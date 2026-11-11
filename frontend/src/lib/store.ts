import { useSyncExternalStore } from "react";

/** A value outside React, read with useStore: only its readers re-render when it changes. */
export interface Store<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
  // what the server renders, before storage can be read
  server: T;
}

export function createStore<T>(load: () => T, server: T, save?: (value: T) => void): Store<T> {
  let value: T;
  let loaded = false;
  const listeners = new Set<() => void>();
  const get = () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
  return {
    get,
    set: (next) => {
      // load first: a later get() must not read storage over this value
      const prev = get();
      const v = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      if (Object.is(v, prev)) return;
      value = v;
      save?.(v);
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    server,
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.server);
}

// safari private mode and blocked storage throw
export function readJson<T>(storage: "local" | "session", key: string): T | null {
  try {
    const raw = (storage === "local" ? localStorage : sessionStorage).getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeJson(storage: "local" | "session", key: string, value: unknown) {
  try {
    const s = storage === "local" ? localStorage : sessionStorage;
    if (value === null || value === undefined) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {}
}
