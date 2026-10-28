import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Not found' };

// Says nothing about the dashboard or any organization, so a 404 with the release flag
// off leaks nothing.
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-measure flex-col gap-8 px-24 py-96">
      <h1 className="text-title text-ink">Page not found</h1>
      <p className="text-body-m text-secondary">There is nothing at this address.</p>
    </main>
  );
}
