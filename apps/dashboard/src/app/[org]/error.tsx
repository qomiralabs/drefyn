'use client';
import type { ReactNode } from 'react';
import { CouldNotLoad } from '../../views/could-not-load.tsx';

// Sits inside the organization layout, so the top bar and sidebar stay usable. The digest is
// the one Next logs for this error, which is what makes it worth asking for.
export default function OrganizationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <CouldNotLoad
      eyebrow="Dashboard"
      what="this page"
      rest="Published sites and status pages do not depend on the dashboard."
      reference={error.digest}
      reset={reset}
    />
  );
}
