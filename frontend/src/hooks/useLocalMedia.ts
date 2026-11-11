"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };

// why there's no picture: blocked in the browser, no camera at all, or another app holds it
export type CameraProblem = "blocked" | "missing" | "busy";

function problemOf(err: unknown): CameraProblem | null {
  if (!(err instanceof DOMException)) return null;
  if (err.name === "NotAllowedError" || err.name === "SecurityError") return "blocked";
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") return "missing";
  if (err.name === "NotReadableError" || err.name === "AbortError") return "busy";
  return null;
}

/** Camera and mic. getUserMedia only works on https:// or localhost. */
export function useLocalMedia() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [cameraProblem, setCameraProblem] = useState<CameraProblem | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pending = useRef<Promise<void> | null>(null);

  const use = useCallback((media: MediaStream) => {
    streamRef.current = media;
    setStream(media);
  }, []);

  const start = useCallback((): Promise<void> => {
    // strict mode calls this twice, a second camera stream would never get stopped
    if (streamRef.current) return Promise.resolve();
    if (pending.current) return pending.current;

    pending.current = (async () => {
      try {
        // one prompt for both
        use(await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO }));
        setCameraProblem(null);
        setError(null);
      } catch (err) {
        const problem = problemOf(err);
        if (!problem) {
          setError("Could not turn on the camera or microphone");
          return;
        }
        // no camera, but the mic alone may still work: you can join with audio
        setCameraProblem(problem);
        setVideoOn(false);
        setError(problem === "blocked" ? "Allow camera and microphone access in your browser settings" : null);
        const audio = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }).catch(() => null);
        if (audio) use(audio);
      } finally {
        pending.current = null;
      }
    })();
    return pending.current;
  }, [use]);

  /** Ask for the camera again ("Try again"). */
  const retry = useCallback(async (): Promise<boolean> => {
    const current = streamRef.current;
    if (!current) {
      await start();
      return Boolean(streamRef.current?.getVideoTracks().length);
    }
    try {
      const video = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
      use(new MediaStream([...current.getAudioTracks(), ...video.getVideoTracks()]));
      setCameraProblem(null);
      setVideoOn(true);
      setError(null);
      return true;
    } catch (err) {
      setCameraProblem(problemOf(err) ?? "missing");
      return false;
    }
  }, [start, use]);

  const toggleAudio = useCallback(() => {
    const next = !audioOn;
    // the track keeps sending silence, no renegotiation
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setAudioOn(next);
    return next;
  }, [audioOn]);

  const toggleVideo = useCallback(() => {
    if (cameraProblem) {
      void retry();
      return videoOn;
    }
    const next = !videoOn;
    // the track keeps sending black frames
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setVideoOn(next);
    return next;
  }, [videoOn, cameraProblem, retry]);

  // camera light off when the page goes away
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return {
    stream,
    error,
    audioOn,
    videoOn,
    cameraProblem,
    // kept for the call page
    videoBlocked: cameraProblem !== null,
    start,
    retry,
    toggleAudio,
    toggleVideo,
  };
}
