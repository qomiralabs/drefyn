import type { ReactNode } from 'react';

// Working views use the full width up to the page maximum, a title rather than an answer,
// and tighter spacing.
export function Working({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex max-w-page flex-col gap-16 px-16 pt-24 pb-96 sm:px-24">
      <div className="flex flex-col gap-4">
        <h1 tabIndex={-1} className="text-title text-ink outline-none focus-visible:focus-ring">
          {title}
        </h1>
        <p className="text-caption text-secondary">{caption}</p>
      </div>
      {children}
    </div>
  );
}
