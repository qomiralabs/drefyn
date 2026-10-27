'use client';
import { Skeleton } from '@drefyn/ui/react';
import { useEffect, type ReactNode } from 'react';

// The final layout in skeleton blocks, so nothing moves when the data lands. Main is busy and
// keeps its name through a heading that is read, not drawn.
export function ProjectLoading({ name }: { name: string }): ReactNode {
  useEffect(() => {
    const main = document.getElementById('main');
    main?.setAttribute('aria-busy', 'true');
    return () => {
      main?.removeAttribute('aria-busy');
    };
  }, []);
  return (
    <div className="flex max-w-landing flex-col gap-32 px-16 pt-24 pb-96 sm:gap-48 sm:px-24 sm:pt-64">
      <h1 className="sr-only">{name}</h1>
      <div className="flex flex-col gap-12">
        <Skeleton width="1/4" />
        <span className="block h-32">
          <Skeleton shape="block" width="3/4" />
        </span>
        <span className="block h-32">
          <Skeleton shape="block" width="1/2" />
        </span>
        <Skeleton width="1/2" />
      </div>
      <div className="flex flex-col gap-12">
        <Skeleton width="1/4" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-start gap-12 border-b border-rule py-16">
            <span className="block size-icon-sm">
              <Skeleton shape="circle" />
            </span>
            <div className="flex flex-1 flex-col gap-8">
              <Skeleton width="1/2" />
              <Skeleton width="3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
