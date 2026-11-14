import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignUpForm } from '../../auth/forms.tsx';
import { authConfig, dashboardAuth } from '../../server/auth.ts';
import { currentSession, guardPublic } from '../../server/guard.ts';
import { formBinding, lastUsed, site } from '../../server/sign-in-support.ts';

export async function generateMetadata(): Promise<Metadata> {
  await guardPublic();
  return { title: 'Create your account' };
}

// Invite only opens this page to a browser holding a live invitation, and to nobody else.
async function pageState(): Promise<'ready' | 'closed' | 'invite_only'> {
  const config = authConfig();
  if (config.signUp === 'open') return 'ready';
  if (config.signUp === 'closed') return 'closed';
  const held = (await cookies()).get(config.cookies.invite)?.value;
  if (held === undefined) return 'invite_only';
  const auth = await dashboardAuth();
  return (await auth.invitations.readInvitation(held)).ok ? 'ready' : 'invite_only';
}

export default async function SignUp() {
  await guardPublic();
  if ((await currentSession()) !== null) redirect('/');
  const csrf = await formBinding('/sign-up');
  const { methods } = await dashboardAuth();
  return (
    <SignUpForm
      site={site()}
      csrf={csrf}
      state={await pageState()}
      providers={methods.providers}
      lastUsed={await lastUsed()}
    />
  );
}
