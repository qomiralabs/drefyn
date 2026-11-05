import type { ReactNode } from 'react';
import { guardOrganization } from '../../server/guard.ts';
import { readShell } from '../../server/shell-data.ts';
import { ShellChrome } from '../../views/shell-chrome.tsx';

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const guarded = await guardOrganization(org);
  return (
    <ShellChrome data={await readShell(guarded)} permissions={guarded.access.permissions}>
      {children}
    </ShellChrome>
  );
}
