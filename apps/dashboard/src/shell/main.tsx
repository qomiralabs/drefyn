'use client';
import { useLandmark } from '@drefyn/ui/react';
import { useRef, type ReactNode } from 'react';

// Main is the skip link's target and a stop in the F6 cycle the toast region shares.
export function ShellMain({ children }: { children: ReactNode }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const landmark = useLandmark(ref, { role: 'main' });
  return (
    <main
      ref={ref}
      id="main"
      {...landmark}
      className="min-w-0 flex-1 outline-none focus-visible:focus-ring-inset"
    >
      {children}
    </main>
  );
}
