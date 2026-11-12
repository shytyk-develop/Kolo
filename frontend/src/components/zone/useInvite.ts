"use client";

import { useCallback, useState } from "react";

import type { InviteState, Nav } from "@/hooks/useViews";
import { ApiError, createRoom, errorText, inviteByHandle } from "@/lib/api";
import { lobby } from "@/lib/people";

import { toast } from "./ui";
import { useZone } from "./ZoneContext";

/** A Telegram invite by Kolo ID, into a new room (or `code`), then "Inviting" with what notify said. */
export function useInvite(nav: Nav) {
  const zone = useZone();
  // the handle being invited right now
  const [busy, setBusy] = useState<string | null>(null);

  const send = useCallback(
    async (handle: string, who: string, opts: { code?: string; lobby?: boolean; replace?: boolean } = {}) => {
      if (busy) return;
      setBusy(handle);
      try {
        let code = opts.code;
        let lobbyOn = opts.lobby ?? lobby.get();
        if (!code) {
          const name = await zone.ensureName();
          if (!name) return;
          const room = await createRoom({ lobby: lobbyOn, name });
          code = room.code;
          lobbyOn = room.lobby;
        }
        let status: InviteState;
        try {
          status = await inviteByHandle(code, handle);
        } catch (err) {
          if (!(err instanceof ApiError && err.code === "invite_rate_limited")) {
            toast(errorText(err, "Couldn’t send the invite. Try again."));
            // the room is there anyway: share it by link
            if (!opts.code) nav.push({ name: "ready", code, lobby: lobbyOn, guest: who });
            return;
          }
          status = "limited";
        }
        const view = { name: "inviting", code, lobby: lobbyOn, who, handle, status, sentAt: Date.now() } as const;
        if (opts.replace) nav.replace(view);
        else nav.push(view);
      } catch (err) {
        toast(errorText(err, "Couldn’t make a room. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [busy, nav, zone],
  );

  return { busy, send };
}
