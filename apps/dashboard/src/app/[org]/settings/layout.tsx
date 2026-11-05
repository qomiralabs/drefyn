import type { ReactNode } from 'react';
import { guardOrganization } from '../../../server/guard.ts';
import { SettingsProvider } from '../../../settings/provider.tsx';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}) {
  await guardOrganization((await params).org);
  return <SettingsProvider>{children}</SettingsProvider>;
}
