import type { ReactNode } from 'react';

export interface MarkProps {
  size?: 'sm' | 'md' | 'lg';
  // Names the mark for screen readers. Beside the word Drefyn, or inside a named link, leave
  // it out.
  label?: string;
}

const SIZE = { sm: 'size-icon-sm', md: 'size-icon-md', lg: 'size-icon-lg' } as const;

// The Drefyn mark: the d with its ascender, on its own 100 unit grid. Its stroke is part of
// the drawing, not the icon stroke token, so the mark keeps its weight at every size.
export function Mark({ size = 'md', label }: MarkProps): ReactNode {
  const named =
    label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinejoin="miter"
      focusable="false"
      data-mark=""
      className={`${SIZE[size]} shrink-0`}
      {...named}
    >
      <path d="M54 44H32V80H54" />
      <path d="M68 14V86" />
    </svg>
  );
}
