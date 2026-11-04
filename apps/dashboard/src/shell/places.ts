import { allowed, defineCommands, type Command } from './commands.ts';

// Places the shell knows without asking a server, so they work even when search is down.
export function places(org: string): readonly Command[] {
  const at = (path: string) => `/${org}${path}`;
  return defineCommands([
    {
      id: 'overview',
      icon: 'home',
      name: 'Overview',
      kind: 'organization',
      href: at(''),
      permission: 'org.read',
      shortcut: 'G O',
    },
    {
      id: 'docs',
      icon: 'page',
      name: 'Docs',
      kind: 'product',
      href: at('/docs'),
      permission: 'docs.read',
      shortcut: 'G 1',
    },
    {
      id: 'studio',
      icon: 'schema',
      name: 'Studio',
      kind: 'product',
      href: at('/studio'),
      permission: 'studio.read',
      shortcut: 'G 2',
    },
    {
      id: 'status',
      icon: 'pulse',
      name: 'Status',
      kind: 'product',
      href: at('/status'),
      permission: 'status.read',
      shortcut: 'G 3',
    },
    {
      id: 'payments-api',
      icon: 'page',
      state: { state: 'stale', word: 'Out of date' },
      name: 'Payments API docs',
      kind: 'Docs project',
      href: at('/docs/payments-api'),
      permission: 'docs.read',
    },
    {
      id: 'pages',
      icon: 'page',
      name: 'Pages in Payments API docs',
      kind: 'Docs section',
      keywords: ['pages'],
      href: at('/docs/payments-api/pages'),
      permission: 'docs.read',
    },
    {
      id: 'acme-status',
      icon: 'pulse',
      state: { state: 'fresh', word: 'Running' },
      name: 'Acme status',
      kind: 'status page',
      href: at('/status/acme-status'),
      permission: 'status.read',
    },
    {
      id: 'plan',
      icon: 'card',
      name: 'Plan and usage',
      kind: 'organization',
      keywords: ['billing', 'limits'],
      href: at('/settings/plan'),
      permission: 'org.read',
    },
    {
      id: 'members',
      icon: 'users',
      name: 'Members',
      kind: 'organization',
      keywords: ['seats', 'invite'],
      href: at('/settings/members'),
      permission: 'org.read',
    },
    {
      id: 'api-keys',
      icon: 'key',
      name: 'API keys',
      kind: 'organization',
      keywords: ['tokens', 'ci'],
      href: at('/settings/api-keys'),
      permission: 'org.read',
    },
    {
      id: 'settings',
      icon: 'settings',
      name: 'Organization settings',
      kind: 'organization',
      href: at('/settings'),
      permission: 'org.read',
    },
    {
      id: 'account',
      icon: 'person',
      name: 'Profile and email',
      kind: 'your account',
      href: '/account',
      permission: 'org.read',
    },
    {
      id: 'sign-in-methods',
      icon: 'lock',
      name: 'Sign in methods',
      kind: 'your account',
      keywords: ['password', 'github', 'google'],
      href: '/account/sign-in',
      permission: 'org.read',
    },
    {
      id: 'sessions',
      icon: 'laptop',
      name: 'Sessions',
      kind: 'your account',
      keywords: ['sign out', 'browsers'],
      href: '/account/sessions',
      permission: 'org.read',
    },
  ]);
}

// What the bar offers this person. It only hides: the server refuses the rest on its own.
export function visiblePlaces(org: string, permissions: readonly string[]): readonly Command[] {
  const held = new Set(permissions);
  return allowed(places(org), (permission) => held.has(permission));
}
