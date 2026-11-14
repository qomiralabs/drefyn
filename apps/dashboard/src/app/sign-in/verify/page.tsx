import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { VerifyForm } from '../../../auth/forms.tsx';
import { dashboardAuth } from '../../../server/auth.ts';
import { visitorBrowser } from '../../../server/actions.ts';
import { guardPublic } from '../../../server/guard.ts';
import { NONCE_HEADER } from '../../../server/security-headers.ts';
import { formBinding, site } from '../../../server/sign-in-support.ts';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Enter your code' };
}

// Set before first paint, so a link with a secret in it shows the skeleton and never a flash
// of the typed form. The text is a constant.
const FRAGMENT_SCRIPT =
  "if(location.hash.length>1)document.documentElement.setAttribute('data-fragment','')";

// The address is shown only to the browser that asked, read from the challenge it opened. It
// never travels in the URL, and an outage just leaves the sentence without it.
async function askedAddress(): Promise<string | null> {
  const browser = await visitorBrowser();
  if (browser === null) return null;
  const auth = await dashboardAuth().catch(() => null);
  const read = await auth?.emailSignIn.readChallenge(browser, {});
  return read?.ok === true && read.value.kind === 'here' ? read.value.email : null;
}

export default async function Verify({ searchParams }: Props) {
  await guardPublic();
  const csrf = await formBinding('/sign-in/verify');
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const query = await searchParams;
  return (
    <>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FRAGMENT_SCRIPT }} />
      <VerifyForm
        site={site()}
        csrf={csrf}
        email={await askedAddress()}
        fromSignUp={query['from'] === 'sign-up'}
      />
    </>
  );
}
