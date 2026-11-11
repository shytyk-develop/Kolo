"use client";

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef } from "react";

import { useCamera } from "@/components/CameraLayer";
import { CamGlyph, CamOffIcon, Spinner } from "@/components/Icons";
import { MicMeter } from "@/components/LevelBars";
import { useMedia } from "@/components/MediaProvider";
import type { CameraProblem } from "@/hooks/useLocalMedia";
import { Video } from "@/components/Video";
import { useMotionSet } from "@/lib/motion";

import { Press } from "./ui";

// how tall the camera is on phones: home, home with a call card, every other screen
export type CamSize = "home" | "banner" | "view";

// mounted once per session; on phones it slides instead of resizing, the picture slides back half as far
export const CameraStage = memo(function CameraStage({ size, scrim }: { size: CamSize; scrim: boolean }) {
  const media = useMedia();
  const m = useMotionSet();
  const windowRef = useRef<HTMLDivElement>(null);
  useHandOff(windowRef, Boolean(media.stream));

  const problem = media.cameraProblem;
  const blocked = problem !== null;
  const status = problem
    ? PROBLEMS[problem].status
    : !media.stream
      ? media.error
        ? "Camera unavailable"
        : "Starting camera…"
      : media.videoOn
        ? "You’re on camera"
        : "Camera is off";

  return (
    <motion.div className="stage" data-cam={size} layout="position" layoutDependency={size} transition={m.morph}>
      <div ref={windowRef} className="stage__window" data-blocked={blocked || undefined}>
        <motion.div className="stage__media" layout="position" layoutDependency={size} transition={m.morph}>
          <motion.div
            className="stage__video"
            initial={false}
            animate={scrim ? { filter: "blur(26px) brightness(0.82)", scale: 1.12 } : { filter: "blur(0px) brightness(1)", scale: 1 }}
            transition={m.reduced ? m.morph : { ...m.morph, filter: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
          >
            <Video stream={media.stream} mirror fit="cover" />
          </motion.div>
          <div className="nocam" data-on={(!blocked && (!media.stream || !media.videoOn)) || undefined}>
            <CamOffIcon size={28} />
          </div>
          <AnimatePresence initial={false}>
            {problem && <BlockedNotice key={problem} problem={problem} onRetry={media.retry} />}
            {scrim && (
              <motion.div
                key="scrim"
                className="stage__pill"
                variants={m.pop}
                initial="hidden"
                animate="shown"
                exit="gone"
                role="status"
              >
                <Spinner size={18} className="stage__spin" />
                Reconnecting…
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <div className="stage__controls">
          <Press
            className="glass"
            onClick={media.toggleAudio}
            disabled={!media.stream}
            aria-pressed={!media.audioOn}
            aria-label={media.audioOn ? "Turn off microphone" : "Turn on microphone"}
          >
            <MicMeter stream={media.stream} on={media.audioOn} />
          </Press>
          <Press
            className="glass"
            data-blocked={blocked || undefined}
            onClick={media.toggleVideo}
            disabled={!media.stream && !blocked}
            aria-pressed={!media.videoOn}
            aria-label={blocked ? "Allow camera" : media.videoOn ? "Turn off camera" : "Turn on camera"}
          >
            <CamGlyph off={!media.videoOn} />
          </Press>
          <span key={status} className="stage__status">
            {status}
          </span>
        </div>
      </div>
      {/* phones: the black gap under the camera and the card's top corners, riding with it */}
      <div className="stage__band" aria-hidden>
        <i />
        <i />
      </div>
    </motion.div>
  );
});

const PROBLEMS: Record<CameraProblem, { status: string; title: string; text: string }> = {
  blocked: {
    status: "Camera blocked",
    title: "Camera access is blocked",
    text: "Allow camera in your browser’s site settings, then try again. You can still join with audio.",
  },
  missing: {
    status: "No camera",
    title: "No camera found",
    text: "Connect a camera, then try again. You can still join with audio.",
  },
  busy: {
    status: "Camera in use",
    title: "Camera is busy",
    text: "Another app is using the camera. Close it, then try again. You can still join with audio.",
  },
};

function BlockedNotice({ problem, onRetry }: { problem: CameraProblem; onRetry: () => Promise<boolean> }) {
  const m = useMotionSet();
  return (
    <motion.div className="blocked" variants={m.pop} initial="hidden" animate="shown" exit="gone" role="alert">
      <span className="blocked__icon">
        <CamOffIcon size={26} />
      </span>
      <p className="blocked__title">{PROBLEMS[problem].title}</p>
      <p className="blocked__text">{PROBLEMS[problem].text}</p>
      <Press className="blocked__retry" onClick={() => void onRetry()}>
        Try again
      </Press>
    </motion.div>
  );
}

// back from a call page the app-wide camera glides here: tell it where, then hide it
function useHandOff(ref: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  const cam = useCamera();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const save = () => {
      const r = el.getBoundingClientRect();
      const spot = { x: r.left, y: r.top, w: r.width, h: r.height, r: getComputedStyle(el).borderRadius };
      try {
        sessionStorage.setItem("kolo:spot:home", JSON.stringify(spot));
      } catch {}
    };
    save();
    window.addEventListener("resize", save);
    return () => window.removeEventListener("resize", save);
  }, [ref]);
  useEffect(() => {
    if (ready) cam.show(false);
  }, [ready, cam]);
}
