import type { ReactNode } from 'react';

// Shell icons drawn on the brand grid (24 units, square ends, mitred joins). The stroke width
// comes from @drefyn/ui/react.css through data-icon, like the package's own icons. They join
// the package icon set once the shell settles which ones it keeps.
interface ShellIconProps {
  size?: 'sm' | 'md';
  // Secondary ink for icons beside a label; the current colour otherwise.
  tone?: 'current' | 'secondary';
}

const SIZE = { sm: 'size-icon-sm', md: 'size-icon-md' } as const;

function shellIcon(name: string, shape: ReactNode) {
  function ShellIcon({ size = 'sm', tone = 'current' }: ShellIconProps): ReactNode {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        focusable="false"
        aria-hidden="true"
        data-icon={name}
        className={`${SIZE[size]} shrink-0${tone === 'secondary' ? ' text-secondary' : ''}`}
      >
        {shape}
      </svg>
    );
  }
  return ShellIcon;
}

export const IconHome = shellIcon(
  'home',
  <>
    <path d="M4 11L12 4L20 11" />
    <path d="M6 9.5V20H18V9.5" />
  </>,
);
export const IconCard = shellIcon(
  'card',
  <>
    <rect x="3" y="5" width="18" height="14" />
    <path d="M3 10H21M6 15H10" />
  </>,
);
export const IconUsers = shellIcon(
  'users',
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20C3 16 5.5 14 9 14C12.5 14 15 16 15 20" />
    <path d="M15.5 4.8A3.5 3.5 0 0 1 15.5 11.2M17.5 14.4C19.6 15.2 21 17.2 21 20" />
  </>,
);
export const IconSettings = shellIcon(
  'settings',
  <>
    <path d="M4 7H14M18 7H20M4 17H6M10 17H20" />
    <rect x="14" y="5" width="4" height="4" />
    <rect x="6" y="15" width="4" height="4" />
  </>,
);
export const IconPage = shellIcon(
  'page',
  <>
    <rect x="5" y="3" width="14" height="18" />
    <path d="M8 9H16M8 13H16M8 17H12" />
  </>,
);
export const IconCommit = shellIcon(
  'commit',
  <>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M3 12H8.5M15.5 12H21" />
  </>,
);
export const IconCode = shellIcon(
  'code',
  <>
    <path d="M8 6L3 12L8 18" />
    <path d="M16 6L21 12L16 18" />
    <path d="M13.5 5L10.5 19" />
  </>,
);
export const IconChart = shellIcon(
  'chart',
  <>
    <path d="M4 4V20H20" />
    <path d="M8 16V12M12 16V8M16 16V11" />
  </>,
);
export const IconPulse = shellIcon('pulse', <path d="M3 12H7.5L10 6L14 18L16.5 12H21" />);
export const IconGlobe = shellIcon(
  'globe',
  <>
    <circle cx="12" cy="12" r="8.5" />
    <ellipse cx="12" cy="12" rx="3.5" ry="8.5" />
    <path d="M3.5 12H20.5" />
  </>,
);
export const IconIncident = shellIcon(
  'incident',
  <>
    <path d="M12 3L22 20H2Z" />
    <path d="M12 9V14M12 16.5V18" />
  </>,
);
export const IconSchema = shellIcon(
  'schema',
  <>
    <rect x="3" y="4" width="8" height="6" />
    <rect x="13" y="14" width="8" height="6" />
    <path d="M7 10V17H13" />
  </>,
);
export const IconSearch = shellIcon(
  'search',
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.1 15.1L21 21" />
  </>,
);
export const IconInbox = shellIcon(
  'inbox',
  <>
    <path d="M3 13L6 5H18L21 13V19H3Z" />
    <path d="M3 13H8L9.5 15.5H14.5L16 13H21" />
  </>,
);
export const IconMenu = shellIcon('menu', <path d="M4 7H20M4 12H20M4 17H20" />);
export const IconUpDown = shellIcon('up-down', <path d="M8 9L12 5L16 9M8 15L12 19L16 15" />);
export const IconPlus = shellIcon('plus', <path d="M12 4V20M4 12H20" />);
export const IconExternal = shellIcon(
  'external',
  <>
    <path d="M14 4H20V10M20 4L11 13" />
    <path d="M18 14V20H4V6H10" />
  </>,
);
export const IconLock = shellIcon(
  'lock',
  <>
    <rect x="5" y="11" width="14" height="10" />
    <path d="M8 11V6H16V11" />
  </>,
);
export const IconClose = shellIcon('close', <path d="M5 5L19 19M19 5L5 19" />);

// The Drefyn mark: the d with its ascender, on its own 100 unit grid.
export function Mark(): ReactNode {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinejoin="miter"
      focusable="false"
      aria-hidden="true"
      className="size-icon-md shrink-0"
    >
      <path d="M54 44H32V80H54" />
      <path d="M68 14V86" />
    </svg>
  );
}

// Icons by the names the sidebar sections and the command registry use, so data can name an
// icon without importing components.
export const ICON_BY_NAME = {
  home: IconHome,
  page: IconPage,
  commit: IconCommit,
  code: IconCode,
  chart: IconChart,
  settings: IconSettings,
  incident: IconIncident,
  pulse: IconPulse,
  globe: IconGlobe,
  users: IconUsers,
  card: IconCard,
  schema: IconSchema,
} as const;
