import type { ReactNode } from 'react';
import { ROW } from './sheet.tsx';
import { Skeleton } from './skeleton.tsx';

// The list announces what is happening while it waits, and draws three rows in their place.
export function LoadingRows(): ReactNode {
  return (
    <span className="flex flex-col">
      <span className="sr-only">Loading options</span>
      {(['3/4', '1/2', '3/4'] as const).map((width, i) => (
        <span key={i} data-skeleton="" className={`flex items-center px-8 ${ROW}`}>
          <Skeleton width={width} />
        </span>
      ))}
    </span>
  );
}

export const markBusy =
  (busy: boolean) =>
  (el: HTMLElement | null): void => {
    if (el === null) return;
    if (busy) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
  };
