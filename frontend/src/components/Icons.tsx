// small inline icons, they take the text color
import { useId, type Ref, type SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);

export const MicOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10.8 4.9M18.5 11c0 .7-.1 1.3-.3 1.9M12 17.5V21M4 4l16 16" />
  </Svg>
);

export const CamIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </Svg>
);

export const CamOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6.5h5a2.5 2.5 0 0 1 2.5 2.5v5M15.5 17.5H5.5A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 1.5-2.3" />
    <path d="M15.5 10.5 21 7.5v9l-3-1.6M3 3.5l17 17" />
  </Svg>
);

export const HangUpIcon = (p: IconProps) => (
  <Svg {...p} stroke="none" fill="currentColor">
    <path d="M2.6 13.6a1.6 1.6 0 0 1 0-2.3C5.3 8.8 8.6 7.6 12 7.6s6.7 1.2 9.4 3.7a1.6 1.6 0 0 1 0 2.3l-1.5 1.5a1.4 1.4 0 0 1-1.8.1l-2-1.4a1.4 1.4 0 0 1-.6-1.2v-1.7A9.6 9.6 0 0 0 12 10.3c-1.2 0-2.4.2-3.5.6v1.7c0 .5-.2.9-.6 1.2l-2 1.4a1.4 1.4 0 0 1-1.8-.1l-1.5-1.5Z" />
  </Svg>
);

export const SwapIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" />
  </Svg>
);

export const ArrowIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

// back: a chevron pointing left
export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v16M4 12h16" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  </Svg>
);

export const UserIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

// mic / camera with a slash that draws in and out instead of swapping the icon.
// The mask cuts a gap around the slash, like the system icons.
function Slashed({ off, children, ...p }: IconProps & { off: boolean }) {
  // useId has characters url(#...) doesn't like
  const id = `cut${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg {...p}>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" stroke="none" />
        <path d="M4 3.5 20.5 20" stroke="black" strokeWidth={5} pathLength={1} className="slash" data-on={off || undefined} />
      </mask>
      <g mask={`url(#${id})`}>{children}</g>
      <path d="M4 3.5 20.5 20" pathLength={1} className="slash" data-on={off || undefined} />
    </Svg>
  );
}

// fillRef: a green "liquid" rect inside the capsule, the caller scales it with the voice
export function MicGlyph({ off, fillRef, ...p }: IconProps & { off: boolean; fillRef?: Ref<SVGRectElement> }) {
  const clip = `cap${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Slashed off={off} {...p}>
      {fillRef && (
        <>
          <clipPath id={clip}>
            <rect x="9" y="3" width="6" height="11" rx="3" />
          </clipPath>
          <rect ref={fillRef} className="mic-fill" x="9" y="3" width="6" height="11" clipPath={`url(#${clip})`} />
        </>
      )}
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Slashed>
  );
}

export const CamGlyph = ({ off, ...p }: IconProps & { off: boolean }) => (
  <Slashed off={off} {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </Slashed>
);

/** Spins with transform only, stays on the compositor. */
export const Spinner = ({ size = 16, className }: { size?: number; className?: string }) => (
  <span className={`spinner${className ? ` ${className}` : ""}`} style={{ width: size, height: size }} aria-hidden />
);

export const PinIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11V12.5L10 9z"
      fill={filled ? "currentColor" : "none"}
      style={{ transition: "fill 200ms ease" }}
    />
    <path d="M12 14v6.5" />
  </Svg>
);

// put the floating video back into the island
export const DockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="3" />
    <path d="M9 9.5h5.5V15M14.5 9.5 8.5 15.5" />
  </Svg>
);

// two halves, for split view
export const SplitIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="7.5" height="14" rx="2.5" />
    <rect x="13.5" y="5" width="7.5" height="14" rx="2.5" />
  </Svg>
);

// one screen again, for leaving split view
export const UnsplitIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="14" rx="3" />
  </Svg>
);
