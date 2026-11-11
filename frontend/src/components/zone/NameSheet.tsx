"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useMotionSet } from "@/lib/motion";
import { profile } from "@/lib/people";
import { createStore, useStore } from "@/lib/store";

import { Button, Press } from "./ui";

// someone is waiting for my name
const asking = createStore<((name: string | null) => void) | null>(() => null, null);

/** My name for calls; asked once, then it lives in Settings. */
export function ensureName(): Promise<string | null> {
  const known = profile.get().name.trim();
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    asking.get()?.(null);
    asking.set(() => resolve);
  });
}

export function NameSheet() {
  const resolve = useStore(asking);
  const m = useMotionSet();
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resolve) return;
    setValue("");
    const id = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && answer(null);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
    // answer only reads the current resolver
  }, [resolve]);

  const answer = (name: string | null) => {
    const done = asking.get();
    asking.set(null);
    done?.(name);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = value.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) {
      input.current?.focus();
      return;
    }
    profile.set((p) => ({ ...p, name }));
    answer(name);
  };

  return (
    <AnimatePresence>
      {resolve && (
        <motion.div key="veil" className="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={m.sweep} onClick={() => answer(null)} />
      )}
      {resolve && (
        <motion.form
          key="name"
          className="sheet namesheet"
          onSubmit={submit}
          initial={{ y: m.reduced ? 0 : "105%", opacity: m.reduced ? 0 : 1 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: m.reduced ? 0 : "105%", opacity: m.reduced ? 0 : 1 }}
          transition={m.morph}
          role="dialog"
          aria-modal="true"
          aria-labelledby="name-sheet-title"
        >
          <div className="namesheet__card">
            <p id="name-sheet-title" className="namesheet__title">
              What’s your name?
            </p>
            <p className="namesheet__text">The person you call sees it. You can change it in Settings.</p>
            <input
              ref={input}
              className="zfield"
              value={value}
              maxLength={40}
              autoComplete="name"
              placeholder="Your name"
              onChange={(e) => setValue(e.target.value)}
              data-testid="name-sheet-input"
              aria-label="Your name"
            />
          </div>
          <Button type="submit" data-testid="name-sheet-save">
            Continue
          </Button>
          <Press className="namesheet__cancel" onClick={() => answer(null)}>
            Not now
          </Press>
        </motion.form>
      )}
    </AnimatePresence>
  );
}
