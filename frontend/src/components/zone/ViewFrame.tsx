"use client";

import { animate, motion, useMotionValue } from "motion/react";
import { useLayoutEffect, type ComponentProps, type CSSProperties, type ReactNode } from "react";

import { CloseIcon } from "@/components/Icons";
import type { Nav, ViewName } from "@/hooks/useViews";
import { useMotionSet } from "@/lib/motion";

import { tabTrack } from "./Tab";
import { IconButton } from "./ui";

/** One screen of the white panel: rows sweep in 25 ms apart, the whole thing fades and slides out. */
export function ViewFrame({
  name,
  dir,
  className,
  style,
  children,
}: {
  name: ViewName;
  dir: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const m = useMotionSet();
  const y = useMotionValue(0);
  // the tab just went up: start as far down as it was and come up with it, on its spring
  useLayoutEffect(() => {
    const travel = tabTrack.prev - tabTrack.now;
    if (m.reduced || travel < 4) return;
    y.set(travel);
    const run = animate(y, 0, m.morph);
    return () => run.stop();
    // only when this screen arrives
  }, []);
  return (
    <motion.section
      className={`view view--${name}${className ? ` ${className}` : ""}`}
      style={{ ...style, y }}
      variants={m.frame}
      custom={dir}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      {children}
    </motion.section>
  );
}

/** A row that takes part in the stagger. */
export function Row({ className, ...rest }: ComponentProps<typeof motion.div>) {
  const m = useMotionSet();
  return <motion.div className={className} variants={m.row} {...rest} />;
}

/** The space the tab sits in, with the close button on the right. */
export function ViewHead({ onClose }: { onClose?: () => void }) {
  return (
    <div className="vhead">
      {onClose && (
        <Row className="vhead__close">
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon size={20} strokeWidth={2.2} />
          </IconButton>
        </Row>
      )}
    </div>
  );
}

// plain div: the rows inside stay direct stagger children of the frame
export function ViewBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`vbody${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function ViewFoot({ children }: { children: ReactNode }) {
  return <div className="vfoot">{children}</div>;
}

export type ViewProps = { nav: Nav; dir: number };
