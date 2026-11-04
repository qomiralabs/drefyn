import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PLACEHOLDER_SHELL } from '../../../../fixtures/shell.ts';
import { guardPublic } from '../../../../server/guard.ts';
import { SETTINGS_STATES } from '../../../../settings/gallery.tsx';
import { SettingsProvider } from '../../../../settings/provider.tsx';
import { ShellChrome } from '../../../../views/shell-chrome.tsx';

interface Props {
  readonly params: Promise<{ readonly screen: string; readonly state: string }>;
}

const PERMISSIONS = ['org.read', 'org.manage_members', 'org.manage_api_keys'];

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Settings states' };
}

// Fixed words and no data, for the visual and axe specs. A server opts in, so an ordinary
// install answers 404, and the flag still decides first.
export default async function SettingsState({ params }: Props) {
  await guardPublic();
  if (process.env['DREFYN_DASHBOARD_STATES'] !== 'on') notFound();
  const { screen, state } = await params;
  const draw = SETTINGS_STATES[screen]?.[state];
  if (draw === undefined) notFound();
  return (
    <ShellChrome data={PLACEHOLDER_SHELL} permissions={PERMISSIONS}>
      <SettingsProvider>{draw()}</SettingsProvider>
    </ShellChrome>
  );
}
