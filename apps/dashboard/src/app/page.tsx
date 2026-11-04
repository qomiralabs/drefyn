import { redirect } from 'next/navigation';
import { guardSignedIn } from '../server/guard.ts';

// A first visit lands on the person's first organization, in a stable order. The guard has
// already answered for someone with none.
export default async function Root() {
  const { organizations } = await guardSignedIn();
  const first = organizations[0];
  redirect(first === undefined ? '/sign-in' : `/${first.slug}`);
}
