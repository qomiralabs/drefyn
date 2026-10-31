import type { Result } from '@drefyn/address';
import { AuthError } from './errors.ts';

// The same pattern as the database check on organization_slugs, so the code refuses first
// and the constraint is the backstop.
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Words a slug may never take: the dashboard routes beside /<slug>, names a person could
// mistake for us, and words a future route is likely to want.
export const RESERVED_SLUGS: readonly string[] = Object.freeze([
  'about',
  'account',
  'accounts',
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'blog',
  'cli',
  'contact',
  'dashboard',
  'docs',
  'drefyn',
  'email',
  'favicon',
  'health',
  'help',
  'icon',
  'invite',
  'invites',
  'legal',
  'login',
  'logout',
  'mail',
  'new',
  'null',
  'oauth',
  'onboarding',
  'org',
  'orgs',
  'organizations',
  'pricing',
  'privacy',
  'projects',
  'robots',
  'root',
  'security',
  'settings',
  'sign-in',
  'sign-out',
  'sign-up',
  'signin',
  'signout',
  'signup',
  'sitemap',
  'static',
  'status',
  'studio',
  'support',
  'system',
  'terms',
  'undefined',
  'www',
]);

const RESERVED: ReadonlySet<string> = new Set(RESERVED_SLUGS);
const NAME_MAX = 100;

// Names go into invitation mail. A mail client turns a domain into a link, so a name that
// reads as one would let anyone send our mail pointing at their site.
const SCHEME = '://';
const WWW = 'www.';
// Separators IDNA and browsers treat as a dot, after NFKC has folded the full width forms.
const DOTS = /[。．｡]/g;
// Anything but a space or another dot before it: linkifiers take underscores, hyphens and
// marks in a label, and checking for letters only let those through.
const DOMAIN_LIKE = /[^\s.]\.\p{L}{2,}/u;
// Combining marks are dropped for the check only, so a mark inside the top level label (or
// the one the dotted capital I leaves after lowercasing) cannot split it.
const MARKS = /\p{M}/gu;
// Control, format (zero width and bidi), line and paragraph separators, and private use.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;

const ok = <T>(value: T): Result<T, AuthError> => ({ ok: true, value });
const refuse = <T>(code: 'AUTH_SLUG_INVALID' | 'AUTH_INPUT_INVALID'): Result<T, AuthError> => ({
  ok: false,
  error: new AuthError(code),
});

// Taken exactly as typed: a slug that needs changing to fit is refused, so the URL a person
// sees after creation is the one they chose.
export function parseSlug(value: unknown): Result<string, AuthError> {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value) || RESERVED.has(value)) {
    return refuse('AUTH_SLUG_INVALID');
  }
  return ok(value);
}

export function isSlugShape(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

// The name is checked in the form it is stored: NFKC, then trimmed. Checking a different
// form from the one stored would let a full width domain through.
export function parseOrganizationName(value: unknown): Result<string, AuthError> {
  if (typeof value !== 'string' || !value.isWellFormed()) return refuse('AUTH_INPUT_INVALID');
  const name = value.normalize('NFKC').trim();
  const length = Array.from(name).length;
  if (length === 0 || length > NAME_MAX || HIDDEN.test(name)) return refuse('AUTH_INPUT_INVALID');
  const folded = name.replace(DOTS, '.').toLowerCase().replace(MARKS, '');
  if (folded.includes(SCHEME) || folded.includes(WWW) || DOMAIN_LIKE.test(folded)) {
    return refuse('AUTH_INPUT_INVALID');
  }
  return ok(name);
}
