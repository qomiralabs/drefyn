import Link from 'next/link';
import type { ReactNode } from 'react';

// Server components for calm landings: no JS ships for any of them.

// A landing reads like a page: one column, left aligned, generous space between blocks.
export function Calm({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex max-w-landing flex-col gap-32 px-16 pt-24 pb-96 sm:gap-48 sm:px-24 sm:pt-64">
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-label text-secondary uppercase">{children}</p>;
}

// The answer to the place's question: the claim in ink, then the rest in secondary ink.
export function Answer({ claim, rest }: { claim: string; rest: string }): ReactNode {
  return (
    <h1
      tabIndex={-1}
      className="text-display-s text-balance text-ink outline-none focus-visible:focus-ring"
    >
      {claim} <span className="text-secondary">{rest}</span>
    </h1>
  );
}

export function Head({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-col gap-12">{children}</div>;
}

// The evidence for the claim, in caption type: what was checked, against what, and when.
export function Evidence({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="flex flex-wrap items-center gap-x-12 gap-y-4 text-caption text-secondary">
      {children}
    </p>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <Link
      href={href}
      className="text-accent-ink underline transition-colors duration-fast ease-enter hover:text-accent-press focus-visible:focus-ring"
    >
      {children}
    </Link>
  );
}

export interface RankedItem {
  readonly id: string;
  readonly mark: ReactNode;
  readonly title: string;
  readonly href: string;
  readonly detail: ReactNode;
  readonly when: ReactNode;
}

// Depth is a ranked list with hairlines, never a card grid. At most five rows.
export function Ranked({
  label,
  items,
}: {
  label: string;
  items: readonly RankedItem[];
}): ReactNode {
  const id = `ranked-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-12">
      <h2 id={id} className="text-label text-secondary uppercase">
        {label}
      </h2>
      <ol className="border-t border-rule">
        {items.slice(0, 5).map((item) => (
          <li key={item.id} className="flex items-start gap-12 border-b border-rule py-16">
            {item.mark === null ? null : <span className="inline-flex pt-2">{item.mark}</span>}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Link
                href={item.href}
                className="text-body-m font-medium text-ink hover:underline focus-visible:focus-ring"
              >
                {item.title}
              </Link>
              <p className="text-caption text-secondary">{item.detail}</p>
            </div>
            <span className="shrink-0 text-caption whitespace-nowrap text-secondary">
              {item.when}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
