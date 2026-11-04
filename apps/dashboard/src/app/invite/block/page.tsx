import type { Metadata } from 'next';
import { BlockForm } from '../../../auth/forms.tsx';
import { guardPublic } from '../../../server/guard.ts';
import { formBinding, hosted } from '../../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Stop invitations' };
}

// This GET renders and writes nothing, since mail scanners open every link.
export default async function InviteBlock() {
  await guardPublic();
  const csrf = await formBinding('/invite/block');
  return <BlockForm hosted={hosted()} csrf={csrf} />;
}
