import type { ReactNode } from 'react';
import { alertShape } from './icons/alert.tsx';
import { Icon } from './icons/icon.tsx';

export interface EmptyStateProps {
  title: string;
  // One sentence: what this place is for, or what went wrong.
  children: ReactNode;
  tone?: 'empty' | 'error';
  icon?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  // A request id for support, shown on errors.
  reference?: string;
}

const HEADING = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

// Replaces the region it belongs to, never the page. It is plain content, not a live
// region: when an error replaces content after an action, the caller moves focus to the
// heading, which is why the heading takes tabIndex -1. An error is marked by the broken
// icon alone; the title stays ink so the words read at full contrast.
export function EmptyState({
  title,
  children,
  tone = 'empty',
  icon,
  action,
  headingLevel = 2,
  reference,
}: EmptyStateProps): ReactNode {
  const Heading = HEADING[headingLevel];
  // A page level state reads at the page's sizes; a panel inside a page steps down.
  const page = headingLevel === 2;
  const mark =
    tone === 'error' ? (
      <Icon name="alert" size="lg" tone="broken">
        {alertShape}
      </Icon>
    ) : icon === undefined ? null : (
      <span className="inline-flex text-secondary">{icon}</span>
    );
  return (
    <div className="flex flex-col items-start gap-8">
      {mark}
      <Heading
        tabIndex={-1}
        className={`${page ? 'text-title' : 'text-body-m font-strong'} text-ink focus-visible:focus-ring`}
      >
        {title}
      </Heading>
      <p className={`max-w-measure ${page ? 'text-body-m' : 'text-body-s'} text-body`}>
        {children}
      </p>
      {reference === undefined ? null : (
        <p className="text-caption text-secondary">
          Reference <code className="font-mono text-code text-secondary">{reference}</code>
        </p>
      )}
      {action === undefined ? null : <div className="mt-8">{action}</div>}
    </div>
  );
}
