import { useSyncExternalStore } from "react";

/**
 * One value, written by one component and read by another, without re-rendering the
 * parent of both. The call writes what the top island says, the room page's island reads it,
 * so the island stays one element from the join screen into the call.
 */
export interface Slot<T> {
  get: () => T | undefined;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createSlot<T>(): Slot<T> {
  // undefined = nothing written yet
  let value: T | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useSlot<T>(slot: Slot<T>): T | undefined {
  return useSyncExternalStore(slot.subscribe, slot.get, () => undefined);
}
