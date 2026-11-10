"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useLocalMedia } from "@/hooks/useLocalMedia";

export type LocalMedia = ReturnType<typeof useLocalMedia>;

const MediaContext = createContext<LocalMedia | null>(null);

// camera lives above the pages: home -> join -> call keep one stream, no second permission prompt
export function MediaProvider({ children }: { children: ReactNode }) {
  const media = useLocalMedia();
  return <MediaContext value={media}>{children}</MediaContext>;
}

export function useMedia(): LocalMedia {
  const media = useContext(MediaContext);
  if (!media) throw new Error("useMedia outside MediaProvider");
  return media;
}
