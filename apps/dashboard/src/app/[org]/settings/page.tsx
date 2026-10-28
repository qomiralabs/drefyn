import type { Metadata } from 'next';
import { guardOrganization } from '../../../server/guard.ts';
import { Working } from '../../../views/working.tsx';

interface Params {
  params: Promise<{ org: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await guardOrganization((await params).org);
  return { title: 'Organization settings' };
}

export default async function OrganizationSettings({ params }: Params) {
  const { name } = await guardOrganization((await params).org);
  return (
    <Working title="Organization settings" caption={name}>
      <p className="max-w-measure text-body-s text-secondary">
        Name, domains and the audit log arrive with the organization API.
      </p>
    </Working>
  );
}
