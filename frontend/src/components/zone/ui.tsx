"use client";

import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { useMotionSet } from "@/lib/motion";
import { initialsOf, toneOf } from "@/lib/people";
import { createStore, useStore } from "@/lib/store";

import { CheckIcon, CopyIcon, LockIcon, Spinner } from "../Icons";

type MotionButtonProps = ComponentProps<typeof motion.button>;

/** A button that gives under the finger (0.97) and springs back. */
export function Press({ disabled, ...rest }: MotionButtonProps) {
  const m = useMotionSet();
  return <motion.button type="button" disabled={disabled} whileTap={disabled ? undefined : m.press} transition={m.snap} {...rest} />;
}

type Tone = "primary" | "secondary" | "green" | "dark" | "danger";

interface ButtonProps extends Omit<MotionButtonProps, "children"> {
  tone?: Tone;
  icon?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}

export function Button({ tone = "primary", icon, busy, className, children, ...rest }: ButtonProps) {
  return (
    <Press className={`zbtn zbtn--${tone}${className ? ` ${className}` : ""}`} aria-busy={busy || undefined} {...rest}>
      {(icon || busy) && <span className="zbtn__icon">{busy ? <Spinner size={18} /> : icon}</span>}
      <span>{children}</span>
    </Press>
  );
}

/** Round icon-only button. */
export function IconButton({
  label,
  tone = "fill",
  className,
  children,
  ...rest
}: Omit<MotionButtonProps, "children"> & { label: string; tone?: "fill" | "ink" | "plain"; children: ReactNode }) {
  return (
    <Press className={`ibtn ibtn--${tone}${className ? ` ${className}` : ""}`} aria-label={label} title={label} {...rest}>
      {children}
    </Press>
  );
}

/** iOS-like switch: the thumb springs across, the green fades in under it. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  const m = useMotionSet();
  return (
    <motion.button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="zswitch"
      data-on={checked || undefined}
      onClick={() => onChange(!checked)}
      whileTap="pressed"
    >
      <motion.span className="zswitch__on" initial={false} animate={{ opacity: checked ? 1 : 0 }} transition={m.sweep} />
      <motion.span
        className="zswitch__thumb"
        layout
        transition={m.snap}
        style={{ originX: checked ? 1 : 0 }}
        variants={m.reduced ? undefined : { pressed: { scaleX: 1.14 } }}
      />
    </motion.button>
  );
}

/** Initials on a color picked from the name: the same name always looks the same. */
export const Avatar = memo(function Avatar({ name, size, className }: { name: string; size: number; className?: string }) {
  const tone = toneOf(name);
  const initials = initialsOf(name);
  return (
    <span
      className={`zav${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (initials.length > 1 ? 0.36 : 0.44)),
        background: tone.bg,
        color: tone.fg,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
});

/** Copy icon that turns into a check. */
export function CopyGlyph({ done, size = 18, idle }: { done: boolean; size?: number; idle?: ReactNode }) {
  const m = useMotionSet();
  const swap = m.reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.4, rotate: -30 },
        animate: { opacity: 1, scale: 1, rotate: 0 },
        exit: { opacity: 0, scale: 0.4, rotate: 30 },
      };
  return (
    <span className="morphicon" style={{ width: size, height: size }} aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={done ? "done" : "idle"} {...swap} transition={m.snap}>
          {done ? <CheckIcon size={size} strokeWidth={2.2} /> : (idle ?? <CopyIcon size={size} />)}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Copies, then shows "done" for a moment. Takes a promise too (a link that's still being made). */
export function useCopy(ms = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string | Promise<string>) => {
      const ok = await copyText(text);
      if (!ok) return false;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
      return true;
    },
    [ms],
  );
  return { copied, copy };
}

export async function copyText(text: string | Promise<string>): Promise<boolean> {
  try {
    // safari: the write has to start in the tap, the text can come later
    if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="seclabel">
      <span>{children}</span>
      {aside !== undefined && <span className="seclabel__aside">{aside}</span>}
    </div>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return (
    <p className="footnote">
      <LockIcon size={12} />
      <span>{children}</span>
    </p>
  );
}

// ---------- toast ----------

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const toastStore = createStore<ToastItem | null>(() => null, null);
let toastId = 0;

export function toast(text: string, action?: ToastItem["action"]) {
  toastStore.set({ id: ++toastId, text, action });
}

/** One toast at a time, at the bottom of the white panel. */
export function ToastHost() {
  const item = useStore(toastStore);
  const m = useMotionSet();
  useEffect(() => {
    if (!item) return;
    const id = setTimeout(() => toastStore.set((t) => (t?.id === item.id ? null : t)), item.action ? 5000 : 2600);
    return () => clearTimeout(id);
  }, [item]);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence mode="popLayout">
        {item && (
          <motion.div key={item.id} className="toast" variants={m.pop} initial="hidden" animate="shown" exit="gone" layout>
            <span>{item.text}</span>
            {item.action && (
              <Press
                className="toast__action"
                onClick={() => {
                  item.action?.run();
                  toastStore.set(null);
                }}
              >
                {item.action.label}
              </Press>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
