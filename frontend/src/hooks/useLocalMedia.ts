"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Camera and mic. getUserMedia only works on https:// or localhost. */
export function useLocalMedia() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const pending = useRef<Promise<void> | null>(null);

  const start = useCallback((): Promise<void> => {
    // strict mode calls this twice, a second camera stream would never get stopped
    if (streamRef.current) return Promise.resolve();
    if (pending.current) return pending.current;

    pending.current = (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
        streamRef.current = media;
        setStream(media);
        setError(null);
      } catch (err) {
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Allow camera and microphone access in your browser settings"
            : "Could not turn on the camera or microphone",
        );
      } finally {
        pending.current = null;
      }
    })();
    return pending.current;
  }, []);

  const toggleAudio = useCallback(() => {
    const next = !audioOn;
    // the track keeps sending silence, no renegotiation
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setAudioOn(next);
    return next;
  }, [audioOn]);

  const toggleVideo = useCallback(() => {
    const next = !videoOn;
    // the track keeps sending black frames
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setVideoOn(next);
    return next;
  }, [videoOn]);

  // camera light off when the page goes away
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return { stream, error, audioOn, videoOn, start, toggleAudio, toggleVideo };
}
