"use client";

import { createContext, useContext } from "react";

export interface ZoneApi {
  // into the real call at /r/[code], the camera glides there
  enterCall: (code: string) => void;
  // my name, asked once if there isn't one yet; null = they closed the question
  ensureName: () => Promise<string | null>;
}

export const ZoneContext = createContext<ZoneApi | null>(null);

export function useZone(): ZoneApi {
  const zone = useContext(ZoneContext);
  if (!zone) throw new Error("useZone outside WhiteZone");
  return zone;
}
