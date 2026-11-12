"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useMotionSet } from "@/lib/motion";
import { server } from "@/lib/server";
import { useStore } from "@/lib/store";

const BACK_MS = 1600;

/** "Server is offline" over the camera, then a short "Back online". */
export function ServerPill() {
  const m = useMotionSet();
  const status = useStore(server);
  const [back, setBack] = useState(false);
  const was = useRef(status);

  useEffect(() => {
    const from = was.current;
    was.current = status;
    if (from === "offline" && status === "online") {
      setBack(true);
      const id = setTimeout(() => setBack(false), BACK_MS);
      return () => clearTimeout(id);
    }
    setBack(false);
  }, [status]);

  const shown = status === "offline" ? "offline" : back ? "back" : null;
  return (
    <div className="srvpill__slot" aria-live="polite">
      <AnimatePresence mode="wait">
        {shown && (
          <motion.div
            key={shown}
            className="srvpill"
            data-state={shown}
            data-testid="server-status"
            initial={{ opacity: 0, y: m.reduced ? 0 : -8 }}
            animate={{ opacity: 1, y: 0, transition: m.sweep }}
            exit={{ opacity: 0, y: m.reduced ? 0 : -4, transition: m.leave }}
          >
            <i aria-hidden />
            {shown === "offline" ? (
              <>
                Server is offline
                <span className="srvpill__sub"> · reconnecting</span>
              </>
            ) : (
              "Back online"
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
