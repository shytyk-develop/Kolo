"use client";

import type { InviteStatus } from "@/lib/types";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// every screen of the white zone; params live in history.state, so Back restores them
export type View =
  | { name: "home" }
  | { name: "new"; menu?: string }
  // guest: made for someone from Recent; copied: the link is on the clipboard already
  | { name: "ready"; code: string; lobby: boolean; guest?: string; copied?: boolean }
  // who: the name I know them by; status: what notify said
  | { name: "inviting"; code: string; lobby: boolean; who: string; handle: string; status: InviteState; sentAt: number }
  | { name: "host"; code: string }
  | { name: "guest"; code: string; host: string | null }
  | { name: "lost"; code: string }
  | { name: "ended"; code: string }
  | { name: "settings" };

// limited: notify said too many invites
export type InviteState = InviteStatus | "limited";

export type ViewName = View["name"];

interface Entry {
  view: View;
  depth: number;
}

export interface Nav {
  view: View;
  // 1 = deeper, -1 = back out
  dir: 1 | -1;
  // bumps when a screen is shown as the first thing (reload, back from a call): no transition into it
  epoch: number;
  push: (view: View) => void;
  replace: (view: View) => void;
  back: () => void;
  home: () => void;
  // home underneath, then this: Back from it goes home
  resetTo: (view: View) => void;
}

const HOME: Entry = { view: { name: "home" }, depth: 0 };

const same = (a: Entry, b: Entry) => a.depth === b.depth && JSON.stringify(a.view) === JSON.stringify(b.view);

const readEntry = (state: unknown): Entry | null => {
  const k = (state as { kolo?: Entry } | null)?.kolo;
  return k && typeof k.depth === "number" && k.view ? k : null;
};

// next.js keeps its own keys in history.state and copies them over on pushState
const write = (kind: "push" | "replace", entry: Entry) =>
  kind === "push" ? history.pushState({ kolo: entry }, "") : history.replaceState({ kolo: entry }, "");

/** One route, many screens: each screen is a history entry, so the browser's Back walks them. */
/** start: a screen to open first instead of home (read once, on the client). */
export function useViews(start?: () => View | null): Nav {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{ entry: Entry; dir: 1 | -1; instant: boolean }>({
    entry: HOME,
    dir: 1,
    instant: false,
  });
  // the entries this tab pushed, to show Back right away instead of after popstate
  const stack = useRef<Entry[]>([HOME]);
  const current = useRef(HOME);
  current.current = state.entry;
  // resetTo: once history is back at home, push this
  const pending = useRef<View | null>(null);

  const show = useCallback((entry: Entry, dir: 1 | -1) => {
    stack.current[entry.depth] = entry;
    stack.current.length = entry.depth + 1;
    setState((s) => (same(s.entry, entry) ? s : { entry, dir, instant: false }));
  }, []);

  // after a reload the browser still has the entry
  // before the first paint: after a reload the browser still has the entry; or a screen to open first
  const startRef = useRef(start);
  useLayoutEffect(() => {
    const saved = readEntry(history.state);
    if (saved && saved.depth > 0) {
      stack.current = Array.from({ length: saved.depth + 1 }, (_, i) => (i === saved.depth ? saved : HOME));
      setState({ entry: saved, dir: 1, instant: true });
      setEpoch((e) => e + 1);
      return;
    }
    const first = startRef.current?.();
    if (!first) return;
    const entry = { view: first, depth: 1 };
    write("push", entry);
    stack.current = [HOME, entry];
    setState({ entry, dir: 1, instant: true });
    setEpoch((e) => e + 1);
  }, []);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const entry = readEntry(e.state) ?? HOME;
      if (pending.current && entry.depth === 0) {
        const next = { view: pending.current, depth: 1 };
        pending.current = null;
        write("push", next);
        show(next, 1);
        return;
      }
      if (pending.current) return;
      show(entry, entry.depth < current.current.depth ? -1 : 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [show]);

  const push = useCallback(
    (view: View) => {
      const next = { view, depth: current.current.depth + 1 };
      write("push", next);
      show(next, 1);
    },
    [show],
  );

  const replace = useCallback(
    (view: View) => {
      const next = { view, depth: current.current.depth };
      write("replace", next);
      show(next, 1);
    },
    [show],
  );

  const back = useCallback(() => {
    const { depth } = current.current;
    if (depth === 0) return;
    const prev = stack.current[depth - 1];
    if (prev) show(prev, -1);
    history.back();
  }, [show]);

  const home = useCallback(() => {
    const { depth } = current.current;
    if (depth === 0) return;
    show(HOME, -1);
    history.go(-depth);
  }, [show]);

  const resetTo = useCallback(
    (view: View) => {
      const { depth } = current.current;
      if (depth === 0) {
        push(view);
        return;
      }
      pending.current = view;
      setState({ entry: { view, depth: 1 }, dir: 1, instant: false });
      history.go(-depth);
    },
    [push],
  );

  return useMemo(
    () => ({ view: state.entry.view, dir: state.dir, epoch, push, replace, back, home, resetTo }),
    [state, epoch, push, replace, back, home, resetTo],
  );
}
