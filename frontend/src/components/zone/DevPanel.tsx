"use client";

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/api";
import { lastCall, recents } from "@/lib/people";

/** Dev only: which backend this talks to and whether it answers. Nothing here fakes data. */
export function DevPanel() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<"…" | "up" | "down">("…");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setHealth("…");
    fetch(`${API_URL}/health/ready`)
      .then((r) => alive && setHealth(r.ok ? "up" : "down"))
      .catch(() => alive && setHealth("down"));
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <div className="devpanel" data-open={open || undefined}>
      <button type="button" className="devpanel__pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        dev
      </button>
      {open && (
        <div className="devpanel__body">
          <p>API</p>
          <div className="devpanel__row">
            <span className="devpanel__value">
              {API_URL} · {health}
            </span>
          </div>
          <p>This browser</p>
          <div className="devpanel__row">
            <button type="button" onClick={() => recents.set([])}>
              Clear recents
            </button>
            <button type="button" onClick={() => lastCall.set(null)}>
              Forget last call
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
