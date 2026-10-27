import type { ReactNode } from 'react';

export interface SkeletonProps {
  shape?: 'text' | 'block' | 'circle';
  width?: '1/4' | '1/2' | '3/4' | 'full';
}

// TODO(#58): a placeholder block in the skeleton fill, server safe.
export const Skeleton: (props: SkeletonProps) => ReactNode = () => null;
