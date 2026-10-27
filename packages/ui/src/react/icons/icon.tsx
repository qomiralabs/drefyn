import type { ReactNode } from 'react';

export interface IconProps {
  size?: 'sm' | 'md' | 'lg';
  // Names the icon for screen readers. Without it the icon is decorative.
  label?: string;
}

// Colours a component inside this package may paint an icon in. Callers outside get the
// current text colour only, so an icon never carries state colour without its word.
export type IconTone = 'current' | 'secondary' | 'fresh' | 'stale' | 'broken' | 'neutral';

export interface IconShape extends IconProps {
  // Kebab case name, rendered as data-icon.
  name: string;
  // Shapes on the 24 unit grid.
  children: ReactNode;
  tone?: IconTone;
}

const SIZE = { sm: 'size-icon-sm', md: 'size-icon-md', lg: 'size-icon-lg' } as const;

// Amber fails 3:1 as a mark on paper and the neutral mark is not measured on surfaces, so
// both draw in their text colour, which clears it.
const TONE: Record<IconTone, string | null> = {
  current: null,
  secondary: 'text-secondary',
  fresh: 'text-state-fresh-mark',
  stale: 'text-state-stale-text',
  broken: 'text-state-broken-mark',
  neutral: 'text-state-neutral-text',
};

// The stroke width and non scaling stroke come from react.css, keyed on data-icon, so a
// change to the stroke token reaches every icon and every size keeps the same line.
export function Icon({
  name,
  size = 'sm',
  label,
  tone = 'current',
  children,
}: IconShape): ReactNode {
  const className = [SIZE[size], 'shrink-0', TONE[tone]].filter((c) => c !== null).join(' ');
  const named =
    label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      focusable="false"
      data-icon={name}
      className={className}
      {...named}
    >
      {children}
    </svg>
  );
}
