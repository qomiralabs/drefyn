'use client';
import { Button } from '@drefyn/ui/react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

// Asks the server for the page again; the shell around it stays as it is.
export function TryAgain(): ReactNode {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        router.refresh();
      }}
    >
      Try again
    </Button>
  );
}
