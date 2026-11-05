import { isLinkShaped, type Result } from '@drefyn/address';
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
  'auth-states',
  'billing',
  'blog',
  'bundle-baseline',
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
  'settings-states',
  'shell-states',
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
  'welcome',
  'www',
]);

const RESERVED: ReadonlySet<string> = new Set(RESERVED_SLUGS);
const NAME_MAX = 100;

const MARKS = /\p{M}/gu;
// Control, format (zero width and bidi), line and paragraph separators, and private use.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;

const ok = <T>(value: T): Result<T, AuthError> => ({ ok: true, value });
const refuse = <T>(code: 'AUTH_SLUG_INVALID' | 'AUTH_INPUT_INVALID'): Result<T, AuthError> => ({
  ok: false,
  error: new AuthError(code),
});

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
  // Names go into mail, and a client turns a domain into a link, so a name that reads as one
  // would let anyone send our mail pointing at their site.
  if (isLinkShaped(name)) return refuse('AUTH_INPUT_INVALID');
  return ok(name);
}

const NOT_SLUG = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const SLUG_MAX = 40;
// Letters with no decomposed form, so stripping marks would turn them into hyphens.
const UNMARKED = /[æœøßłđðþı]/g;
const UNMARKED_LETTERS: Readonly<Record<string, string>> = {
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

// The URL name an organization name gives. Accents fold to their base letter, anything else
// becomes a hyphen. Null when nothing usable is left; the slug rule still runs on the result.
export function slugFromOrganizationName(name: string): string | null {
  const folded = name
    .normalize('NFKD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(UNMARKED, (letter) => UNMARKED_LETTERS[letter] ?? letter);
  const slug = folded
    .replace(NOT_SLUG, '-')
    .replace(EDGE_HYPHENS, '')
    .slice(0, SLUG_MAX)
    .replace(EDGE_HYPHENS, '');
  return slug === '' ? null : slug;
}

// No vowels, so a suffix cannot spell a word, and none of l, 0 or 1, so it reads back cleanly.
export const SLUG_SUFFIX_ALPHABET = 'bcdfghjkmnpqrstvwxz23456789';
export const SLUG_SUFFIX_LENGTH = 4;
// Reserved itself, so it can only appear with a suffix.
const FALLBACK_STEM = 'org';

// The slug to try for a name: the plain one first when it is allowed, then the name with a
// suffix. A name with no usable slug skips straight to the suffix, so every name can be saved.
export function slugCandidate(name: string, suffix: string, attempt: number): string {
  const plain = slugFromOrganizationName(name);
  if (attempt === 0 && plain !== null && parseSlug(plain).ok) return plain;
  const room = SLUG_MAX - suffix.length - 1;
  const stem = (plain ?? FALLBACK_STEM).slice(0, room).replace(EDGE_HYPHENS, '');
  return `${stem}-${suffix}`;
}
