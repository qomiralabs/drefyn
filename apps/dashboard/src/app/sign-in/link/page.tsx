import type { Metadata } from 'next';
import { LinkForm } from '../../../auth/forms.tsx';
import { PROVIDER_NAMES } from '../../../auth/outcomes.ts';
import { visitorBrowser } from '../../../server/actions.ts';
import { dashboardAuth } from '../../../server/auth.ts';
import { guardPublic } from '../../../server/guard.ts';
import { formBinding, hosted } from '../../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Link your account' };
}

async function pending() {
  const browser = await visitorBrowser();
  if (browser === null) return null;
  const auth = await dashboardAuth();
  const read = await auth.emailSignIn.readChallenge(browser, {});
  return read.ok && read.value.kind === 'here' ? read.value : null;
}

export default async function LinkPending() {
  await guardPublic();
  const csrf = await formBinding('/sign-in/link');
  const challenge = await pending();
  const provider = challenge?.provider === 'google' ? 'google' : 'github';
  return (
    <LinkForm
      hosted={hosted()}
      csrf={csrf}
      email={challenge?.email ?? null}
      provider={PROVIDER_NAMES[provider]}
    />
  );
}
