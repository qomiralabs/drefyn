import type { Metadata } from 'next';
import { AuthFrame } from '../../../auth/parts.tsx';
import { guardSession } from '../../../server/guard.ts';
import { appOrigin } from '../../../server/origin.ts';
import { hosted } from '../../../server/sign-in-support.ts';
import { NewOrganizationScreen } from '../../../settings/new-organization.tsx';

export async function generateMetadata(): Promise<Metadata> {
  await guardSession();
  return { title: 'Create organization' };
}

export default async function NewOrganizationPage() {
  await guardSession();
  return (
    <AuthFrame hosted={hosted()} label="New organization">
      <NewOrganizationScreen origin={appOrigin()} />
    </AuthFrame>
  );
}
