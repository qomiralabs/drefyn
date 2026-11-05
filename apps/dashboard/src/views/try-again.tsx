'use client';
import { Button } from '@drefyn/ui/react';
import { useRouter } from 'next/navigation';
import { startTransition, type ReactNode } from 'react';

// Asks the server for the page again; the shell around it stays as it is. An error boundary
// also has to be told to draw its children again, after the fresh page has arrived.
export function TryAgain({ reset }: { reset?: () => void }): ReactNode {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        startTransition(() => {
          router.refresh();
          reset?.();
        });
      }}
    >
      Try again
    </Button>
  );
}
