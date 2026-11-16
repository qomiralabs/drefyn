export type OAuthProvider = 'github' | 'google';
// What a sign in code or a notice can name as linked: a provider, or an organization's SSO.
export type LinkProvider = OAuthProvider | 'sso';
export type OAuthPurpose = 'sign_in' | 'link' | 'step_up';

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = Object.freeze(['github', 'google']);
const PURPOSES: ReadonlySet<unknown> = new Set(['sign_in', 'link', 'step_up']);

export const parseOAuthProvider = (value: unknown): OAuthProvider | null =>
  value === 'github' || value === 'google' ? value : null;

export const parseOAuthPurpose = (value: unknown): OAuthPurpose | null =>
  PURPOSES.has(value) ? (value as OAuthPurpose) : null;
