'use server';
import { parseOrganizationName, safeReturnTo, type AuthError } from '@drefyn/auth';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import type { OrganizationState, WelcomeState } from '../auth/states.ts';
import { signedInAction } from './actions.ts';
import { authConfig, dashboardAuth } from './auth.ts';
import { heldInvitation, mayCreateOrganization } from './first-run.ts';
import { appOrigin } from './origin.ts';
import { applyCookies, failureReference, freshBinding } from './sign-in-support.ts';

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

const notSaved = (event: string) =>
  ({ kind: 'not_saved', reference: failureReference(event) }) as const;

function passwordRefusal(error: AuthError): Omit<WelcomeState, 'name'> | null {
  switch (error.code) {
    case 'AUTH_PASSWORD_WEAK':
      return { problem: 'password', rules: error.rules ?? [] };
    // The one thing the checks before the rules refuse is size.
    case 'AUTH_INPUT_INVALID':
      return { problem: 'password', rules: ['too_long'] };
    case 'AUTH_PASSWORD_BREACHED':
      return { problem: 'breached' };
    case 'AUTH_RECENT_AUTH_REQUIRED':
      return { problem: 'late' };
    // Set by an earlier try of this same form; that one stands.
    case 'AUTH_FORBIDDEN':
      return null;
    default:
      return { notice: notSaved('auth.welcome_password_failed') };
  }
}

// A return path wins, then the invitation this browser holds, then /.
async function afterWelcome(form: FormData, session: Parameters<typeof heldInvitation>[0]) {
  const next = safeReturnTo(text(form, 'next'), appOrigin());
  if (next !== '/') return next;
  return (await heldInvitation(session)) === null ? '/' : '/invite';
}

// The name is checked first and written last, so a refused password leaves nothing half done
// and Welcome is finished only when everything on it is saved.
export const saveWelcome = signedInAction(
  async ({ session }, _state: unknown, form: FormData): Promise<WelcomeState> => {
    const name = text(form, 'name');
    if (!parseOrganizationName(name).ok) return { problem: 'name', name };
    const auth = await dashboardAuth();
    const password = text(form, 'password');
    if (password !== '') {
      const set = await auth.passwordSignIn.setPassword(session, { newPassword: password });
      if (set.ok) after(set.value.send);
      else {
        const refusal = passwordRefusal(set.error);
        if (refusal !== null) return { ...refusal, name };
      }
    }
    const saved = await auth.account.setDisplayName(session, { name });
    if (!saved.ok) return { name, notice: notSaved('auth.welcome_name_failed') };
    const target = await afterWelcome(form, session);
    await applyCookies(freshBinding(target));
    redirect(target);
  },
);

export const makeOrganization = signedInAction(
  async ({ session }, _state: unknown, form: FormData): Promise<OrganizationState> => {
    if (!mayCreateOrganization(authConfig().signUp)) return { closed: true };
    const name = text(form, 'name');
    const slug = text(form, 'slug');
    const auth = await dashboardAuth();
    const made = await auth.organizations.createOrganization(session, { name, slug });
    if (made.ok) redirect(`/${slug}`);
    const typed = { name, slug };
    switch (made.error.code) {
      case 'AUTH_SLUG_TAKEN':
        return { ...typed, problem: 'taken' };
      case 'AUTH_SLUG_INVALID':
        return { ...typed, problem: 'address' };
      case 'AUTH_INPUT_INVALID':
        return { ...typed, problem: 'name' };
      case 'AUTH_RATE_LIMITED':
        return { ...typed, limited: true };
      default:
        return { ...typed, notice: notSaved('auth.organization_create_failed') };
    }
  },
);
