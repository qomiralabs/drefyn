import type { Metadata } from 'next';
import { dashboardAuth } from '../../server/auth.ts';
import { guardAccountHome } from '../../server/guard.ts';
import { failureReference } from '../../server/sign-in-support.ts';
import { LoadProblem } from '../../settings/parts.tsx';
import { ProfileScreen } from '../../settings/profile.tsx';

export async function generateMetadata(): Promise<Metadata> {
  await guardAccountHome();
  return { title: 'Profile and email' };
}

export default async function ProfilePage() {
  const { session, organizations } = await guardAccountHome();
  const auth = await dashboardAuth();
  const read = await auth.account.readAccount(session);
  if (!read.ok) {
    return (
      <LoadProblem
        title="Could not load your profile"
        reference={failureReference('settings.profile_read_failed')}
      >
        Your account is fine and you are still signed in. Only this page did not load.
      </LoadProblem>
    );
  }
  const { value } = read;
  return (
    <ProfileScreen
      facts={{
        name: value.displayName ?? value.email,
        email: value.email,
        confirmedAt: value.confirmedAt?.toISOString() ?? null,
        organizations: organizations.map((organization) => organization.name),
      }}
    />
  );
}
