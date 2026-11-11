"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const MESSAGES: Record<string, string> = {
  server: "The server went offline. The call has ended.",
  lost: "Lost connection to the server. The call has ended.",
};

/** Why the last call ended (from ?ended=), then cleans the URL. */
export function EndedNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const reason = params.get("ended");
  // read once: the text stays after the URL is cleaned
  const [text] = useState(() => (reason ? (MESSAGES[reason] ?? null) : null));

  useEffect(() => {
    if (reason) router.replace("/");
  }, [reason, router]);

  if (!text) return null;
  return (
    <p className="home__error" role="status">
      {text}
    </p>
  );
}