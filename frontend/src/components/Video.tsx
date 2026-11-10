"use client";

import { memo, useEffect, useRef } from "react";

interface Props {
  stream: MediaStream | null;
  mirror?: boolean;
  className?: string;
}

// always muted: sound goes through one <audio>, or copies of the same video would play it twice
export const Video = memo(function Video({ stream, mirror, className }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  // srcObject can't be a jsx attribute
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return (
    <video
      ref={ref}
      className={`video${mirror ? " video--mirror" : ""}${className ? ` ${className}` : ""}`}
      autoPlay
      playsInline
      muted
      disablePictureInPicture
    />
  );
});

/** Plays the other side's sound. */
export function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}
