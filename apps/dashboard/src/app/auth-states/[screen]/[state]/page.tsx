import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { STATES } from '../../../../auth/gallery.tsx';
import { docsUrl } from '../../../../server/docs-url.ts';
import { guardPublic } from '../../../../server/guard.ts';

interface Props {
  readonly params: Promise<{ readonly screen: string; readonly state: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Sign in states' };
}

// Fixed words and no data, for the visual, axe and keyboard specs. A server opts in, so an
// ordinary install answers 404, and the flag still decides first.
export default async function AuthState({ params, searchParams }: Props) {
  await guardPublic();
  if (process.env['DREFYN_DASHBOARD_STATES'] !== 'on') notFound();
  const { screen, state } = await params;
  const { host } = await searchParams;
  const draw = STATES[screen]?.[state];
  if (draw === undefined) notFound();
  return draw({ hosted: host !== 'self', docs: docsUrl() });
}
