import type { IconName as SdkIconName } from '@ai-switchboard/sdk/icons';
import type { ReactNode, SVGProps } from 'react';

/**
 * The icon set: 16×16 stroke icons (1.5 px, `currentColor`) copied from the canvas mockups.
 * No emoji anywhere; every icon is decorative (`aria-hidden`) unless given a `title`.
 */
const PATHS = {
  board: (
    <>
      <rect x="2" y="3" width="4" height="4" rx="1" />
      <rect x="10" y="3" width="4" height="4" rx="1" />
      <rect x="6" y="9" width="4" height="4" rx="1" />
      <path d="M6 5h4M4 7v2h4M12 7v2H8" />
    </>
  ),
  processes: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </>
  ),
  sources: (
    <>
      <path d="M5 2v3M11 2v3" />
      <path d="M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0z" />
      <path d="M8 12v2.5" />
    </>
  ),
  executors: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  activity: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  approvals: (
    <>
      <path d="M2 9l2-6h8l2 6v4H2z" />
      <path d="M2 9h3.5l1 2h3l1-2H14" />
    </>
  ),
  plugins: (
    <>
      <path d="M6 2v3M10 2v3" />
      <path d="M3 5h10v3a5 5 0 0 1-10 0z" />
      <path d="M8 13v1.5" />
      <path d="M5.5 8.5h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  back: <path d="M10 3 5 8l5 5" />,
  'chevron-right': <path d="M6 3l5 5-5 5" />,
  'chevron-down': <path d="M3 6l5 5 5-5" />,
  'chevron-up': <path d="M3 10l5-5 5 5" />,
  external: (
    <>
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  warning: (
    <>
      <path d="M8 1.5 14.5 13H1.5z" />
      <path d="M8 6v3.5M8 11.5v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 5v.5" />
    </>
  ),
  pause: (
    <>
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M2 8a6 6 0 0 1 10.4-4.1M14 8a6 6 0 0 1-10.4 4.1" />
      <path d="M12.5 1v3h-3M3.5 15v-3h3" />
    </>
  ),
  /** A sweep (scheduled run) and batching timers. */
  clock: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  /** An event-driven run. */
  event: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  /** A manual run. */
  manual: (
    <path d="M4 8.5V3.5a1 1 0 0 1 2 0V8M6 7V2.5a1 1 0 0 1 2 0V7M8 7V3a1 1 0 0 1 2 0v4.5M10 8V4.5a1 1 0 0 1 2 0v5c0 2.5-1.5 4.5-4 4.5S4 12 4 9.5" />
  ),
  key: (
    <>
      <circle cx="8" cy="5.5" r="3" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.5h4V4" />
      <path d="M3.5 4l.8 9.5h7.4l.8-9.5" />
    </>
  ),
  edit: <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />,
  filter: <path d="M2 3h12L9.5 8.5V13l-3-1.5v-3z" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </>
  ),
  moon: <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  logout: (
    <>
      <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6" />
      <path d="M10 5l3 3-3 3M13 8H6" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.5" cy="8" r="1" />
    </>
  ),
  play: <path d="M4.5 2.5v11l9-5.5z" />,
  gate: (
    <>
      <path d="M3 14V3M13 14V3" />
      <path d="M3 5h10M3 9h10" />
    </>
  ),
  budget: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 5v.5" />
    </>
  ),
  webhook: (
    <>
      <circle cx="8" cy="4" r="2" />
      <circle cx="3.5" cy="12" r="2" />
      <circle cx="12.5" cy="12" r="2" />
      <path d="M7 5.8 4.5 10.2M9 5.8l2.5 4.4M5.5 12h5" />
    </>
  ),
  link: (
    <>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8" />
    </>
  ),
  artifact: (
    <>
      <path d="M4 1.5h5.5L12.5 4.5V14.5H4z" />
      <path d="M9.5 1.5v3h3" />
    </>
  ),
  pr: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7" />
      <path d="M8.5 3 7 4.5 8.5 6" />
    </>
  ),
  issue: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2a4 4 0 0 1 4 4v3l1.5 2.5h-11L4 9V6a4 4 0 0 1 4-4z" />
      <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
    </>
  ),
  run: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 5.5v5l4-2.5z" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="3" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  // Exactly the SDK's `ICON_NAMES`, so a plugin-declared icon name always has a drawing here.
} satisfies Record<SdkIconName, ReactNode>;

/** Every icon name. */
export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel size (default 16; the canvas uses 14 inside chips and 13 in dense rows). */
  size?: number;
  /** When given, the icon is announced with this label instead of being hidden. */
  title?: string;
}

/** A stroke icon from the canvas set. */
export function Icon({ name, size = 16, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
