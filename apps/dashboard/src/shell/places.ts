import { defineCommands, type Command } from './commands.ts';

// Places the shell knows without asking a server, so they work even when search is down.
export function places(org: string): readonly Command[] {
  const at = (path: string) => `/${org}${path}`;
  return defineCommands([
    {
      id: 'overview',
      name: 'Overview',
      kind: 'organization',
      href: at(''),
      permission: 'org.read',
      shortcut: 'G O',
    },
    {
      id: 'docs',
      name: 'Docs',
      kind: 'product',
      href: at('/docs'),
      permission: 'docs.read',
      shortcut: 'G 1',
    },
    {
      id: 'studio',
      name: 'Studio',
      kind: 'product',
      href: at('/studio'),
      permission: 'studio.read',
      shortcut: 'G 2',
    },
    {
      id: 'status',
      name: 'Status',
      kind: 'product',
      href: at('/status'),
      permission: 'status.read',
      shortcut: 'G 3',
    },
    {
      id: 'payments-api',
      name: 'Payments API docs',
      kind: 'Docs project',
      href: at('/docs/payments-api'),
      permission: 'docs.read',
    },
    {
      id: 'pages',
      name: 'Pages in Payments API docs',
      kind: 'Docs section',
      keywords: ['pages'],
      href: at('/docs/payments-api/pages'),
      permission: 'docs.read',
    },
    {
      id: 'acme-status',
      name: 'Acme status',
      kind: 'status page',
      href: at('/status/acme-status'),
      permission: 'status.read',
    },
    {
      id: 'plan',
      name: 'Plan and usage',
      kind: 'organization',
      keywords: ['billing', 'limits'],
      href: at('/settings/plan'),
      permission: 'org.read',
    },
    {
      id: 'members',
      name: 'Members',
      kind: 'organization',
      keywords: ['seats', 'invite'],
      href: at('/settings/members'),
      permission: 'org.read',
    },
    {
      id: 'settings',
      name: 'Organization settings',
      kind: 'organization',
      href: at('/settings'),
      permission: 'org.read',
    },
  ]);
}
