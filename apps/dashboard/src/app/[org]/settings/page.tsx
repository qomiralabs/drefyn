import type { Metadata } from 'next';
import { Working } from '../../../views/working.tsx';

export const metadata: Metadata = { title: 'Organization settings' };

export default function OrganizationSettings() {
  return (
    <Working title="Organization settings" caption="Acme">
      <p className="max-w-measure text-body-s text-secondary">
        Name, domains and the audit log arrive with the organization API.
      </p>
    </Working>
  );
}
