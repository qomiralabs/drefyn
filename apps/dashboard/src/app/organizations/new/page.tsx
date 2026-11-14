import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OrganizationForm } from '../../../auth/first-run-forms.tsx';
import { NoOrganizationScreen } from '../../../auth/first-run-screens.tsx';
import { authConfig } from '../../../server/auth.ts';
import {
  heldInvitation,
  instead,
  mayCreateOrganization,
  NEW_ORGANIZATION,
} from '../../../server/first-run.ts';
import { guardSignedIn } from '../../../server/guard.ts';
import { site } from '../../../server/sign-in-support.ts';

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardSignedIn();
  return { title: 'New organization' };
}

export default async function NewOrganization() {
  const person = await guardSignedIn();
  const { signUp } = authConfig();
  const onward = instead(NEW_ORGANIZATION, person, signUp);
  if (onward !== null) redirect(onward);
  const { session, organizations } = person;
  const invitation = await heldInvitation(session);
  if (!mayCreateOrganization(signUp)) {
    return <NoOrganizationScreen site={site()} email={session.email} invitation={invitation} />;
  }
  return (
    <OrganizationForm
      site={site()}
      email={session.email}
      member={organizations.length > 0}
      invitation={invitation}
    />
  );
}
