import { safeReturnTo } from '@drefyn/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { oauthNotice } from '../../auth/outcomes.ts';
import { SignInForm } from '../../auth/forms.tsx';
import { authConfig, dashboardAuth } from '../../server/auth.ts';
import { currentSession, guardPublic } from '../../server/guard.ts';
import { appOrigin } from '../../server/origin.ts';
import { formBinding, lastUsed, site } from '../../server/sign-in-support.ts';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

// Answers first, so with the flag off the title is the 404's and not the product's.
export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Sign in' };
}

export default async function SignIn({ searchParams }: Props) {
  await guardPublic();
  const query = await searchParams;
  const next = typeof query['next'] === 'string' ? safeReturnTo(query['next'], appOrigin()) : '';
  if ((await currentSession()) !== null) redirect(next === '' ? '/' : next);
  const csrf = await formBinding(
    next === '' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`,
  );
  const { methods } = await dashboardAuth();
  return (
    <SignInForm
      site={site()}
      csrf={csrf}
      next={next}
      providers={methods.providers}
      emailOn={methods.email}
      passwordOn={methods.password}
      signUp={authConfig().signUp}
      notice={oauthNotice(query['error'], query['provider'])}
      lastUsed={await lastUsed()}
    />
  );
}
