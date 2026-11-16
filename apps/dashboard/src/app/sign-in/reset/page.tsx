import type { Metadata } from 'next';
import { ResetForm } from '../../../auth/forms.tsx';
import { guardPublic } from '../../../server/guard.ts';
import { formBinding, site } from '../../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Reset your password' };
}

export default async function Reset() {
  await guardPublic();
  const csrf = await formBinding('/sign-in/reset');
  return <ResetForm site={site()} csrf={csrf} />;
}
