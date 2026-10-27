'use client';
import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

// Motion's animation features load on their own, after the part that moves has rendered.
const motionFeatures = () => import('motion/react').then((mod) => mod.domAnimation);

// Wraps only the parts of the shell that move something, such as incident mode stepping the
// sidebar back to the rail; those parts load it lazily, so no route pays for Motion until it
// moves. Reduced motion is followed through MotionConfig, so nothing travels for people who
// ask for less.
export function ShellMotion({ children }: { children: ReactNode }): ReactNode {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={motionFeatures} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
