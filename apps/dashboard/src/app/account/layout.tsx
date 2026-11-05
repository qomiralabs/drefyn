import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { guardAccountHome } from '../../server/guard.ts';
import { readShell } from '../../server/shell-data.ts';
import { SettingsProvider } from '../../settings/provider.tsx';
import { ShellChrome } from '../../views/shell-chrome.tsx';

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const { home } = await guardAccountHome();
  if (home === null) redirect('/organizations/new');
  return (
    <ShellChrome data={await readShell(home)} permissions={home.access.permissions}>
      <SettingsProvider>{children}</SettingsProvider>
    </ShellChrome>
  );
}
