// Where the mint route may send a browser back to: the signed out pages, and nothing else.
// Anything it cannot place goes to sign in, so the route can never be an open redirect.
const PAGES: ReadonlySet<string> = new Set([
  '/sign-in',
  '/sign-up',
  '/sign-in/verify',
  '/sign-in/password',
  '/sign-in/reset',
  '/sign-in/link',
  '/sign-in/cli',
  '/invite',
  '/invite/block',
]);

const FALLBACK = '/sign-in';
const PLAIN = /^[A-Za-z0-9/_.%&=?-]+$/;

export function preTarget(to: string | null | undefined): string {
  if (typeof to !== 'string' || !PLAIN.test(to) || to.includes('..')) return FALLBACK;
  const [path] = to.split('?');
  return path !== undefined && PAGES.has(path) ? to : FALLBACK;
}

export const preRedirect = (path: string): string => `/auth/pre?to=${encodeURIComponent(path)}`;
