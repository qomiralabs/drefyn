import type { AuthConfig, AuthError } from '@drefyn/auth';

export type Provider = 'github' | 'google';
export type ProviderName = 'GitHub' | 'Google';

// What a page may say at the top of its form. Every failure ends up as one of these, so no
// raw code or server message can reach a person.
export type FormNotice =
  | { readonly kind: 'unavailable'; readonly reference: string }
  | { readonly kind: 'not_saved'; readonly reference: string }
  | { readonly kind: 'name_not_saved'; readonly reference: string }
  | { readonly kind: 'limited'; readonly minutes: number }
  | { readonly kind: 'day_limit' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'botcheck_down' }
  | { readonly kind: 'oauth_error'; readonly provider: ProviderName }
  | { readonly kind: 'oauth_unverified'; readonly provider: ProviderName }
  | { readonly kind: 'oauth_closed'; readonly provider: ProviderName };

export const PROVIDER_NAMES: Readonly<Record<Provider, ProviderName>> = {
  github: 'GitHub',
  google: 'Google',
};

const SECONDS_PER_MINUTE = 60;

export function minutesLeft(seconds: number | undefined): number {
  return Math.max(1, Math.ceil((seconds ?? 0) / SECONDS_PER_MINUTE));
}

export function noticeFor(
  error: Pick<AuthError, 'code' | 'retryAfterSeconds'>,
  reference: string,
): FormNotice {
  if (error.code === 'AUTH_RATE_LIMITED') {
    return { kind: 'limited', minutes: minutesLeft(error.retryAfterSeconds) };
  }
  if (error.code === 'AUTH_BOT_CHECK_REQUIRED') return { kind: 'botcheck_down' };
  return { kind: 'unavailable', reference };
}

export function refusalNotice(
  refusal: { readonly ok: false; readonly status?: number; readonly code: string },
  reference: string,
): FormNotice {
  return refusal.code === 'auth.challenge_binding'
    ? { kind: 'expired' }
    : { kind: 'unavailable', reference };
}

const OAUTH_NOTICES = {
  provider: 'oauth_error',
  state: 'oauth_error',
  unverified: 'oauth_unverified',
  closed: 'oauth_closed',
} as const;

const isProvider = (value: unknown): value is Provider => value === 'github' || value === 'google';
const isOAuthError = (value: unknown): value is keyof typeof OAUTH_NOTICES =>
  typeof value === 'string' && Object.hasOwn(OAUTH_NOTICES, value);

// From the query of a redirect, so only exact known values show anything: a crafted link can
// pick one of our sentences and can never put its own words on the page.
export function oauthNotice(error: unknown, provider: unknown): FormNotice | null {
  if (!isOAuthError(error) || !isProvider(provider)) return null;
  return { kind: OAUTH_NOTICES[error], provider: PROVIDER_NAMES[provider] };
}

export interface SignInMethods {
  readonly email: boolean;
  readonly password: boolean;
  readonly providers: readonly Provider[];
  // False when nobody could get in, since a password needs a first sign in by other means.
  readonly setUp: boolean;
}

type MethodConfig = Pick<AuthConfig, 'email'> & {
  readonly oauth: { readonly github: unknown; readonly google: unknown };
  readonly passwords: { readonly enabled: boolean };
};

export function signInMethods(config: MethodConfig, mailConfigured: boolean): SignInMethods {
  const email = mailConfigured && config.email !== 'off';
  const providers = (['github', 'google'] as const).filter((p) => config.oauth[p] !== null);
  return {
    email,
    password: config.passwords.enabled,
    providers,
    setUp: email || providers.length > 0,
  };
}

// A wrapper refusal arrives as the action's value, in place of the form's own state.
export function isRefusal(value: unknown): value is { readonly ok: false; readonly code: string } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}
