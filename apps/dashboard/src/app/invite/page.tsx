import type { Metadata } from 'next';
import { InviteForm } from '../../auth/forms.tsx';
import { guardPublic } from '../../server/guard.ts';
import { formBinding, site } from '../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Invitation' };
}

// The token is read in the browser, from the fragment only: nothing here looks at the URL.
export default async function Invite() {
  await guardPublic();
  const csrf = await formBinding('/invite');
  return <InviteForm site={site()} csrf={csrf} />;
}
