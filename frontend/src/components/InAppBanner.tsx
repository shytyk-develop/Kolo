"use client";

import { useEffect, useState } from "react";

import { CheckIcon, CopyIcon } from "@/components/Icons";
import { useCopy } from "@/components/zone/ui";

// Telegram's in-app browser: the camera and mic often don't work there
function inTelegram(): boolean {
  const w = window as Window & { TelegramWebviewProxy?: unknown };
  return Boolean(w.TelegramWebviewProxy) || /Telegram/i.test(navigator.userAgent);
}

export function InAppBanner() {
  const [shown, setShown] = useState(false);
  const { copied, copy } = useCopy();
  // after mount: the server can't know
  useEffect(() => setShown(inTelegram()), []);
  if (!shown) return null;
  return (
    <div className="inapp" role="status" data-testid="inapp-banner">
      <span className="inapp__text">Open in your browser for camera access</span>
      <button type="button" className="inapp__copy" onClick={() => void copy(window.location.href)}>
        {copied ? <CheckIcon size={14} strokeWidth={2.6} /> : <CopyIcon size={14} strokeWidth={2} />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
