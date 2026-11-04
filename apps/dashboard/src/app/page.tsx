import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { landing } from '../server/first-run.ts';
import { guardSignedIn } from '../server/guard.ts';

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardSignedIn();
  return {};
}

// Everyone signed in lands somewhere, in a stable order: never back on /sign-in, which
// would send them straight here again.
export default async function Root() {
  const person = await guardSignedIn();
  redirect(landing(person));
}
