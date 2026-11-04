import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { guardSignedIn } from '../server/guard.ts';

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardSignedIn();
  return {};
}

// A first visit lands on the person's first organization, in a stable order. The guard has
// already answered for someone with none.
export default async function Root() {
  const { organizations } = await guardSignedIn();
  const first = organizations[0];
  redirect(first === undefined ? '/sign-in' : `/${first.slug}`);
}
