'use client';
import { use, type ReactNode } from 'react';

const never = new Promise<never>(() => undefined);

// Stands in for data that never arrives. The server renders nothing here and ends its
// response; the browser then suspends this boundary for good, so the server's skeleton stays
// on screen and is never hydrated away. A response held open instead keeps WebKit from
// running the page scripts at all.
export function WaitsInBrowser(): ReactNode {
  if (typeof window !== 'undefined') use(never);
  return null;
}
