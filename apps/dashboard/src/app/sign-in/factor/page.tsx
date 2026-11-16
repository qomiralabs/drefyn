import type { Metadata } from 'next';
import { FactorScreen } from '../../../auth/factor-screen.tsx';
import { FactorForm } from '../../../auth/forms.tsx';
import { dashboardAuth } from '../../../server/auth.ts';
import { visitorBrowser } from '../../../server/actions.ts';
import { guardPublic } from '../../../server/guard.ts';
import { formBinding, site } from '../../../server/sign-in-support.ts';

interface Props {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'One more step' };
}

// Proves the factor cookie and nothing more: no count, no lock and no write, so a reload
// spends nothing. Only a challenge that is gone changes what the page shows; an outage
// still draws the form, and the post says what went wrong.
async function challengeGone(): Promise<boolean> {
  const browser = await visitorBrowser();
  if (browser === null) return false;
  const auth = await dashboardAuth().catch(() => null);
  const read = await auth?.factorChallenges.readChallenge(browser);
  return read?.ok === true && read.value.kind === 'gone';
}

export default async function Factor({ searchParams }: Props) {
  await guardPublic();
  // The pre sign in cookie may have run out before the challenge did; this sends the
  // browser through the mint route once and back here.
  const csrf = await formBinding('/sign-in/factor');
  const kind = (await searchParams)['use'] === 'recovery' ? 'recovery_code' : 'totp';
  if (await challengeGone()) {
    return <FactorScreen site={site()} csrf={csrf} kind={kind} problem="expired" />;
  }
  return <FactorForm site={site()} csrf={csrf} kind={kind} />;
}
