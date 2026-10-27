import type { ReactNode } from 'react';

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

// TODO(#58): the empty and error state of a region, server safe.
export const EmptyState: (props: EmptyStateProps) => ReactNode = () => null;
