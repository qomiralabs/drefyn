import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CliForm } from '../../../auth/forms.tsx';
import { guardPublic } from '../../../server/guard.ts';
import { NONCE_HEADER } from '../../../server/security-headers.ts';
import { formBinding, site } from '../../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Sign in' };
}

const FRAGMENT_SCRIPT =
  "if(location.hash.length>1)document.documentElement.setAttribute('data-fragment','')";

export default async function CliLink() {
  await guardPublic();
  const csrf = await formBinding('/sign-in/cli');
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FRAGMENT_SCRIPT }} />
      <CliForm site={site()} csrf={csrf} />
    </>
  );
}
