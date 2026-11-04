import { safeReturnTo } from '@drefyn/auth';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PasswordForm } from '../../../auth/forms.tsx';
import { dashboardAuth } from '../../../server/auth.ts';
import { currentSession, guardPublic } from '../../../server/guard.ts';
import { appOrigin } from '../../../server/origin.ts';
import { formBinding, hosted } from '../../../server/sign-in-support.ts';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Sign in with a password' };
}

export default async function Password({ searchParams }: Props) {
  await guardPublic();
  const query = await searchParams;
  const next = typeof query['next'] === 'string' ? safeReturnTo(query['next'], appOrigin()) : '';
  if ((await currentSession()) !== null) redirect(next === '' ? '/' : next);
  const { methods } = await dashboardAuth();
  if (!methods.password) notFound();
  const csrf = await formBinding('/sign-in/password');
  return <PasswordForm hosted={hosted()} csrf={csrf} next={next} providers={methods.providers} />;
}
