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

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const BoltIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12l1-8Z" />
  </Svg>
);

// paper plane, for telegram
export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
  </Svg>
);

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11.8 5.2" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p} stroke="none" fill="currentColor">
    <circle cx="5" cy="12" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="19" cy="12" r="1.7" />
  </Svg>
);

// an arrow going in through a door: enter a room
export const EnterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" />
    <path d="M4 12h11M11 8l4 4-4 4" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 14V3.5M8 7.5l4-4 4 4" />
    <path d="M7.5 10.5H7A2.5 2.5 0 0 0 4.5 13v5A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-5a2.5 2.5 0 0 0-2.5-2.5h-.5" />
  </Svg>
);

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7" />
    <path d="M6 6.5l.9 12.2A2 2 0 0 0 8.9 20.5h6.2a2 2 0 0 0 2-1.8L18 6.5M10 10.5v6M14 10.5v6" />
  </Svg>
);

export const WifiOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19.5h.01M8.8 15.9a4.6 4.6 0 0 1 6.4 0M5.2 12.4a9.6 9.6 0 0 1 4.3-2.3M18.8 12.4a9.6 9.6 0 0 0-1.9-1.4M2 8.9a14.6 14.6 0 0 1 3.8-2.4M22 8.9a14.6 14.6 0 0 0-10.4-3.4M3 3l18 18" />
  </Svg>
);
