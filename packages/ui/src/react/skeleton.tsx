import type { ReactNode } from 'react';

export interface SkeletonProps {
  shape?: 'text' | 'block' | 'circle';
  width?: '1/4' | '1/2' | '3/4' | 'full';
}

const WIDTH = { '1/4': 'w-1/4', '1/2': 'w-1/2', '3/4': 'w-3/4', full: 'w-full' } as const;

// A text line is a short bar; a block or a circle fills the box its caller sizes, so the
// final layout holds while the content loads.
const SHAPE = {
  text: 'h-8 rounded-xs',
  block: 'h-full rounded-xs',
  circle: 'aspect-square rounded-full',
} as const;

// A span, so it can stand in for text inside a cell or a paragraph. Hidden from screen
// readers: the region it fills sets aria-busy. No shimmer or pulse, because nothing in
// the brand pulses.
export function Skeleton({ shape = 'text', width = 'full' }: SkeletonProps): ReactNode {
  return (
    <span aria-hidden="true" className={`block bg-skeleton-fill ${WIDTH[width]} ${SHAPE[shape]}`} />
  );
}
