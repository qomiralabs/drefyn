'use client';
import { useEffect } from 'react';

// Marks main busy while a region of it waits for data. It sits outside the Suspense boundary,
// because React does not hydrate a fallback that is still waiting, and the resolved content
// renders it again with busy off.
export function MainBusy({ busy }: { busy: boolean }): null {
  useEffect(() => {
    const main = document.getElementById('main');
    if (!busy) {
      main?.removeAttribute('aria-busy');
      return undefined;
    }
    main?.setAttribute('aria-busy', 'true');
    // Leaving the page while it waits must not leave the next page busy.
    return () => {
      main?.removeAttribute('aria-busy');
    };
  }, [busy]);
  return null;
}
