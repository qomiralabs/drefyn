// Every page route in src/app, by its folder path. Shell routes are in the Lighthouse run with
// the paths that draw them. Anything else says why it is not, so a new page has to pick a side.
export const SHELL_ROUTES: Readonly<Record<string, readonly string[]>> = {
  '/[org]': ['/acme'],
  '/[org]/[product]': ['/acme/docs'],
  '/[org]/[product]/[project]': ['/acme/docs/payments-api', '/acme/docs/new-docs'],
  '/[org]/[product]/[project]/[section]': ['/acme/docs/payments-api/changes'],
  '/[org]/settings': ['/acme/settings'],
  '/[org]/settings/[page]': ['/acme/settings/plan'],
  '/[org]/settings/api-keys': ['/acme/settings/api-keys'],
  '/[org]/settings/members': ['/acme/settings/members'],
  '/account': ['/account'],
  '/account/sessions': ['/account/sessions'],
  '/account/sign-in': ['/account/sign-in'],
  // The states no product feeds yet: answer, error, loading and the Pages grid.
  '/shell-states/[product]/[project]/[[...section]]': [
    '/shell-states/docs/payments-api',
    '/shell-states/docs/unreachable',
    '/shell-states/docs/pending',
    '/shell-states/docs/payments-api/pages',
  ],
};

const SIGNED_OUT_PAGE = 'no shell: a page for someone without a session';
const NO_SHELL = 'no shell: a step on the way into one';
const GALLERY = 'a gallery of states for the visual and axe jobs, on routes run above';

export const NOT_SHELL_ROUTES: Readonly<Record<string, string>> = {
  '/': 'no shell: redirects to an organization',
  '/auth-states/[screen]/[state]': GALLERY,
  '/bundle-baseline': 'the framework baseline for the bundle job, drawn empty on purpose',
  '/invite': SIGNED_OUT_PAGE,
  '/invite/block': SIGNED_OUT_PAGE,
  '/organizations/new': NO_SHELL,
  '/settings-states/[screen]/[state]': GALLERY,
  '/sign-in': SIGNED_OUT_PAGE,
  '/sign-in/cli': SIGNED_OUT_PAGE,
  '/sign-in/link': SIGNED_OUT_PAGE,
  '/sign-in/password': SIGNED_OUT_PAGE,
  '/sign-in/reset': SIGNED_OUT_PAGE,
  '/sign-in/verify': SIGNED_OUT_PAGE,
  '/sign-up': SIGNED_OUT_PAGE,
  '/welcome': NO_SHELL,
};

// A path against a route pattern, so a listed path cannot quietly draw some other route.
export function pathMatchesRoute(path: string, route: string): boolean {
  const pattern = route
    .split('/')
    .map((part) => {
      if (part.startsWith('[[...')) return '__OPTIONAL__';
      return part.startsWith('[') ? '[^/]+' : part;
    })
    .join('/')
    .replace('/__OPTIONAL__', '(?:/.+)?');
  return new RegExp(`^${pattern}$`).test(path);
}
