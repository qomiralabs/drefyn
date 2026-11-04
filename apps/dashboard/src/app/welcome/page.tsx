import { safeReturnTo } from '@drefyn/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WelcomeForm } from '../../auth/first-run-forms.tsx';
import { authConfig, dashboardAuth } from '../../server/auth.ts';
import { heldInvitation, instead, WELCOME } from '../../server/first-run.ts';
import { guardSignedIn } from '../../server/guard.ts';
import { appOrigin } from '../../server/origin.ts';
import { hosted } from '../../server/sign-in-support.ts';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardSignedIn();
  return { title: 'Welcome' };
}

export default async function Welcome({ searchParams }: Props) {
  const person = await guardSignedIn();
  const query = await searchParams;
  const next = typeof query['next'] === 'string' ? safeReturnTo(query['next'], appOrigin()) : '/';
  const onward = instead(WELCOME, person, authConfig().signUp);
  if (onward !== null) redirect(next === '/' ? onward : next);
  const { session, account } = person;
  const { methods } = await dashboardAuth();
  return (
    <WelcomeForm
      hosted={hosted()}
      email={session.email}
      next={next === '/' ? '' : next}
      passwordOn={methods.password && account.passwordSetAt === null}
      invitation={await heldInvitation(session)}
    />
  );
}
